import { expect, test } from "bun:test";
import { RunLogRequestModel } from "../src/run-log-request-model";

for (const size of [1, 2, 7, 256, 65536])
	test(`request accounting selects top-level identity across ${size}-byte fragments`, () => {
		const model = {
			provider: 'endpoint_"日本語\\a',
			name: 'shared-"model\\name',
		};
		const bytes = Buffer.from(
			JSON.stringify({
				type: "llm.request",
				input: {
					seq: 999,
					model: { provider: "nested-is-not-identity" },
					messages: [{ content: '\\"{},:日本語' }],
				},
				seq: 3,
				model,
				meta: { model: { provider: "also-nested" }, seq: 777 },
			}),
		);
		const selector = new RunLogRequestModel();
		for (let offset = 0; offset < bytes.length; offset += size)
			selector.push(bytes.subarray(offset, offset + size));
		expect(selector.finish()).toEqual({ seq: 3, model });
	});

test("large request input is discarded while identity after it stays available", () => {
	const bytes = Buffer.from(
		JSON.stringify({
			type: "llm.request",
			input: { messages: [{ content: "A".repeat(2 * 1024 * 1024) }] },
			seq: 2,
			model: { provider: "endpoint_a", name: "shared-model" },
		}),
	);
	const selector = new RunLogRequestModel();
	for (let offset = 0; offset < bytes.length; offset += 65536)
		selector.push(bytes.subarray(offset, offset + 65536));
	expect(selector.finish()).toEqual({
		seq: 2,
		model: { provider: "endpoint_a", name: "shared-model" },
	});
});

test("oversized model metadata and incomplete requests cannot authorize diagnostic removal", () => {
	const oversized = new RunLogRequestModel();
	expect(() =>
		oversized.push(
			Buffer.from(
				JSON.stringify({
					type: "llm.request",
					seq: 1,
					model: { name: "x".repeat(65537) },
				}),
			),
		),
	).toThrow("too large");
	const incomplete = new RunLogRequestModel();
	incomplete.push(Buffer.from('{"type":"llm.request","input":{"messages":['));
	expect(() => incomplete.finish()).toThrow("Incomplete");
});
