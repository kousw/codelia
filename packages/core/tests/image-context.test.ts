import { expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import {
	estimateImageContext,
	validateImagePayload,
} from "../src/agent/image-context";
import { imageReferenceRegistry } from "../src/content/image-references";
import type { BaseChatModel, ChatInvokeInput } from "../src/llm/base";
import { estimateImageTokens } from "../src/llm/image-policy";
import { createModelRegistry } from "../src/models/registry";
import type { BaseMessage, ImageRefPart } from "../src/types/llm";

const image = (byteSize = 100, width = 1024, height = 1536): ImageRefPart => ({
	type: "image_ref",
	image_ref: {
		artifact_id: "codelia-image-11111111-1111-1111-1111-111111111111",
		sha256: "a".repeat(64),
		media_type: "image/png",
		byte_size: byteSize,
		width,
		height,
	},
});
const model = (
	provider: BaseChatModel["provider"],
	name: string,
): BaseChatModel => ({
	provider,
	model: name,
	ainvoke: async () => ({ messages: [{ role: "assistant", content: "done" }] }),
});

test("vision estimates use model/detail/resolution, not compressed byte size", () => {
	const llm = model("openai", "gpt-6-astra");
	const input = (bytes: number): ChatInvokeInput => ({
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "describe" }, image(bytes)],
			},
		],
	});
	const small = estimateImageContext(input(100), llm);
	const large = estimateImageContext(input(8 * 1024 * 1024), llm);
	expect(small.image_tokens).toBe(1844);
	expect(large.image_tokens).toBe(small.image_tokens);
	expect(large.text_tokens).toBe(small.text_tokens);
	expect(large.encoded_image_bytes).toBeGreaterThan(10_000_000);
	for (const [provider, name, expected] of [
		["openai", "gpt-6-astra", 1229],
		["openrouter", "openai/gpt-6-astra", 1229],
		["anthropic", "claude-opus-5", 1369],
		["openrouter", "anthropic/claude-opus-5", 1369],
	] as const)
		expect(
			estimateImageTokens(provider, name, { width: 1024, height: 1024 }).tokens,
		).toBe(expected);
	expect(
		estimateImageTokens("openai", "gpt-6-astra", {
			width: 2048,
			height: 2048,
			detail: "high",
		}).tokens,
	).toBe(3000);
	expect(
		estimateImageTokens("openai", "gpt-6-astra", {
			width: 2048,
			height: 2048,
			detail: "low",
		}).tokens,
	).toBe(308);
	expect(
		estimateImageTokens("openai", "gpt-5.5", {
			width: 2048,
			height: 2048,
			detail: "high",
		}).tokens,
	).toBe(3000);
	expect(
		estimateImageTokens("openai", "gpt-4o", { detail: "low" }).tokens,
	).toBe(85);
	for (const provider of [
		"moonshot",
		"zai",
		"xai",
		"openrouter",
		"anthropic",
	] as const)
		expect(
			estimateImageTokens(provider, "unknown-model", {
				width: 1024,
				height: 1536,
			}),
		).toEqual({ tokens: 10000, method: "fallback" });
});

test("inline images are decoded only for dimensions, URLs stay un-fetched, registries are not visual tokens", () => {
	const llm = model("anthropic", "claude-opus-5");
	const png =
		"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=";
	const inline = estimateImageContext(
		{
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: { url: `data:image/png;base64,${png}` },
						},
					],
				},
			],
		},
		llm,
	);
	expect(inline.image_tokens).toBe(1);
	expect(inline.fallback_image_count).toBe(0);
	const remote = estimateImageContext(
		{
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: { url: "https://must-not-fetch.invalid/image.png" },
						},
					],
				},
			],
		},
		llm,
	);
	expect(remote.fallback_image_count).toBe(1);
	const registry = imageReferenceRegistry([
		{ role: "user", content: [image()] },
	]);
	if (!registry) throw Error("missing registry");
	expect(estimateImageContext({ messages: [registry] }, llm).image_tokens).toBe(
		0,
	);
	expect(
		estimateImageContext(
			{ messages: [{ role: "user", content: [image()] }] },
			llm,
			false,
		).image_tokens,
	).toBe(0);
});

