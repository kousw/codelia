// Shared helpers over the generated JSON Schema document.
import {
	DEFS_PREFIX,
	type JsonSchema,
	type MethodEntry,
	type ProtocolDocument,
} from "./schema";

export const PRESENCE_KEY = "x-codelia-presence";
export const TAG_KEY = "x-codelia-tag";
export const KEYED_KEY = "x-codelia-keyed";

export const refId = (schema: JsonSchema): string | null =>
	typeof schema.$ref === "string" && schema.$ref.startsWith(DEFS_PREFIX)
		? schema.$ref.slice(DEFS_PREFIX.length)
		: null;

export const branchesOf = (schema: JsonSchema): JsonSchema[] | null =>
	schema.oneOf ?? schema.anyOf ?? null;

const isNullSchema = (schema: JsonSchema) => schema.type === "null";

/** `T | null` written as a two-branch anyOf; returns T. */
export const nullableInner = (schema: JsonSchema): JsonSchema | null => {
	const branches = branchesOf(schema);
	if (branches?.length !== 2) return null;
	const rest = branches.filter((branch) => !isNullSchema(branch));
	return rest.length === 1 && branches.some(isNullSchema) ? rest[0] : null;
};

export const allowsNull = (schema: JsonSchema): boolean =>
	isNullSchema(schema) || (branchesOf(schema)?.some(isNullSchema) ?? false);

export type Route =
	| "ui_to_runtime_request"
	| "ui_to_runtime_notification"
	| "runtime_to_ui_request"
	| "runtime_to_ui_notification";

export const routeOf = (entry: MethodEntry): Route =>
	`${entry.from === "ui" ? "ui_to_runtime" : "runtime_to_ui"}_${entry.kind}`;

export class SchemaModel {
	readonly defs: Record<string, JsonSchema>;
	readonly methods: Record<string, MethodEntry>;
	/** Definitions the Rust client decodes (received from the runtime). */
	readonly decoded: Set<string>;
	/** Definitions the Rust client encodes (sent to the runtime). */
	readonly encoded: Set<string>;

	constructor(readonly doc: ProtocolDocument) {
		this.defs = doc.$defs;
		this.methods = doc["x-codelia-methods"];
		const decodeRoots: string[] = [];
		const encodeRoots: string[] = [];
		for (const entry of Object.values(this.methods)) {
			const params = refId(entry.params);
			const result = entry.result ? refId(entry.result) : null;
			if (entry.from === "runtime") {
				if (params) decodeRoots.push(params);
				if (result) encodeRoots.push(result);
			} else {
				if (params) encodeRoots.push(params);
				if (result) decodeRoots.push(result);
			}
		}
		this.decoded = this.closure(decodeRoots);
		this.encoded = this.closure(encodeRoots);
	}

	resolve(schema: JsonSchema): JsonSchema {
		const id = refId(schema);
		return id ? this.defs[id] : schema;
	}

	private closure(roots: string[]): Set<string> {
		const seen = new Set<string>();
		const visit = (node: unknown) => {
			if (Array.isArray(node)) {
				for (const item of node) visit(item);
				return;
			}
			if (!node || typeof node !== "object") return;
			for (const [key, value] of Object.entries(node)) {
				if (key === "$ref" && typeof value === "string") {
					const id = value.slice(DEFS_PREFIX.length);
					if (!seen.has(id)) {
						seen.add(id);
						visit(this.defs[id]);
					}
				} else visit(value);
			}
		};
		for (const id of roots) {
			if (!seen.has(id)) {
				seen.add(id);
				visit(this.defs[id]);
			}
		}
		return seen;
	}

	/** Literal values of `tag` in a branch, following nested tagged unions. */
	tagValues(branch: JsonSchema, tag: string): unknown[] | null {
		const resolved = this.resolve(branch);
		const nested = branchesOf(resolved);
		if (nested && typeof resolved[TAG_KEY] === "string") {
			const values = nested.map((inner) => this.tagValues(inner, tag));
			if (values.some((value) => value === null)) return null;
			const flat = values.flat() as unknown[];
			return [...new Set(flat)];
		}
		if (resolved.type !== "object" || !resolved.properties) return null;
		const property = resolved.properties[tag];
		if (!property) return null;
		if (property.const !== undefined) return [property.const];
		return null;
	}

	/** True when a branch declares its tag literal as optional. */
	tagOptional(branch: JsonSchema, tag: string): boolean {
		const resolved = this.resolve(branch);
		if (branchesOf(resolved)) return false;
		return (
			resolved.properties?.[tag] !== undefined &&
			!resolved.required?.includes(tag)
		);
	}

	/**
	 * For a keyed union: the required key that identifies each branch, or null
	 * when a branch has no key that the other branches lack.
	 */
	branchKeys(schema: JsonSchema): (string | null)[] {
		const branches = (branchesOf(schema) ?? []).map((branch) =>
			this.resolve(branch),
		);
		return branches.map((branch, index) => {
			const others = branches.filter((_, other) => other !== index);
			return (
				(branch.required ?? []).find((key) =>
					others.every((other) => other.properties?.[key] === undefined),
				) ?? null
			);
		});
	}
}
