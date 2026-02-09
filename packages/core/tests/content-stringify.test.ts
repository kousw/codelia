import { describe, expect, test } from "bun:test";
import {
	stringifyContent,
	stringifyContentParts,
} from "../src/content/stringify";
import type { ContentPart } from "../src/types/llm/content";

describe("content stringify helpers", () => {
	test("stringifyContentParts formats user display text", () => {
		const parts: ContentPart[] = [
			{ type: "text", text: "hello" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
			{
				type: "document",
				source: { data: "JVBERi0xLjQK", media_type: "application/pdf" },
			},
			{
				type: "other",
				provider: "x",
				kind: "y",
				payload: { ok: true },
			},
		];
		expect(stringifyContentParts(parts, { mode: "display" })).toBe(
			"hello[image][document][other:x/y]",
		);
	});

	test("stringifyContent formats log text with payload details", () => {
		const text = stringifyContent(
			[
				{
					type: "other",
					provider: "x",
					kind: "y",
					payload: { ok: true },
				},
			],
			{ mode: "log", includeOtherPayload: true },
		);
		expect(text).toBe('[other:x/y] {"ok":true}');
	});
});
