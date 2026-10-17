import { expect, test } from "bun:test";
import { materializeImageReferences } from "../src/agent/image-input";
import { imageReferenceRegistry } from "../src/content/image-references";
import { stringifyContent } from "../src/content/stringify";
import { toAnthropicMessages } from "../src/llm/anthropic/serializer";
import { toResponsesInput } from "../src/llm/openai/serializer";
import { DEFAULT_MODEL_REGISTRY } from "../src/models";
import { CompactionService } from "../src/services/compaction/service";
import {
	type BaseMessage,
	type ImageRefPart,
	isContentPart,
} from "../src/types/llm";

const ref = (n: number): ImageRefPart => ({
	type: "image_ref",
	image_ref: {
		artifact_id: `codelia-image-00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
		sha256: "a".repeat(64),
		media_type: "image/png",
		byte_size: 100,
		width: 2,
		height: 2,
	},
});
test("image reference is a real content part with bounded validated identity, not opaque JSON", () => {
	expect(isContentPart(ref(1))).toBe(true);
	expect(
		isContentPart({
			type: "image_ref",
			image_ref: { ...ref(1).image_ref, artifact_id: "../../secret" },
		}),
	).toBe(false);
	expect(
		isContentPart({
			type: "image_ref",
			image_ref: { ...ref(1).image_ref, byte_size: 1e20 },
		}),
	).toBe(false);
	expect(stringifyContent([ref(1)])).toContain(ref(1).image_ref.artifact_id);
});
test("appending a third image preserves the complete previous model-input prefix without mutating history", async () => {
	const history: BaseMessage[] = [1, 2, 3].map((n) => ({
		role: "user",
		content: [ref(n)],
	}));
	const before = JSON.stringify(history);
	const resolved: string[] = [];
	const resolve = async (r: ImageRefPart["image_ref"]) => {
		resolved.push(r.artifact_id);
		return {
			type: "image_url" as const,
			image_url: { url: "data:image/png;base64,fixture" },
		};
	};
	const first = await materializeImageReferences(history.slice(0, 2), resolve);
	resolved.length = 0;
	const result = await materializeImageReferences(history, resolve);
	expect(resolved).toEqual([
		ref(1).image_ref.artifact_id,
		ref(2).image_ref.artifact_id,
		ref(3).image_ref.artifact_id,
	]);
	expect(JSON.stringify(history)).toBe(before);
	expect(JSON.stringify(result.slice(0, 2))).toBe(JSON.stringify(first));
	expect(JSON.stringify(toResponsesInput(result).slice(0, 2))).toBe(
		JSON.stringify(toResponsesInput(first)),
	);
	expect(JSON.stringify(toAnthropicMessages(result).messages.slice(0, 2))).toBe(
		JSON.stringify(toAnthropicMessages(first).messages),
	);
	expect(
		result.every((message) =>
			JSON.stringify(message).includes("data:image/png"),
		),
	).toBe(true);
});

test("missing originals fail closed while more than 12 MiB of originals remain materializable", async () => {
	const history: BaseMessage[] = [{ role: "user", content: [ref(1)] }];
	await expect(
		materializeImageReferences(history, async () => {
			throw Error("private path");
		}),
	).rejects.toThrow("model request was not sent");
	const large = [1, 2].map(
		(n): BaseMessage => ({
			role: "user",
			content: [
				{
					...ref(n),
					image_ref: { ...ref(n).image_ref, byte_size: 8 * 1024 * 1024 },
				},
			],
		}),
	);
	let calls = 0;
	const materialized = await materializeImageReferences(large, async () => {
		calls++;
		return {
			type: "image_url",
			image_url: { url: "data:image/png;base64,fixture" },
		};
	});
	expect(materialized).toHaveLength(2);
	expect(calls).toBe(2);
	expect(
		JSON.stringify(await materializeImageReferences(history, undefined)),
	).toContain("image input unavailable on this connection");
	const controller = new AbortController();
	controller.abort();
	await expect(
		materializeImageReferences(history, undefined, controller.signal),
	).rejects.toThrow();
});
test("compaction preserves a bounded reference registry across repeated compaction, never sends refs as provider URLs", async () => {
	const service = new CompactionService(
		{ enabled: true, retainLastTurns: 0 },
		{ modelRegistry: DEFAULT_MODEL_REGISTRY },
	);
	const initial: BaseMessage[] = [
		{ role: "user", content: "Generate an image" },
		{
			role: "tool",
			tool_call_id: "generated",
			tool_name: "image_generate",
			content: [ref(1)],
		},
	];
	const llm = {
		provider: "openai" as const,
		model: "mock",
		ainvoke: async (input: { messages: BaseMessage[] }) => {
			expect(JSON.stringify(input.messages)).not.toContain(
				'"type":"image_ref"',
			);
			return {
				messages: [
					{
						role: "assistant" as const,
						content: "<summary>Image created.</summary>",
					},
				],
			};
		},
	};
	const first = await service.compact(llm, initial);
	const second = await service.compact(llm, [
		...first.compactedMessages,
		{ role: "user", content: "Continue" },
	]);
	expect(JSON.stringify(second.compactedMessages)).toContain(
		ref(1).image_ref.artifact_id,
	);
	expect(JSON.stringify(second.compactedMessages)).toContain(
		'"type":"image_ref"',
	);
	let resolved = 0;
	await materializeImageReferences(second.compactedMessages, async () => {
		resolved++;
		return { type: "image_url", image_url: { url: "unused" } };
	});
	expect(resolved).toBe(0);
	const many = imageReferenceRegistry(
		Array.from({ length: 20 }, (_, n) => ({ role: "user", content: [ref(n)] })),
	);
	expect(many?.content).toHaveLength(17);
});

test("persisted model-view descriptors are validated and preserved at the resolver boundary", async () => {
	const part = ref(1);
	part.image_ref.model_view = {
		version: "jpeg-q90-444-v1",
		media_type: "image/jpeg",
		sha256: "b".repeat(64),
		byte_size: 70,
	};
	expect(isContentPart(part)).toBe(true);
	expect(
		isContentPart({
			...part,
			image_ref: {
				...part.image_ref,
				model_view: {
					...part.image_ref.model_view,
					version: "../../arbitrary",
				},
			},
		}),
	).toBe(false);
	let resolved: unknown;
	const input = await materializeImageReferences(
		[{ role: "user", content: [part] }],
		async (reference) => {
			resolved = reference;
			return {
				type: "image_url",
				image_url: {
					url: "data:image/jpeg;base64,fixture",
					media_type: "image/jpeg",
				},
			};
		},
	);
	expect(resolved).toEqual(part.image_ref);
	expect(JSON.stringify(toResponsesInput(input))).toContain("data:image/jpeg");
	expect(JSON.stringify(toAnthropicMessages(input).messages)).toContain(
		"image/jpeg",
	);
});
