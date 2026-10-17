import { afterEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OPENAI_IMAGE_MODELS } from "@codelia/config";
import {
	Agent,
	type BaseChatModel,
	type BaseMessage,
	type ChatInvokeInput,
	type SessionRecord,
} from "@codelia/core";
import { ImageArtifactStore } from "@codelia/storage";
import { generateImage } from "../src/image-generation/adapter";
import { ImageCatalog } from "../src/image-generation/catalog";
import { exportImageBytes } from "../src/image-generation/export";
import { type ImageFetch, imageJson } from "../src/image-generation/http";
import { validateImageReference } from "../src/image-generation/references";
import {
	type ImageAuthSource,
	type ImageRoute,
	resolveImageRoute,
} from "../src/image-generation/route";
import { createImageTools } from "../src/image-generation/tools";
import { createToolContext } from "../src/rpc/tool";

const png64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=";
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function store() {
	const root = await mkdtemp(path.join(os.tmpdir(), "codelia-generation-"));
	roots.push(root);
	return new ImageArtifactStore(root);
}
const auth: ImageAuthSource = {
	storedKey: async () => "stored-test-key",
	env: (name) =>
		name === "IMAGE_TEST_KEY" ? "explicit-test-key" : "standard-test-key",
};
const custom = {
	mode: "custom",
	provider: "openai",
	model: OPENAI_IMAGE_MODELS[0],
} as const;
const route: ImageRoute = {
	authMode: "api_key",
	provider: "openai",
	model: OPENAI_IMAGE_MODELS[0],
	apiKey: "fixture-key",
	endpoint: "https://api.openai.com/v1/images/generations",
	options: { quality: "low", size: "1024x1024" },
};
const response = () =>
	Response.json({
		data: [{ b64_json: png64 }],
		usage: { input_tokens: 10, output_tokens: 20 },
	});

test("exclusive custom key precedence, off without auth lookup, and builtin OAuth never crosses into API billing", async () => {
	expect(
		(
			await resolveImageRoute(
				{ ...custom, api_key_env: "IMAGE_TEST_KEY" },
				auth,
			)
		)?.apiKey,
	).toBe("explicit-test-key");
	expect((await resolveImageRoute(custom, auth))?.apiKey).toBe(
		"stored-test-key",
	);
	expect(
		(
			await resolveImageRoute(custom, {
				...auth,
				storedKey: async () => undefined,
			})
		)?.apiKey,
	).toBe("standard-test-key");
	await expect(
		resolveImageRoute(
			{ ...custom, api_key_env: "MISSING" },
			{ ...auth, env: () => undefined },
		),
	).rejects.toThrow("missing_api_key");
	expect(
		await resolveImageRoute(
			{ mode: "off" },
			{
				storedKey: async () => {
					throw Error("must not read");
				},
				env: () => {
					throw Error("must not read");
				},
			},
		),
	).toBeNull();
	await expect(
		resolveImageRoute({ mode: "builtin" }, auth, {
			provider: "openai",
			auth: {
				method: "oauth",
				oauth: {
					access_token: "oauth-fixture",
					refresh_token: "refresh-fixture",
					expires_at: 1,
				},
			},
		}),
	).resolves.toMatchObject({
		authMode: "codex_oauth",
		model: "gpt-image-2",
		endpoint: "https://chatgpt.com/backend-api/codex/images/generations",
	});
	expect(
		(
			await resolveImageRoute(
				{
					mode: "builtin",
					provider_options: { openai: { model: OPENAI_IMAGE_MODELS[1] } },
				},
				{ ...auth, env: () => undefined },
				{
					provider: "openai",
					auth: { method: "api_key", api_key: "chat-key" },
				},
			)
		)?.apiKey,
	).toBe("chat-key");
});

