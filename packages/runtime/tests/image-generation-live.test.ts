import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseImageGenerationConfig } from "@codelia/config";
import type { ToolResult } from "@codelia/core";
import { ImageArtifactStore } from "@codelia/storage";
import { AuthResolver } from "../src/auth/resolver";
import { AuthStore } from "../src/auth/store";
import type { ImageChatConnection } from "../src/image-generation/route";
import { resolveImageRoute } from "../src/image-generation/route";
import { createImageTools } from "../src/image-generation/tools";
import { createToolContext } from "../src/rpc/tool";
import { RuntimeState } from "../src/runtime-state";

async function verifyImageResult(
	result: ToolResult,
	store: ImageArtifactStore,
	model: string,
) {
	expect(result.type).toBe("parts");
	if (result.type !== "parts") throw new Error("Missing image result parts");
	const part = result.parts.find((p) => p.type === "image_ref");
	if (!part || part.type !== "image_ref")
		throw new Error("Missing saved artifact reference");
	const { metadata } = await store.read(part.image_ref.artifact_id);
	if (metadata.kind === "attachment")
		throw new Error("Expected generated provenance");
	expect(metadata.requested_model).toBe(model);
	expect((await store.resolve(part.image_ref)).image_url.url).toStartWith(
		"data:image/png;base64,",
	);
	return metadata;
}

test("live checker accepts the real normalized tool-result contract without network access", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "codelia-image-checker-"));
	try {
		const store = new ImageArtifactStore(root);
		const bytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=",
			"base64",
		);
		const metadata = await store.save(bytes, {
			provider: "openai",
			requested_model: "gpt-image-2",
			endpoint: "fixture",
			parent_artifact_ids: [],
		});
		const tool = createImageTools({
			store,
			route: null,
			authorize: () => ({ decision: "allow" }),
		}).find((t) => t.name === "image_inspect");
		if (!tool) throw new Error("Image inspect unavailable");
		await verifyImageResult(
			await tool.executeRaw(
				JSON.stringify({ artifact_id: metadata.artifact_id }),
				createToolContext(),
			),
			store,
			"gpt-image-2",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// A separate opt-in is required because this check sends exactly one paid request.
const enabled =
	process.env.INTEGRATION === "1" && process.env.CODELIA_IMAGE_LIVE === "1";
test.skipIf(!enabled)(
	"live selected image API -> immutable artifact -> model image input (chargeable)",
	async () => {
		const provider = process.env.CODELIA_IMAGE_PROVIDER ?? "openai";
		const model = process.env.CODELIA_IMAGE_MODEL;
		const endpoint = process.env.CODELIA_IMAGE_ENDPOINT;
		if (!model)
			throw new Error(
				"Set CODELIA_IMAGE_MODEL explicitly; no model or billing fallback is permitted.",
			);
		const config = parseImageGenerationConfig(
			provider === "codex"
				? {
						mode: "builtin",
						provider_options: { openai: { model } },
					}
				: {
						mode: "custom",
						provider,
						model,
						...(endpoint
							? { provider_options: { openrouter: { endpoint } } }
							: {}),
					},
		);
		let chat: ImageChatConnection | undefined;
		if (provider === "codex") {
			const auth = (await new AuthStore().load()).providers.openai;
			if (auth?.method !== "oauth")
				throw new Error(
					"Sign in to OpenAI with Codex OAuth before this test; no API-key fallback is allowed.",
				);
			const resolver = await AuthResolver.create(new RuntimeState(), () => {});
			chat = {
				provider: "openai",
				auth,
				getOpenAiAccessToken: resolver.getOpenAiAccessToken.bind(resolver),
			};
		}
		const route = await resolveImageRoute(
			config,
			{
				storedKey: async () => undefined,
				env: (name) => process.env[name],
			},
			chat,
		);
		if (!route) throw new Error("An explicit image route is required");
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-image-live-"));
		try {
			const store = new ImageArtifactStore(root);
			const tool = createImageTools({
				store,
				route,
				authorize: () => ({ decision: "allow" }),
			}).find((t) => t.name === "image_generate");
			if (!tool) throw new Error("Image generation tool unavailable");
			const result = await tool.executeRaw(
				JSON.stringify({
					prompt:
						"A small solid orange circle centered on a plain white square background. No text.",
				}),
				createToolContext(),
			);
			const metadata = await verifyImageResult(result, store, model);
			console.log(
				`Live image validated: auth=${route.authMode}, requested_model=${model}, effective_model=${metadata.effective_model ?? "unknown"}, ${metadata.width}x${metadata.height}, ${metadata.byte_size} bytes; original reloaded and model image input resolved.`,
			);
		} finally {
			// Only this test's temporary store is removed, never production artifacts.
			await rm(root, { recursive: true, force: true });
		}
	},
	240_000,
);
