import { expect, test } from "bun:test";
import { checkSubset } from "./check";
import { SchemaModel } from "./model";
import { emitRust } from "./rust";
import { DEFS_PREFIX, type JsonSchema, type MethodEntry } from "./schema";

const ref = (id: string): JsonSchema => ({ $ref: `${DEFS_PREFIX}${id}` });
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
	type: "object",
	properties,
	required: Object.keys(properties),
});
const createModel = (
	defs: Record<string, JsonSchema>,
	methods: Record<string, MethodEntry>,
) =>
	new SchemaModel({
		$schema: "",
		$id: "",
		"x-codelia-protocol-version": "0",
		"x-codelia-methods": methods,
		$defs: defs,
	});
const emit = (model: SchemaModel) =>
	emitRust(model, { protocolVersion: "0", rpcErrorCodes: {} });

const defs = {
	SendOnlyUnion: {
		anyOf: [
			object({ alpha: { type: "string" } }),
			object({ beta: { type: "boolean" } }),
		],
	},
	Alias: { type: "array", items: ref("SendOnlyUnion") },
	Envelope: object({
		choice: { anyOf: [ref("Alias"), { type: "string" }] },
	}),
	Independent: object({
		description: {
			type: "string",
			description: "This mentions SendOnlyUnion.",
		},
	}),
};

test("propagates Serialize-only types through aliases and inline unions, ignoring docs", () => {
	const model = createModel(defs, {
		send: { kind: "notification", from: "ui", params: ref("Envelope") },
		alias: { kind: "notification", from: "ui", params: ref("Alias") },
		plain: { kind: "notification", from: "ui", params: ref("Independent") },
	});
	const output = emit(model);
	expect(output.errors).toEqual([]);
	expect(output.code).toContain("pub(crate) type Alias = Vec<SendOnlyUnion>;");
	expect(output.code).toContain("impl_object_serde!(Independent);");
	expect(output.code).not.toContain("impl_object_serde!(Envelope);");
	expect(output.code).toContain('"plain" => roundtrip::<Independent>(value)');
	expect(output.code).not.toContain('"send" => roundtrip::<Envelope>(value)');
	expect(output.code).not.toContain('"alias" => roundtrip::<Alias>(value)');
});

test("fails generation when a receiver requires an unsupported union through an alias", () => {
	const model = createModel(defs, {
		receive: { kind: "notification", from: "runtime", params: ref("Envelope") },
	});
	expect(emit(model).errors).toEqual([
		"receive.params → Envelope.choice|0 → Alias[] → SendOnlyUnion: untagged union in a Rust decode position needs tagged() or distinct JSON kinds",
	]);
});

test("rejects numeric consts outside the supported safe integer subset", () => {
	const model = createModel(
		{ Root: object({ depth: { type: "number", const: 1.5 } }) },
		{ receive: { kind: "notification", from: "runtime", params: ref("Root") } },
	);
	expect(checkSubset(model)).toContain(
		"Root.depth: numeric literals must be safe integers",
	);
	expect(emit(model).errors).toContain(
		"RootDepth: numeric literals must be safe integers",
	);
});

test("reports the method result path for a wireCount in an inline array", () => {
	const model = createModel(
		{
			Params: object({}),
			Result: object({
				counts: {
					type: "array",
					items: { type: "number", "x-codelia-encode": "integer" },
				},
			}),
		},
		{
			read: {
				kind: "request",
				from: "ui",
				params: ref("Params"),
				result: ref("Result"),
			},
		},
	);
	expect(emit(model).errors).toEqual([
		"read.result → Result.counts[]: wireCount() is encode-only",
	]);
});