test("real tool -> HTTP adapter -> immutable store -> reference history -> next model request -> disk resume", async () => {
	const s = await store();
	const calls: ChatInvokeInput[] = [];
	const wire: { url: string; init?: RequestInit }[] = [];
	let permissionCount = 0;
	const fetcher: ImageFetch = async (url, init) => {
		wire.push({ url, init });
		return response();
	};
	const tools = createImageTools({
		store: s,
		route,
		authorize: () => {
			permissionCount++;
			return { decision: "allow" };
		},
		fetcher,
	});
	const records: SessionRecord[] = [];
	const llm: BaseChatModel = {
		provider: "openai",
		model: "fixture-chat",
		ainvoke: async (input) => {
			calls.push(input);
			return calls.length === 1
				? {
						messages: [
							{
								role: "assistant",
								content: null,
								tool_calls: [
									{
										id: "generate-1",
										type: "function",
										function: {
											name: "image_generate",
											arguments: JSON.stringify({
												prompt: "Draw a red square",
											}),
										},
									},
								],
							},
						],
					}
				: {
						messages: [
							{ role: "assistant", content: "Generated and inspected." },
						],
					};
		},
	};
	const agent = new Agent({
		llm,
		tools,
		services: { resolveImage: s.resolve.bind(s) },
		compaction: { enabled: false },
	});
	expect(
		await agent.run("Create an image", {
			session: {
				run_id: "run",
				session_id: "session",
				append: (r) => {
					records.push(r);
				},
			},
		}),
	).toBe("Generated and inspected.");
	expect(permissionCount).toBe(1);
	expect(wire).toHaveLength(1);
	expect(wire[0]?.url).toBe(route.endpoint);
	expect(wire[0]?.init?.redirect).toBe("error");
	expect(JSON.parse(String(wire[0]?.init?.body))).toMatchObject({
		model: route.model,
		n: 1,
		output_format: "png",
		quality: "low",
	});
	expect(JSON.stringify(calls[1]?.messages)).toContain(
		`data:image/png;base64,${png64}`,
	);
	expect(JSON.stringify(agent.getHistoryMessages())).toContain(
		'"type":"image_ref"',
	);
	expect(JSON.stringify(agent.getHistoryMessages())).not.toContain(png64);
	expect(JSON.stringify(records)).not.toContain(png64);
	expect(JSON.stringify(records)).not.toContain("fixture-key");
	const snapshot = path.join(s.root, "history.json");
	await writeFile(snapshot, JSON.stringify(agent.getHistoryMessages()));
	const restored: BaseMessage[] = JSON.parse(await readFile(snapshot, "utf8"));
	const next = new Agent({
		llm,
		tools,
		services: {
			resolveImage: new ImageArtifactStore(s.root).resolve.bind(
				new ImageArtifactStore(s.root),
			),
		},
		compaction: { enabled: false },
	});
	next.replaceHistoryMessages(restored);
	await next.run("Inspect again");
	expect(JSON.stringify(calls.at(-1)?.messages)).toContain(png64);
});

test("direct tool calls cannot bypass permission; provider refusal creates no successful result", async () => {
	const s = await store();
	let count = 0;
	const tool = createImageTools({
		store: s,
		route,
		authorize: () => ({ decision: "deny", reason: "not approved" }),
		fetcher: async () => {
			count++;
			return response();
		},
	}).find((t) => t.name === "image_generate");
	await expect(
		tool?.executeRaw('{"prompt":"draw"}', createToolContext()),
	).rejects.toThrow();
	expect(count).toBe(0);
	const failing = createImageTools({
		store: s,
		route,
		authorize: () => ({ decision: "allow" }),
		fetcher: async () =>
			Response.json(
				{ error: { message: "private-provider-secret" } },
				{ status: 401 },
			),
	}).find((t) => t.name === "image_generate");
	await expect(
		failing?.executeRaw('{"prompt":"draw"}', createToolContext()),
	).rejects.toThrow("HTTP 401");
});

test("editing transmits original bytes in multipart and retains exact image model", async () => {
	let form: FormData | undefined;
	await generateImage(
		route,
		"make it blue",
		[validateImageReference(Buffer.from(png64, "base64"))],
		undefined,
		async (url, init) => {
			expect(url).toBe("https://api.openai.com/v1/images/edits");
			expect(init?.body).toBeInstanceOf(FormData);
			form = init?.body as FormData;
			return response();
		},
	);
	expect(form?.get("model")).toBe(route.model);
	const image = form?.get("image[]");
	expect(image).toBeInstanceOf(Blob);
	if (image instanceof Blob)
		expect(Buffer.from(await image.arrayBuffer())).toEqual(
			Buffer.from(png64, "base64"),
		);
});