test("transfer budget is independent of context tokens and does not apply OpenAI limits to OpenRouter", () => {
	const messages: BaseMessage[] = [
		{
			role: "user",
			content: Array.from({ length: 4 }, () => image(8 * 1024 * 1024, 2, 2)),
		},
	];
	const claude = model("anthropic", "claude-opus-5");
	const estimate = estimateImageContext({ messages }, claude);
	expect(estimate.image_tokens).toBe(4);
	expect(() => validateImagePayload(estimate, claude)).toThrow(
		"transport payload budget",
	);
	expect(() =>
		validateImagePayload(estimate, model("openai", "gpt-6-astra")),
	).not.toThrow();
	expect(() =>
		validateImagePayload(
			{ ...estimate, estimated_request_bytes: 600_000_000 },
			model("openrouter", "openai/gpt-6-astra"),
		),
	).not.toThrow();
});

test("provider usage calibrates estimates for previously sent images without double counting them", async () => {
	const requests: ChatInvokeInput[] = [];
	const llm: BaseChatModel = {
		...model("moonshot", "fixture"),
		ainvoke: async (input) => {
			const { signal: _signal, ...request } = input;
			requests.push(structuredClone(request));
			return {
				messages: [{ role: "assistant", content: "done" }],
				usage: {
					model: "fixture",
					input_tokens: 100,
					output_tokens: 10,
					total_tokens: 110,
				},
			};
		},
	};
	const agent = new Agent({
		llm,
		tools: [],
		modelRegistry: createModelRegistry([
			{ id: "fixture", provider: "moonshot", contextWindow: 20000 },
		]),
		services: {
			resolveImage: async () => ({
				type: "image_url",
				image_url: { url: "data:image/png;base64,fixture" },
			}),
		},
	});
	await agent.run([image()]);
	await agent.run([image()]);
	expect(requests).toHaveLength(2);
	expect(JSON.stringify(requests[1]?.messages.slice(0, 1))).toBe(
		JSON.stringify(requests[0]?.messages),
	);
});

test("new vision tokens can trigger normal compaction; the newest attachment remains visible", async () => {
	let summaries = 0;
	const visualCounts: number[] = [];
	const llm: BaseChatModel = {
		...model("moonshot", "fixture"),
		estimateImageTokens: () => ({ tokens: 800, method: "patch" }),
		ainvoke: async (input) => {
			const visual = input.messages
				.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
				.filter((p) => p.type === "image_url").length;
			if (!visual) summaries++;
			else visualCounts.push(visual);
			return {
				messages: [
					{
						role: "assistant",
						content: visual
							? "done"
							: "<summary>Earlier image viewed.</summary>",
					},
				],
				usage: {
					model: "fixture",
					input_tokens: 1000,
					output_tokens: 10,
					total_tokens: 1010,
				},
			};
		},
	};
	const agent = new Agent({
		llm,
		tools: [],
		modelRegistry: createModelRegistry([
			{ id: "fixture", provider: "moonshot", contextWindow: 1600 },
		]),
		services: {
			resolveImage: async () => ({
				type: "image_url",
				image_url: { url: "data:image/png;base64,fixture" },
			}),
		},
	});
	await agent.run([image()]);
	await agent.run([image()]);
	expect(summaries).toBe(1);
	expect(visualCounts).toEqual([1, 1]);
});

test("fixed JPEG model views lower transfer estimates without lowering same-resolution vision tokens", () => {
	const llm = model("openai", "gpt-6-astra");
	const original = image(2_000_000);
	const view: ImageRefPart = {
		...original,
		image_ref: {
			...original.image_ref,
			model_view: {
				version: "jpeg-q90-444-v1",
				media_type: "image/jpeg",
				sha256: "b".repeat(64),
				byte_size: 200_000,
			},
		},
	};
	const estimate = (part: ImageRefPart) =>
		estimateImageContext(
			{ messages: [{ role: "user", content: [part] }] },
			llm,
		);
	expect(estimate(view).image_tokens).toBe(estimate(original).image_tokens);
	expect(estimate(view).text_tokens).toBe(estimate(original).text_tokens);
	expect(estimate(view).encoded_image_bytes).toBeLessThan(
		estimate(original).encoded_image_bytes / 9,
	);
});
