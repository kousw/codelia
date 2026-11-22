// Step 2: enforce the wire subset (spec section 3.2) on the JSON Schema.
import {
	allowsNull,
	branchesOf,
	KEYED_KEY,
	nullableInner,
	PRESENCE_KEY,
	refId,
	type SchemaModel,
	TAG_KEY,
} from "./model";
import { DEFS_PREFIX, type JsonSchema } from "./schema";

const ALLOWED_KEYS = new Set([
	"$ref",
	"type",
	"properties",
	"required",
	"additionalProperties",
	"propertyNames",
	"items",
	"anyOf",
	"oneOf",
	"enum",
	"const",
	"description",
	// Documentation only (`.readonly()` arrays); it does not change the wire.
	"readOnly",
	"minimum",
	"maximum",
	PRESENCE_KEY,
	TAG_KEY,
	KEYED_KEY,
]);

const SAFE_INTEGER = 9007199254740991;

/** JSON kind of a schema for primitive-kind union checks. */
const kindOf = (model: SchemaModel, schema: JsonSchema): string => {
	const resolved = model.resolve(schema);
	if (branchesOf(resolved) && !nullableInner(resolved)) {
		return resolved[TAG_KEY] || resolved[KEYED_KEY] ? "object" : "union";
	}
	if (resolved.enum || typeof resolved.const === "string") return "string";
	if (resolved.type === "integer") return "number";
	return typeof resolved.type === "string" ? resolved.type : "any";
};

export const checkSubset = (model: SchemaModel): string[] => {
	const errors: string[] = [];
	const branchRefs = new Map<string, number>();
	const allRefs = new Map<string, number>();

	const visit = (schema: JsonSchema, path: string, decoded: boolean) => {
		for (const key of Object.keys(schema)) {
			if (!ALLOWED_KEYS.has(key))
				errors.push(`${path}: unsupported keyword "${key}"`);
		}
		const ref = schema.$ref;
		if (ref !== undefined) {
			const id = refId(schema);
			if (!id || !model.defs[id])
				errors.push(`${path}: unsupported $ref ${String(ref)}`);
			else allRefs.set(id, (allRefs.get(id) ?? 0) + 1);
			return;
		}
		if (schema.type === "integer") {
			const min = schema.minimum;
			const max = schema.maximum;
			if (
				(min !== undefined && min !== -SAFE_INTEGER) ||
				(max !== undefined && max !== SAFE_INTEGER)
			)
				errors.push(`${path}: integer bounds are not supported`);
		} else if (schema.minimum !== undefined || schema.maximum !== undefined) {
			errors.push(`${path}: numeric bounds are not supported`);
		}
		if (schema.propertyNames) {
			const names = schema.propertyNames as JsonSchema;
			if (names.type !== "string" || Object.keys(names).length !== 1)
				errors.push(`${path}: record keys must be plain strings`);
		}
		if (schema.properties) {
			const required = new Set(schema.required ?? []);
			for (const [field, property] of Object.entries(schema.properties)) {
				const fieldPath = `${path}.${field}`;
				const presence = property[PRESENCE_KEY];
				if (!required.has(field) && allowsNull(property)) {
					if (presence !== "tri-state" && presence !== "collapse")
						errors.push(
							`${fieldPath}: optional nullable field needs clearable() or nullish()`,
						);
				} else if (presence !== undefined) {
					errors.push(
						`${fieldPath}: ${PRESENCE_KEY} applies only to optional nullable fields`,
					);
				}
				visit(property, fieldPath, decoded);
			}
		}
		if (
			schema.additionalProperties &&
			typeof schema.additionalProperties === "object"
		) {
			visit(schema.additionalProperties, `${path}[*]`, decoded);
		}
		if (schema.items) visit(schema.items, `${path}[]`, decoded);
		const branches = branchesOf(schema);
		if (!branches) return;
		branches.forEach((branch, index) => {
			visit(branch, `${path}|${index}`, decoded);
		});
		if (nullableInner(schema)) return;
		if (schema[KEYED_KEY] === true) {
			const keys = model.branchKeys(schema);
			for (const [index, branch] of branches.entries()) {
				const resolved = model.resolve(branch);
				if (!refId(branch) || resolved.type !== "object")
					errors.push(`${path}|${index}: keyed branches must be named objects`);
				else if (!keys[index])
					errors.push(
						`${path}|${index}: keyed branch needs a required key no other branch declares`,
					);
			}
			return;
		}
		const tag = schema[TAG_KEY];
		if (typeof tag === "string") {
			const optional = branches.filter((branch) =>
				model.tagOptional(branch, tag),
			).length;
			if (optional > 1)
				errors.push(`${path}: at most one branch may omit "${tag}"`);
			const seen: unknown[] = [];
			for (const [index, branch] of branches.entries()) {
				const values = model.tagValues(branch, tag);
				if (!values) {
					errors.push(
						`${path}|${index}: tagged branch lacks a required literal "${tag}"`,
					);
					continue;
				}
				const id = refId(branch);
				if (id) branchRefs.set(id, (branchRefs.get(id) ?? 0) + 1);
				else
					errors.push(
						`${path}|${index}: tagged branches must carry .meta({ id })`,
					);
				seen.push(...values);
			}
			const allBooleans = seen.every((value) => typeof value === "boolean");
			const allStrings = seen.every((value) => typeof value === "string");
			if (new Set(seen).size !== seen.length)
				errors.push(`${path}: duplicate "${tag}" values`);
			if (allBooleans && seen.length !== 2)
				errors.push(`${path}: boolean tags need exactly true and false`);
			if (allBooleans && optional > 0)
				errors.push(`${path}: a boolean tag cannot be optional`);
			if (!allBooleans && !allStrings)
				errors.push(`${path}: tag values must be all strings or booleans`);
			return;
		}
		const kinds = branches.map((branch) => kindOf(model, branch));
		const distinct =
			new Set(kinds).size === kinds.length &&
			!kinds.includes("union") &&
			!kinds.includes("any");
		if (!distinct && decoded)
			errors.push(
				`${path}: untagged union in a Rust decode position needs tagged() or distinct JSON kinds`,
			);
	};

	for (const [id, schema] of Object.entries(model.defs)) {
		visit(schema, id, model.decoded.has(id));
	}

	// A tagged branch omits its tag field in Rust, so it may only be used as a
	// union branch.
	for (const [id, count] of branchRefs) {
		if ((allRefs.get(id) ?? 0) !== count)
			errors.push(
				`${id}: tagged-union branches must not be referenced elsewhere`,
			);
	}
	for (const [name, entry] of Object.entries(model.methods)) {
		for (const slot of [entry.params, entry.result]) {
			const id = slot ? refId(slot) : null;
			if (slot && !id?.length)
				errors.push(`${name}: catalog slot must reference ${DEFS_PREFIX}`);
			if (id && branchRefs.has(id))
				errors.push(`${name}: catalog slot ${id} is a tagged-union branch`);
		}
	}
	return errors;
};