const endpoint = {
	provider_tag: "pinned",
	supported_parameters: {
		output_format: { type: "enum", values: ["png"] },
		quality: { type: "enum", values: ["low"] },
		input_references: { type: "range", min: 0, max: 2 },
	},
};
test("OpenRouter verifies endpoint-specific options, pins endpoint, and never retries paid calls", async () => {
	const urls: string[] = [];
	const r: ImageRoute = {
		...route,
		provider: "openrouter",
		model: "owner/image",
		endpoint: "pinned",
		options: { quality: "low" },
	};
	const fetcher: ImageFetch = async (url, init) => {
		urls.push(url);
		if (url.endsWith("/endpoints"))
			return Response.json({ endpoints: [endpoint] });
		expect(JSON.parse(String(init?.body)).provider).toEqual({
			only: ["pinned"],
			allow_fallbacks: false,
		});
		return response();
	};
	await generateImage(r, "draw", [], undefined, fetcher);
	expect(urls).toHaveLength(2);
	urls.length = 0;
	await expect(
		generateImage(
			{ ...r, options: { quality: "high" } },
			"draw",
			[],
			undefined,
			fetcher,
		),
	).rejects.toThrow("quality");
	expect(urls).toHaveLength(1);
	await expect(
		generateImage(
			{ ...r, endpoint: "different" },
			"draw",
			[],
			undefined,
			fetcher,
		),
	).rejects.toThrow("unavailable");
});

test("discovery only lists image output and caches metadata without paid requests", async () => {
	let count = 0;
	const catalog = new ImageCatalog(async (url) => {
		count++;
		expect(url).toEndWith("/images/models");
		return Response.json({
			data: [
				{
					id: "owner/image",
					name: "Image",
					architecture: { output_modalities: ["image"] },
				},
				{
					id: "owner/text",
					name: "Text",
					architecture: { output_modalities: ["text"] },
				},
			],
		});
	});
	expect((await catalog.list()).models).toEqual([
		{ id: "owner/image", name: "Image" },
	]);
	await catalog.list();
	expect(count).toBe(1);
});

test("HTTP response bounds, cancellation, malformed data, and safe transport errors", async () => {
	await expect(
		imageJson(
			"https://api.openai.com/v1/images/generations",
			{},
			async () => new Response("a".repeat(30)),
			10,
		),
	).rejects.toThrow("size limit");
	await expect(
		imageJson("https://api.openai.com/v1/images/generations", {}, async () => {
			throw new Error("secret-key-and-body");
		}),
	).rejects.toThrow("transport");
	await expect(
		generateImage(route, "draw", [], undefined, async () =>
			Response.json({ data: [{ url: "https://untrusted/image" }] }),
		),
	).rejects.toThrow("no complete");
	const controller = new AbortController();
	controller.abort();
	let called = false;
	await expect(
		generateImage(route, "draw", [], controller.signal, async () => {
			called = true;
			return response();
		}),
	).rejects.toThrow();
	expect(called).toBe(false);
});

test("OpenRouter omits unadvertised format, uses original references and never adds fallback", async () => {
	let paidCalls = 0;
	await generateImage(
		{
			...route,
			provider: "openrouter",
			model: "owner/image",
			endpoint: "pinned",
			options: {},
		},
		"edit",
		[validateImageReference(Buffer.from(png64, "base64"))],
		undefined,
		async (url, init) => {
			if (url.endsWith("/endpoints"))
				return Response.json({
					endpoints: [
						{
							provider_tag: "pinned",
							supported_parameters: {
								input_references: { type: "range", min: 0, max: 2 },
							},
						},
					],
				});
			paidCalls++;
			const body = JSON.parse(String(init?.body));
			expect(body.output_format).toBeUndefined();
			expect(body.n).toBeUndefined();
			expect(body.provider).toEqual({
				only: ["pinned"],
				allow_fallbacks: false,
			});
			expect(body.input_references[0].image_url.url).toBe(
				`data:image/png;base64,${png64}`,
			);
			return response();
		},
	);
	expect(paidCalls).toBe(1);
});

