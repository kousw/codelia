import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseImageGenerationConfig } from "@codelia/config";
import { ImageArtifactStore } from "@codelia/storage";
import { generateImage } from "../src/image-generation/adapter";
import { exportImageBytes } from "../src/image-generation/export";
import { parseGoogleImageInteraction } from "../src/image-generation/google";
import { resolveImageRoute } from "../src/image-generation/route";
import { referenceJpeg64, referencePng64 } from "./image-source-fixtures";

test("Google image selection accepts 4K for supported models and rejects Lite above 1K", async () => {
	const config = parseImageGenerationConfig({
		mode: "custom",
		provider: "google",
		model: "gemini-nano-banana-2.1",
		provider_options: {
			google: { image_size: "4K", aspect_ratio: "1:1", output_format: "jpeg" },
		},
	});
	const route = await resolveImageRoute(config, {
		storedKey: async () => "fixture",
		env: () => undefined,
	});
	expect(route).toMatchObject({
		provider: "google",
		model: "gemini-nano-banana-2.1",
		options: { image_size: "4K", aspect_ratio: "1:1", output_format: "jpeg" },
	});
	expect(() =>
		parseImageGenerationConfig({
			mode: "custom",
			provider: "google",
			model: "gemini-3.1-flash-lite-image",
			provider_options: { google: { image_size: "2K" } },
		}),
	).toThrow();
	expect(() =>
		parseImageGenerationConfig({
			mode: "custom",
			provider: "google",
			model: "gemini-3-pro-image",
			provider_options: { google: { aspect_ratio: "1:8" } },
		}),
	).toThrow();
});

test("Google final output parser preserves every PNG/JPEG and rejects incomplete or malformed images", () => {
	const png = Buffer.from("png bytes").toString("base64");
	const jpeg = Buffer.from("jpeg bytes").toString("base64");
	const raw = {
		status: "completed",
		model: "gemini-nano-banana-2.1",
		steps: [
			{
				type: "thought",
				summary: [{ type: "image", mime_type: "image/png", data: png }],
			},
			{
				type: "model_output",
				content: [
					{ type: "text", text: "two images" },
					{ type: "image", mime_type: "image/png", data: png },
					{ type: "image", mime_type: "image/jpeg", data: jpeg },
				],
			},
		],
	};
	expect(
		parseGoogleImageInteraction(raw).images.map((image) => image.media_type),
	).toEqual(["image/png", "image/jpeg"]);
	expect(() =>
		parseGoogleImageInteraction({ ...raw, status: "failed" }),
	).toThrow("did not complete");
	expect(() =>
		parseGoogleImageInteraction({
			...raw,
			steps: [
				{
					type: "model_output",
					content: [{ type: "image", mime_type: "image/webp", data: png }],
				},
			],
		}),
	).toThrow("unsupported");
});

test("returned JPEG original exports only to a matching new path", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "codelia-google-image-"));
	try {
		const jpeg = Buffer.from(referenceJpeg64, "base64");
		const store = new ImageArtifactStore(root);
		const artifact = await store.save(
			jpeg,
			{
				provider: "google",
				requested_model: "gemini-nano-banana-2.1",
				endpoint: "interactions",
				parent_artifact_ids: [],
			},
			"image/jpeg",
		);
		await expect(
			exportImageBytes(root, "wrong.png", jpeg, artifact.media_type),
		).rejects.toThrow("match");
		const output = await exportImageBytes(
			root,
			"result.jpg",
			jpeg,
			artifact.media_type,
		);
		expect(await readFile(output)).toEqual(jpeg);
		await expect(
			exportImageBytes(root, "result.jpg", jpeg, artifact.media_type),
		).rejects.toThrow("failed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("official SDK sends stateless 4K request and returns every final image without a live API call", async () => {
	const config = parseImageGenerationConfig({
		mode: "custom",
		provider: "google",
		model: "gemini-nano-banana-2.1",
		provider_options: {
			google: { image_size: "4K", aspect_ratio: "1:1", output_format: "jpeg" },
		},
	});
	const route = await resolveImageRoute(config, {
		storedKey: async () => "fixture",
		env: () => undefined,
	});
	if (!route) throw new Error("missing route");
	let request: Record<string, unknown> | undefined;
	let called = 0;
	const result = await generateImage(
		route,
		"Make two images",
		[],
		undefined,
		async (url, init) => {
			called++;
			expect(url).toContain("generativelanguage.googleapis.com");
			request = init?.body
				? JSON.parse(await new Response(init.body).text())
				: undefined;
			return Response.json({
				id: "fixture-interaction",
				status: "completed",
				model: "gemini-nano-banana-2.1",
				steps: [
					{
						type: "model_output",
						content: [
							{ type: "image", mime_type: "image/jpeg", data: referenceJpeg64 },
							{ type: "image", mime_type: "image/jpeg", data: referenceJpeg64 },
						],
					},
				],
			});
		},
	);
	expect(called).toBe(1);
	expect(request).toMatchObject({
		store: false,
		model: "gemini-nano-banana-2.1",
		response_format: {
			type: "image",
			image_size: "4K",
			aspect_ratio: "1:1",
			mime_type: "image/jpeg",
		},
	});
	expect(result.images).toHaveLength(2);
});

test("unsupported explicit PNG is rejected before request; default PNG response is preserved", async () => {
	expect(() =>
		parseImageGenerationConfig({
			mode: "custom",
			provider: "google",
			model: "gemini-nano-banana-2.1",
			provider_options: { google: { output_format: "png" } },
		}),
	).toThrow();
	const config = parseImageGenerationConfig({
		mode: "custom",
		provider: "google",
		model: "gemini-nano-banana-2.1",
	});
	const route = await resolveImageRoute(config, {
		storedKey: async () => "fixture",
		env: () => undefined,
	});
	if (!route) throw new Error("missing route");
	let requestedMime: unknown;
	const result = await generateImage(
		route,
		"Draw",
		[],
		undefined,
		async (_url, init) => {
			const request = JSON.parse(await new Response(init?.body).text());
			requestedMime = request.response_format?.mime_type;
			return Response.json({
				status: "completed",
				steps: [
					{
						type: "model_output",
						content: [
							{ type: "image", mime_type: "image/png", data: referencePng64 },
						],
					},
				],
			});
		},
	);
	expect(requestedMime).toBeUndefined();
	expect(result.media_type).toBe("image/png");
});
