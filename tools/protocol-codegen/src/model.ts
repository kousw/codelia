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
export const ENCODE_KEY = "x-codelia-encode";

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

/** JSON kind of a schema for primitive-kind union checks. */
const kindOf = (model: SchemaModel, schema: JsonSchema): string => {
	const resolved = model.resolve(schema);
	if (branchesOf(resolved) && !nullableInner(resolved)) {
		return resolved[TAG_KEY] || resolved[KEYED_KEY] ? "object" : "union";
	}
	if (resolved.enum || typeof resolved.const === "string") return "string";
	if (resolved.type === "integer" || typeof resolved.const === "number")
		return "number";
	return typeof resolved.type === "string" ? resolved.type : "any";
};

const hasDistinctUnionKinds = (model: SchemaModel, branches: JsonSchema[]) => {
	const kinds = branches.map((branch) => kindOf(model, branch));
	return (
		new Set(kinds).size === kinds.length &&
		!kinds.includes("union") &&
		!kinds.includes("any")
	);
};

export const compareCodeUnits = (a: string, b: string): number =>
	a < b ? -1 : a > b ? 1 : 0;

type TypeNode = {
	schema: JsonSchema;
	dependencies: { path: string; node: TypeNode }[];
	dependents: Set<TypeNode>;
	encoded: boolean;
	decoded: boolean;
	serializeOnly: boolean;
};

type MethodRoot = {
	path: string;
	node: TypeNode;
	direction: "encoded" | "decoded";
};

export class SchemaModel {
	readonly defs: Record<string, JsonSchema>;
	readonly methods: Record<string, MethodEntry>;
	readonly decodeErrors: string[] = [];
	private readonly nodes = new Map<JsonSchema, TypeNode>();

	constructor(readonly doc: ProtocolDocument) {
		this.defs = doc.$defs;
		this.methods = doc["x-codelia-methods"];
		for (const schema of Object.values(this.defs)) this.addNode(schema);
		const roots = this.methodRoots();
		this.markMethodUsage(roots);
		const reasons = this.markSerializeOnlyNodes();
		this.collectDecodeErrors(roots, reasons);
	}

	private methodRoots(): MethodRoot[] {
		const roots: MethodRoot[] = [];
		for (const [method, entry] of Object.entries(this.methods)) {
			roots.push({
				path: `${method}.params`,
				node: this.addNode(entry.params),
				direction: entry.from === "ui" ? "encoded" : "decoded",
			});
			if (entry.result)
				roots.push({
					path: `${method}.result`,
					node: this.addNode(entry.result),
					direction: entry.from === "ui" ? "decoded" : "encoded",
				});
		}
		return roots;
	}

	private markMethodUsage(roots: MethodRoot[]): void {
		for (const { direction, node } of roots) {
			this.walk(node, "", (current) => {
				current[direction] = true;
			});
		}
	}

	private markSerializeOnlyNodes(): Map<TypeNode, string> {
		const reasons = new Map<TypeNode, string>();
		for (const node of this.nodes.values()) {
			const reason = this.decodeRestriction(node);
			if (!reason) continue;
			reasons.set(node, reason);
			const pending = [node];
			for (const required of pending) {
				if (required.serializeOnly) continue;
				required.serializeOnly = true;
				pending.push(...required.dependents);
			}
		}
		return reasons;
	}

	private collectDecodeErrors(
		roots: MethodRoot[],
		reasons: ReadonlyMap<TypeNode, string>,
	): void {
		for (const { path, node, direction } of roots) {
			if (direction !== "decoded") continue;
			this.walk(node, path, (current, path) => {
				// Rust can round-trip integer examples of wireCount() in fixtures.
				// A live decoder would still reject numbers the wire schema accepts.
				const reason =
					current.schema[ENCODE_KEY] === "integer"
						? "wireCount() is encode-only"
						: reasons.get(current);
				if (reason) this.decodeErrors.push(`${path}: ${reason}`);
			});
		}
	}

	serializeOnly(schema: JsonSchema): boolean {
		return this.nodes.get(schema)?.serializeOnly ?? false;
	}

	resolve(schema: JsonSchema): JsonSchema {
		let id = refId(schema);
		const seen = new Set<string>();
		while (id && this.defs[id] && !seen.has(id)) {
			seen.add(id);
			schema = this.defs[id];
			id = refId(schema);
		}
		return schema;
	}

	private addNode(schema: JsonSchema): TypeNode {
		const previous = this.nodes.get(schema);
		if (previous) return previous;
		const node: TypeNode = {
			schema,
			dependencies: [],
			dependents: new Set(),
			encoded: false,
			decoded: false,
			serializeOnly: false,
		};
		this.nodes.set(schema, node);
		const link = (path: string, schema: JsonSchema) => {
			const dependency = this.addNode(schema);
			dependency.dependents.add(node);
			node.dependencies.push({ path, node: dependency });
		};
		const id = refId(schema);
		if (id && this.defs[id]) link(` → ${id}`, this.defs[id]);
		for (const [field, child] of Object.entries(schema.properties ?? {}))
			link(`.${field}`, child);
		if (schema.items) link("[]", schema.items);
		if (typeof schema.additionalProperties === "object")
			link("[*]", schema.additionalProperties);
		for (const [index, branch] of (branchesOf(schema) ?? []).entries())
			link(`|${index}`, branch);
		return node;
	}

	private walk(
		root: TypeNode,
		path: string,
		visit: (node: TypeNode, path: string) => void,
	): void {
		const seen = new Set<TypeNode>();
		const walk = (node: TypeNode, path: string) => {
			if (seen.has(node)) return;
			seen.add(node);
			visit(node, path);
			for (const edge of node.dependencies) walk(edge.node, path + edge.path);
		};
		walk(root, path);
	}

	private decodeRestriction(node: TypeNode): string | undefined {
		const { schema } = node;
		const branches = branchesOf(schema);
		if (
			!branches ||
			nullableInner(schema) ||
			schema[TAG_KEY] ||
			schema[KEYED_KEY]
		)
			return undefined;
		if (!hasDistinctUnionKinds(this, branches))
			return "untagged union in a Rust decode position needs tagged() or distinct JSON kinds";
		if (node.encoded && !node.decoded) return "untagged union is encode-only";
		return undefined;
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