test("stalled response readers terminate on timeout and caller cancellation", async () => {
	let cancelled = 0;
	const fetcher: ImageFetch = async () =>
		new Response(
			new ReadableStream({
				cancel() {
					cancelled++;
				},
			}),
		);
	await expect(
		imageJson(route.endpoint, {}, fetcher, 1024, 20),
	).rejects.toThrow("timed out");
	const controller = new AbortController();
	const request = imageJson(
		route.endpoint,
		{ signal: controller.signal },
		fetcher,
	);
	setTimeout(() => controller.abort(), 20);
	await expect(request).rejects.toThrow("cancelled");
	expect(cancelled).toBe(2);
});

test("OpenRouter rejects endpoints requiring multiple images before a paid call", async () => {
	let calls = 0;
	await expect(
		generateImage(
			{
				...route,
				provider: "openrouter",
				model: "owner/image",
				endpoint: "pinned",
				options: {},
			},
			"draw",
			[],
			undefined,
			async (url) => {
				calls++;
				expect(url).toEndWith("/endpoints");
				return Response.json({
					endpoints: [
						{
							provider_tag: "pinned",
							supported_parameters: { n: { type: "range", min: 2, max: 4 } },
						},
					],
				});
			},
		),
	).rejects.toThrow("single image");
	expect(calls).toBe(1);
});

test("image export is permission-gated, immutable, and bounded to real workspace directories", async () => {
	const s = await store();
	const outside = await store();
	const bytes = Buffer.from(png64, "base64");
	const m = await s.save(bytes, {
		provider: route.provider,
		requested_model: route.model,
		endpoint: route.endpoint,
		parent_artifact_ids: [],
	});
	const exportImage = (p: string, b: Buffer) => exportImageBytes(s.root, p, b);
	const denied = createImageTools({
		store: s,
		route: null,
		authorize: () => ({ decision: "deny" }),
		exportImage,
	}).find((t) => t.name === "image_export");
	const args = JSON.stringify({
		artifact_id: m.artifact_id,
		output_path: "result.png",
	});
	await expect(denied?.executeRaw(args, createToolContext())).rejects.toThrow();
	const allowed = createImageTools({
		store: s,
		route: null,
		authorize: () => ({ decision: "allow" }),
		exportImage,
	}).find((t) => t.name === "image_export");
	await allowed?.executeRaw(args, createToolContext());
	expect(await readFile(path.join(s.root, "result.png"))).toEqual(bytes);
	await expect(exportImage("result.png", bytes)).rejects.toThrow("new file");
	await expect(
		exportImage(path.join(outside.root, "escape.png"), bytes),
	).rejects.toThrow();
	await symlink(outside.root, path.join(s.root, "escape"));
	await expect(exportImage("escape/result.png", bytes)).rejects.toThrow();
	await mkdir(path.join(s.root, "..valid"));
	await exportImage("..valid/result.png", bytes);
	expect((await s.read(m.artifact_id)).bytes).toEqual(bytes);
});

test("model-view preparation failure preserves the charged saved original without another generation", async () => {
	const s = await store();
	s.modelReference = async () => {
		throw Error("view encoder unavailable");
	};
	let paid = 0;
	const generate = createImageTools({
		store: s,
		route,
		authorize: () => ({ decision: "allow" }),
		fetcher: async () => {
			paid++;
			return response();
		},
	}).find((t) => t.name === "image_generate");
	if (!generate) throw Error("missing generation tool");
	const result = await generate.executeRaw(
		JSON.stringify({ prompt: "red square" }),
		createToolContext(),
	);
	expect(paid).toBe(1);
	expect(JSON.stringify(result)).toContain(
		"Generation succeeded and the original is saved",
	);
	const id = /codelia-image-[a-f0-9-]{36}/.exec(JSON.stringify(result))?.[0];
	if (!id) throw Error("missing saved artifact id");
	expect((await s.read(id)).bytes.toString("base64")).toBe(png64);
});
