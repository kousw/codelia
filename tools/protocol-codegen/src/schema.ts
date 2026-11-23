// Step 1: catalog -> one JSON Schema document. Only the official Zod JSON
// Schema API is used; Zod internals are never read.
import { protocolErrorData, protocolMethods } from "@codelia/protocol";
import { z } from "zod";

export type JsonSchema = Record<string, unknown> & {
	$ref?: string;
	type?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: boolean | JsonSchema;
	items?: JsonSchema;
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	enum?: unknown[];
	const?: unknown;
	description?: string;
};

export type MethodEntry = {
	kind: "request" | "notification";
	from: "ui" | "runtime";
	params: JsonSchema;
	result?: JsonSchema;
	errorData?: JsonSchema;
	capability?: string;
	uiCapability?: string;
};

export type ProtocolDocument = {
	$schema: string;
	$id: string;
	"x-codelia-protocol-version": string;
	"x-codelia-methods": Record<string, MethodEntry>;
	"x-codelia-error-data": Record<string, JsonSchema>;
	$defs: Record<string, JsonSchema>;
};

export const DEFS_PREFIX = "#/$defs/";

const toJson = (schema: z.ZodType, io: "input" | "output"): JsonSchema =>
	z.toJSONSchema(schema, {
		target: "draft-2020-12",
		io,
		// Throws on transforms, dates, bigints and other values JSON cannot
		// carry, so forbidden constructs fail generation.
		unrepresentable: "throw",
	}) as JsonSchema;

const idOf = (schema: z.ZodType, method: string, slot: string): string => {
	const id = z.globalRegistry.get(schema)?.id;
	if (!id)
		throw new Error(
			`${method}.${slot}: catalog schemas must carry .meta({ id })`,
		);
	return id;
};

/**
 * Builds the document. Every catalog schema must be named; all named schemas
 * reachable from the catalog land in `$defs`.
 */
export const buildProtocolDocument = (
	protocolVersion: string,
): ProtocolDocument => {
	const methods: Record<string, MethodEntry> = {};
	for (const [method, spec] of Object.entries(protocolMethods)) {
		const entry: MethodEntry = {
			kind: spec.kind,
			from: spec.from,
			params: { $ref: `${DEFS_PREFIX}${idOf(spec.params, method, "params")}` },
		};
		// Output mode throws on transforms; input mode is what receivers use.
		toJson(spec.params, "output");
		if ("result" in spec) {
			entry.result = {
				$ref: `${DEFS_PREFIX}${idOf(spec.result, method, "result")}`,
			};
			toJson(spec.result, "output");
		}
		if ("errorData" in spec) {
			entry.errorData = {
				$ref: `${DEFS_PREFIX}${idOf(spec.errorData, method, "errorData")}`,
			};
			toJson(spec.errorData, "output");
		}
		const gates = spec as { capability?: string; uiCapability?: string };
		if (gates.capability) entry.capability = gates.capability;
		if (gates.uiCapability) entry.uiCapability = gates.uiCapability;
		methods[method] = entry;
	}
	const errorData: Record<string, JsonSchema> = {};
	for (const [code, schema] of Object.entries(protocolErrorData)) {
		errorData[code] = {
			$ref: `${DEFS_PREFIX}${idOf(schema, code, "errorData")}`,
		};
		toJson(schema, "output");
	}
	// Input mode omits additionalProperties:false, so receivers accept
	// additive fields from newer peers.
	const bundle = z.toJSONSchema(z.globalRegistry, {
		target: "draft-2020-12",
		io: "input",
		unrepresentable: "throw",
		uri: (id) => `${DEFS_PREFIX}${id}`,
	});
	const defs: Record<string, JsonSchema> = {};
	for (const id of Object.keys(bundle.schemas).sort()) {
		const {
			$schema: _schema,
			$id: _id,
			...rest
		} = bundle.schemas[id] as JsonSchema;
		defs[id] = rest as JsonSchema;
	}
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: "codelia-protocol",
		"x-codelia-protocol-version": protocolVersion,
		"x-codelia-methods": methods,
		"x-codelia-error-data": errorData,
		$defs: pruneUnreachable(defs, [methods, errorData]),
	};
};

const refsIn = (node: unknown, found: Set<string>): void => {
	if (Array.isArray(node)) {
		for (const item of node) refsIn(item, found);
		return;
	}
	if (!node || typeof node !== "object") return;
	for (const [key, value] of Object.entries(node)) {
		if (key === "$ref" && typeof value === "string") found.add(value);
		else refsIn(value, found);
	}
};

/** Keeps only definitions reachable from the catalog. */
const pruneUnreachable = (
	defs: Record<string, JsonSchema>,
	roots: unknown,
): Record<string, JsonSchema> => {
	const pending = new Set<string>();
	refsIn(roots, pending);
	const kept = new Set<string>();
	while (pending.size > 0) {
		const [ref] = pending;
		pending.delete(ref);
		if (!ref.startsWith(DEFS_PREFIX))
			throw new Error(`unsupported $ref ${ref}`);
		const id = ref.slice(DEFS_PREFIX.length);
		if (kept.has(id)) continue;
		const def = defs[id];
		if (!def) throw new Error(`missing definition ${id}`);
		kept.add(id);
		refsIn(def, pending);
	}
	return Object.fromEntries(
		Object.entries(defs).filter(([id]) => kept.has(id)),
	);
};
