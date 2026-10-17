import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent, type ChatInvokeInput } from "@codelia/core";
import { ImageArtifactStore } from "@codelia/storage";
import { generateImage } from "../src/image-generation/adapter";
import { validateImageReference } from "../src/image-generation/references";
import {
	type ImageAuthSource,
	type ImageChatConnection,
	resolveImageRoute,
} from "../src/image-generation/route";
import { createImageTools } from "../src/image-generation/tools";

const png64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=";
const publicAuth: ImageAuthSource = {
	storedKey: async () => {
		throw new Error("OAuth must not read API keys");
	},
	env: () => {
		throw new Error("OAuth must not read environment key/base URL overrides");
	},
};
const chat: ImageChatConnection = {
	provider: "openai",
	auth: {
		method: "oauth",
		oauth: {
			access_token: "old-oauth-fixture",
			refresh_token: "refresh-fixture",
			account_id: "account-fixture",
			expires_at: 1,
		},
	},
	getOpenAiAccessToken: async () => ({
		token: "current-oauth-fixture",
		accountId: "account-fixture",
	}),
};
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function oauthRoute(connection = chat, model?: string) {
	const route = await resolveImageRoute(
		{
			mode: "builtin",
			...(model ? { provider_options: { openai: { model } } } : {}),
		},
		publicAuth,
		connection,
	);
	if (!route || route.authMode !== "codex_oauth")
		throw new Error("Expected Codex OAuth route");
	return route;
}

test("builtin OAuth uses fresh bearer/account auth and exact Codex JSON generation/edit endpoints, never public API or multipart", async () => {
	let refreshes = 0;
	const route = await oauthRoute({
		...chat,
		getOpenAiAccessToken: async () => {
			refreshes++;
			return { token: `fresh-${refreshes}`, accountId: "account-fixture" };
		},
	});
	expect(route.model).toBe("gpt-image-2");
	expect(route.apiKey).toBeUndefined();
	const calls: string[] = [];
	for (const references of [
		[],
		[validateImageReference(Buffer.from(png64, "base64"))],
	]) {
		const generated = await generateImage(
			route,
			"draw",
			references,
			undefined,
			async (url, init) => {
				calls.push(url);
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe(
					`Bearer fresh-${calls.length}`,
				);
				expect(headers.get("ChatGPT-Account-ID")).toBe("account-fixture");
				expect(headers.get("originator")).toBe("codelia");
				expect(headers.get("x-codex-image-turn-id")).toStartWith(
					"codelia-image-",
				);
				expect(init?.redirect).toBe("error");
				const body = JSON.parse(String(init?.body));
				expect(body).toMatchObject({ model: "gpt-image-2", prompt: "draw" });
				expect(body.output_format).toBeUndefined();
				expect(body.images).toEqual(
					references.length
						? [{ image_url: `data:image/png;base64,${png64}` }]
						: undefined,
				);
				return Response.json({ data: [{ b64_json: png64 }] });
			},
		);
		expect(generated.bytes).toEqual(Buffer.from(png64, "base64"));
		expect(generated.effective_model).toBeUndefined();
	}
	expect(calls).toEqual([
		"https://chatgpt.com/backend-api/codex/images/generations",
		"https://chatgpt.com/backend-api/codex/images/edits",
	]);
	expect(refreshes).toBe(2);
});

test("OAuth refresh/account failure and cancellation send no image request, and provider failures never switch auth or model", async () => {
	let requests = 0;
	const fetcher = async () => {
		requests++;
		return Response.json({ error: "private-account-details" }, { status: 403 });
	};
	for (const getOpenAiAccessToken of [
		async () => {
			throw new Error("private-refresh-token");
		},
		async () => ({ token: "another-token", accountId: "another-account" }),
	]) {
		await expect(
			generateImage(
				await oauthRoute({ ...chat, getOpenAiAccessToken }),
				"draw",
				[],
				undefined,
				fetcher,
			),
		).rejects.toThrow();
	}
	expect(requests).toBe(0);
	const controller = new AbortController();
	controller.abort();
	await expect(
		generateImage(await oauthRoute(), "draw", [], controller.signal, fetcher),
	).rejects.toThrow();
	expect(requests).toBe(0);
	await expect(
		generateImage(await oauthRoute(), "draw", [], undefined, fetcher),
	).rejects.toThrow("HTTP 403");
	expect(requests).toBe(1);
	await expect(
		generateImage(
			{
				...(await oauthRoute()),
				endpoint: "https://api.openai.com/v1/images/generations",
			},
			"draw",
			[],
			undefined,
			fetcher,
		),
	).rejects.toThrow("OAuth was not sent");
	expect(requests).toBe(1);
});

test("explicit OAuth image model is transmitted unchanged without claiming effective model, and tools materialize saved images into the next chat request", async () => {
	const route = await oauthRoute(chat, "gpt-image-2.5-sunburst");
	const root = await mkdtemp(path.join(os.tmpdir(), "codelia-codex-images-"));
	roots.push(root);
	const store = new ImageArtifactStore(root);
	let approvals = 0;
	const tools = createImageTools({
		store,
		route,
		authorize: () => {
			approvals++;
			return { decision: "allow" };
		},
		fetcher: async (url, init) => {
			expect(url).toStartWith("https://chatgpt.com/backend-api/codex/");
			expect(JSON.parse(String(init?.body)).model).toBe(
				"gpt-image-2.5-sunburst",
			);
			return Response.json({ data: [{ b64_json: png64 }] });
		},
	});
	const requests: ChatInvokeInput[] = [];
	const agent = new Agent({
		llm: {
			provider: "openai",
			model: "fixture",
			ainvoke: async (input) => {
				requests.push(input);
				return requests.length === 1
					? {
							messages: [
								{
									role: "assistant",
									content: null,
									tool_calls: [
										{
											id: "image",
											type: "function",
											function: {
												name: "image_generate",
												arguments: '{"prompt":"draw"}',
											},
										},
									],
								},
							],
						}
					: { messages: [{ role: "assistant", content: "Image inspected" }] };
			},
		},
		tools,
		services: { resolveImage: store.resolve.bind(store) },
		compaction: { enabled: false },
	});
	expect(await agent.run("Generate an image")).toBe("Image inspected");
	expect(approvals).toBe(1);
	expect(JSON.stringify(requests[1]?.messages)).toContain(
		`data:image/png;base64,${png64}`,
	);
	expect(JSON.stringify(agent.getHistoryMessages())).not.toContain(png64);
	expect(JSON.stringify(agent.getHistoryMessages())).not.toContain(
		"current-oauth-fixture",
	);
	expect(JSON.stringify(agent.getHistoryMessages())).toContain(
		"effective model: unknown",
	);
});
