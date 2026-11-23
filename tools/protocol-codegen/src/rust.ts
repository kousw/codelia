// Step 3: JSON Schema subset -> Rust types for crates/tui/src/protocol.
// Compatibility rules are encoded here (spec section 6):
// - unknown fields are ignored (never deny_unknown_fields)
// - string enums are open (`Unknown(String)`)
// - string-tagged unions keep `Unknown(Value)` for new variants, but a known
//   tag decodes strictly and reports its error
// - optional nullable fields follow their declared presence
// - keyed unions pick the branch by its identifying key
import {
	branchesOf,
	ENCODE_KEY,
	KEYED_KEY,
	nullableInner,
	PRESENCE_KEY,
	refId,
	type SchemaModel,
	TAG_KEY,
} from "./model";
import type { JsonSchema, MethodEntry } from "./schema";

const RUST_KEYWORDS = new Set([
	"as",
	"async",
	"await",
	"break",
	"const",
	"continue",
	"crate",
	"dyn",
	"else",
	"enum",
	"extern",
	"false",
	"fn",
	"for",
	"if",
	"impl",
	"in",
	"let",
	"loop",
	"match",
	"mod",
	"move",
	"mut",
	"pub",
	"ref",
	"return",
	"static",
	"struct",
	"trait",
	"true",
	"type",
	"unsafe",
	"use",
	"where",
	"while",
]);

export const pascal = (value: string): string => {
	const name = value
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((part) => part[0].toUpperCase() + part.slice(1))
		.join("");
	return /^[0-9]/.test(name) ? `V${name}` : name || "Empty";
};

const VALUE = "serde_json::Value";
const MAP = "serde_json::Map<String, serde_json::Value>";

const docLines = (text: unknown, indent = ""): string[] =>
	typeof text === "string" && text.trim()
		? text
				.trim()
				.split("\n")
				.map((line) => `${indent}/// ${line.trimEnd()}`.trimEnd())
		: [];

const isOpaque = (schema: JsonSchema) => Object.keys(schema).length === 0;

type Emitted = { code: string; serializeOnly: boolean };

export type RustOutput = { code: string; errors: string[] };

export const emitRust = (
	model: SchemaModel,
	options: { protocolVersion: string; rpcErrorCodes: Record<string, number> },
): RustOutput => {
	const items = new Map<string, Emitted>();
	const reserved = new Set<string>();
	const errors: string[] = [];
	const tagOmit = new Map<string, Set<string>>();

	// Pre-pass: a struct used as a tagged branch drops the tag fields owned by
	// the enclosing unions.
	const collectTags = (id: string, inherited: Set<string>) => {
		const schema = model.defs[id];
		const tag = schema[TAG_KEY];
		const branches = branchesOf(schema);
		if (typeof tag !== "string" || !branches) return;
		const omit = new Set([...inherited, tag]);
		for (const branch of branches) {
			const branchId = refId(branch);
			if (!branchId) continue;
			const set = tagOmit.get(branchId) ?? new Set<string>();
			for (const key of omit) set.add(key);
			tagOmit.set(branchId, set);
			collectTags(branchId, omit);
		}
	};
	for (const id of Object.keys(model.defs)) collectTags(id, new Set());

	const claim = (name: string, owner: string): boolean => {
		if (reserved.has(name)) {
			errors.push(`${owner}: Rust name ${name} is already used`);
			return false;
		}
		reserved.add(name);
		return true;
	};

	const serializeOnly = (name: string): boolean =>
		items.get(name)?.serializeOnly ?? false;

	const typeOf = (schema: JsonSchema, hint: string): string => {
		const id = refId(schema);
		if (id) {
			emitDef(id);
			return id;
		}
		const inner = nullableInner(schema);
		if (inner) return `Option<${typeOf(inner, hint)}>`;
		if (branchesOf(schema)) {
			emitUnion(hint, schema, new Set());
			return hint;
		}
		if (Array.isArray(schema.enum)) {
			emitEnum(hint, schema);
			return hint;
		}
		// A string literal outside a tag is validated on decode.
		if (typeof schema.const === "string") return literalType(schema.const);
		// A boolean literal is validated on decode (e.g. `ok: true`).
		if (typeof schema.const === "boolean") return `ConstBool<${schema.const}>`;
		switch (schema.type) {
			case "string":
				return "String";
			case "integer":
				return "i64";
			case "number":
				// wireCount(): any number is accepted, but this client sends integers.
				return schema[ENCODE_KEY] === "integer" ? "i64" : "f64";
			case "boolean":
				return "bool";
			case "array":
				return `Vec<${typeOf(schema.items ?? {}, `${hint}Item`)}>`;
			case "object": {
				if (!schema.properties) {
					const value = schema.additionalProperties;
					return value && typeof value === "object" && !isOpaque(value)
						? `std::collections::BTreeMap<String, ${typeOf(value, `${hint}Value`)}>`
						: MAP;
				}
				emitStruct(hint, schema, new Set());
				return hint;
			}
			default:
				if (isOpaque(schema)) return VALUE;
				errors.push(`${hint}: unsupported schema ${JSON.stringify(schema)}`);
				return VALUE;
		}
	};

	/** Unit type that only (de)serializes one string value. */
	const literalType = (value: string): string => {
		const name = `Lit${pascal(value)}`;
		if (items.has(name)) return name;
		if (!claim(name, `literal ${JSON.stringify(value)}`)) return "String";
		const json = JSON.stringify(value);
		items.set(name, {
			code: `/// The string literal \`${json}\`. Decoding any other value fails.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub(crate) struct ${name};
impl Serialize for ${name} {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(${json})
    }
}
impl<'de> Deserialize<'de> for ${name} {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == ${json} {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(${JSON.stringify(`expected ${json}`)}))
        }
    }
}`,
			serializeOnly: false,
		});
		return name;
	};

	const emitDef = (id: string) => {
		if (reserved.has(id)) return;
		const schema = model.defs[id];
		const omit = tagOmit.get(id) ?? new Set<string>();
		if (schema.type === "object" && schema.properties) {
			emitStruct(id, schema, omit);
		} else if (branchesOf(schema) && !nullableInner(schema)) {
			emitUnion(id, schema, omit);
		} else if (Array.isArray(schema.enum)) {
			emitEnum(id, schema);
		} else {
			if (!claim(id, id)) return;
			// A named string literal (the protocol version) stays a String so a
			// peer's mismatched value can still be read and reported.
			const target =
				typeof schema.const === "string"
					? "String"
					: typeOf(
							{ ...schema, description: undefined } as JsonSchema,
							`${id}Inner`,
						);
			const note =
				typeof schema.const === "string"
					? [`/// Always ${JSON.stringify(schema.const)}.`]
					: [];
			items.set(id, {
				code: [
					...docLines(schema.description),
					...note,
					`pub(crate) type ${id} = ${target};`,
				].join("\n"),
				serializeOnly: false,
			});
		}
	};

	const emitStruct = (name: string, schema: JsonSchema, omit: Set<string>) => {
		if (!claim(name, name)) return;
		const required = new Set(schema.required ?? []);
		const lines: string[] = [];
		for (const [field, raw] of Object.entries(schema.properties ?? {})) {
			if (omit.has(field)) continue;
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
				errors.push(`${name}.${field}: field name is not a Rust identifier`);
				continue;
			}
			// camelCase wire names keep their spelling through serde rename.
			const snake = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
			const ident = RUST_KEYWORDS.has(snake) ? `r#${snake}` : snake;
			const hint = `${name}${pascal(snake)}`;
			lines.push(...docLines(raw.description, "    "));
			if (snake !== field)
				lines.push(`    #[serde(rename = ${JSON.stringify(field)})]`);
			if (typeof raw.const === "string")
				lines.push(`    /// Always ${JSON.stringify(raw.const)}.`);
			const inner = nullableInner(raw);
			if (!required.has(field)) {
				const presence = raw[PRESENCE_KEY];
				if (inner && presence === "tri-state") {
					lines.push(
						`    #[serde(default, skip_serializing_if = "Patch::is_absent")]`,
						`    pub(crate) ${ident}: Patch<${typeOf(inner, hint)}>,`,
					);
				} else if (!inner && isOpaque(raw)) {
					// An optional opaque value accepts null; keep it distinct
					// from absence so it round-trips.
					lines.push(
						`    #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]`,
						`    pub(crate) ${ident}: Option<${VALUE}>,`,
					);
				} else {
					const target = inner ? typeOf(inner, hint) : typeOf(raw, hint);
					lines.push(
						`    #[serde(default, skip_serializing_if = "Option::is_none")]`,
						`    pub(crate) ${ident}: Option<${target}>,`,
					);
				}
				continue;
			}
			const target = typeOf(raw, hint);
			// A required opaque value must be present, as in Zod; an explicit
			// `null` is a value. serde reports the missing key itself.
			// serde treats a missing Option field as None; a required nullable
			// key must be present, so it uses an explicit deserializer.
			if (inner)
				lines.push(
					'    #[serde(deserialize_with = "deserialize_required_nullable")]',
				);
			lines.push(`    pub(crate) ${ident}: ${target},`);
		}
		const extra = schema.additionalProperties;
		if (extra && typeof extra === "object") {
			lines.push(
				"    /// Open extension object: unknown keys are kept.",
				"    #[serde(flatten)]",
				`    pub(crate) extra: ${MAP},`,
			);
		}
		// Structs without required fields can be built with `..Default::default()`.
		const derives =
			required.size === 0
				? "Clone, Debug, Default, PartialEq, Serialize, Deserialize"
				: "Clone, Debug, PartialEq, Serialize, Deserialize";
		items.set(name, {
			code: [
				...docLines(schema.description),
				`#[derive(${derives})]`,
				`pub(crate) struct ${name} {`,
				...lines,
				"}",
			].join("\n"),
			serializeOnly: false,
		});
	};

	const emitEnum = (name: string, schema: JsonSchema) => {
		if (!claim(name, name)) return;
		const values = (schema.enum ?? []).map(String);
		const variants = values.map((value) => [pascal(value), value] as const);
		if (new Set(variants.map(([variant]) => variant)).size !== values.length)
			errors.push(`${name}: enum values collide as Rust variants`);
		const doc = docLines(schema.description);
		// A wire value named "unknown" takes that variant; the fallback becomes `Other`.
		const fallback = variants.some(([variant]) => variant === "Unknown")
			? "Other"
			: "Unknown";
		items.set(name, {
			code: `${doc.length ? `${doc.join("\n")}\n` : ""}/// Open string enum: values added by newer peers decode as \`${fallback}\`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub(crate) enum ${name} {
${variants.map(([variant]) => `    ${variant},`).join("\n")}
    ${fallback}(String),
}
impl ${name} {
    pub(crate) fn as_str(&self) -> &str {
        match self {
${variants.map(([variant, value]) => `            Self::${variant} => ${JSON.stringify(value)},`).join("\n")}
            Self::${fallback}(value) => value,
        }
    }
}
impl From<String> for ${name} {
    fn from(value: String) -> Self {
        match value.as_str() {
${variants.map(([variant, value]) => `            ${JSON.stringify(value)} => Self::${variant},`).join("\n")}
            _ => Self::${fallback}(value),
        }
    }
}
impl From<${name}> for String {
    fn from(value: ${name}) -> Self {
        match value {
            ${name}::${fallback}(value) => value,
            known => known.as_str().to_owned(),
        }
    }
}`,
			serializeOnly: false,
		});
	};

	const commonPrefix = (names: string[]): string => {
		const words = names.map((name) => name.match(/[A-Z][a-z0-9]*/g) ?? []);
		const prefix: string[] = [];
		for (let index = 0; ; index++) {
			const word = words[0][index];
			if (!word || words.some((list) => list[index] !== word)) break;
			if (words.some((list) => list.length <= index + 1)) break;
			prefix.push(word);
		}
		return prefix.join("");
	};

	const emitUnion = (name: string, schema: JsonSchema, omit: Set<string>) => {
		if (!claim(name, name)) return;
		const branches = branchesOf(schema) ?? [];
		const tag = schema[TAG_KEY];
		const doc = docLines(schema.description);
		if (schema[KEYED_KEY] === true) {
			const named = branches.map((branch) => {
				const id = refId(branch) ?? "";
				if (id) emitDef(id);
				return id;
			});
			emitKeyedUnion(name, named, model.branchKeys(schema), doc);
			return;
		}
		if (typeof tag === "string") {
			const named = branches.map((branch) => {
				const id = refId(branch);
				if (!id) {
					errors.push(`${name}: tagged branches must be named`);
					return "";
				}
				emitDef(id);
				return id;
			});
			const values = branches.map(
				(branch) => model.tagValues(branch, tag) ?? [],
			);
			if (values.flat().every((value) => typeof value === "boolean")) {
				emitBooleanUnion(name, tag, named, values, doc);
			} else {
				const fallback = branches.findIndex((branch) =>
					model.tagOptional(branch, tag),
				);
				emitStringUnion(name, tag, named, values, doc, fallback);
			}
			void omit;
			return;
		}
		const encodeOnly = !model.decoded.has(name) && model.encoded.has(name);
		const variants = branches.map((branch, index) => {
			const target = typeOf(branch, `${name}V${index}`);
			const label =
				target === "String"
					? "Text"
					: target.startsWith("Vec<")
						? "List"
						: target === "i64"
							? "Integer"
							: target === "f64"
								? "Number"
								: target === "bool"
									? "Bool"
									: target === MAP
										? "Object"
										: target === VALUE
											? "Value"
											: /^Lit[A-Z]/.test(target)
												? target.slice(3)
												: pascal(target);
			return `    ${label}(${target}),`;
		});
		items.set(name, {
			code: [
				...doc,
				encodeOnly
					? "/// Encode-only union: the client sends it and never decodes it."
					: "/// Untagged union of distinct JSON kinds.",
				encodeOnly
					? "#[derive(Clone, Debug, PartialEq, Serialize)]"
					: "#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]",
				"#[serde(untagged)]",
				`pub(crate) enum ${name} {`,
				...variants,
				"}",
			].join("\n"),
			serializeOnly: encodeOnly,
		});
	};

	const emitStringUnion = (
		name: string,
		tag: string,
		branches: string[],
		values: unknown[][],
		doc: string[],
		fallback = -1,
	) => {
		const variants: string[] = [];
		const arms: string[] = [];
		branches.forEach((branch, index) => {
			const value = String(values[index][0]);
			// A nested union shares one outer tag value across its branches.
			const variant = pascal(value);
			variants.push(
				`    #[serde(rename = ${JSON.stringify(value)})]`,
				`    ${variant}(${branch}),`,
			);
			arms.push(
				`            ${JSON.stringify(value)} => Self::${variant}(
                serde_json::from_value(value).map_err(|error| {
                    D::Error::custom(format_args!("{} {:?}: {}", ${JSON.stringify(tag)}, ${JSON.stringify(value)}, error))
                })?,
            ),`,
			);
		});
		items.set(name, {
			code: `${doc.length ? `${doc.join("\n")}\n` : ""}/// Tagged on the string \`${tag}\`. A known tag decodes strictly; an unknown
/// string decodes as \`Unknown\` with the raw value. ${fallback >= 0 ? `A missing tag decodes as\n/// \`${pascal(String(values[fallback][0]))}\`; a non-string tag is an error.` : "A missing or non-string\n/// tag is an error."}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = ${JSON.stringify(tag)})]
pub(crate) enum ${name} {
${variants.join("\n")}
    #[serde(untagged)]
    Unknown(serde_json::Value),
}
impl<'de> Deserialize<'de> for ${name} {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = serde_json::Value::deserialize(deserializer)?;
        let tag = match value.get(${JSON.stringify(tag)}) {
            Some(serde_json::Value::String(tag)) => tag.clone(),
${
	fallback >= 0
		? `            None => ${JSON.stringify(String(values[fallback][0]))}.to_owned(),
`
		: ""
}            _ => return Err(D::Error::custom(${JSON.stringify(`missing or non-string tag \`${tag}\``)})),
        };
        Ok(match tag.as_str() {
${arms.join("\n")}
            _ => Self::Unknown(value),
        })
    }
}`,
			serializeOnly: false,
		});
	};

	const emitKeyedUnion = (
		name: string,
		branches: string[],
		keys: (string | null)[],
		doc: string[],
	) => {
		const prefix = commonPrefix(branches);
		const cases = branches.map((branch, index) => ({
			branch,
			key: keys[index] ?? "",
			variant: branch.slice(prefix.length) || branch,
		}));
		items.set(name, {
			code: `${doc.length ? `${doc.join("\n")}\n` : ""}/// Keyed union: like the Zod union, the first branch (in declared order) that
/// decodes wins. Each branch has a required key no other branch declares.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub(crate) enum ${name} {
${cases.map(({ variant, branch, key }) => `    /// Has \`${key}\`.\n    ${variant}(${branch}),`).join("\n")}
}
impl<'de> Deserialize<'de> for ${name} {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = serde_json::Value::deserialize(deserializer)?;
        let mut reported = None;
${cases
	.map(
		({
			variant,
			branch,
			key,
		}) => `        match serde_json::from_value::<${branch}>(value.clone()) {
            Ok(branch) => return Ok(Self::${variant}(branch)),
            Err(error) if reported.is_none() && value.get(${JSON.stringify(key)}).is_some() => {
                reported = Some(format!("{}: {}", ${JSON.stringify(key)}, error));
            }
            Err(_) => {}
        }`,
	)
	.join("\n")}
        Err(D::Error::custom(reported.unwrap_or_else(|| {
            ${JSON.stringify(`none of the identifying keys of ${name} is present`)}.to_owned()
        })))
    }
}`,
			serializeOnly: false,
		});
	};

	const emitBooleanUnion = (
		name: string,
		tag: string,
		branches: string[],
		values: unknown[][],
		doc: string[],
	) => {
		const prefix = commonPrefix(branches);
		const cases = branches.map((branch, index) => ({
			branch,
			value: values[index][0] === true,
			variant: branch.slice(prefix.length) || branch,
		}));
		items.set(name, {
			code: `${doc.length ? `${doc.join("\n")}\n` : ""}/// Tagged on the boolean \`${tag}\`. A missing or non-boolean tag is an error.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ${name} {
${cases.map(({ variant, branch, value }) => `    /// \`${tag}: ${value}\`\n    ${variant}(${branch}),`).join("\n")}
}
impl Serialize for ${name} {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::Error;
        let (tag, value) = match self {
${cases.map(({ variant, value }) => `            Self::${variant}(inner) => (${value}, serde_json::to_value(inner).map_err(S::Error::custom)?),`).join("\n")}
        };
        let serde_json::Value::Object(mut map) = value else {
            return Err(S::Error::custom("tagged variant must serialize as an object"));
        };
        map.insert(${JSON.stringify(tag)}.to_owned(), serde_json::Value::Bool(tag));
        map.serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for ${name} {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = serde_json::Value::deserialize(deserializer)?;
        match value.get(${JSON.stringify(tag)}).and_then(serde_json::Value::as_bool) {
${cases
	.map(
		({
			variant,
			value,
		}) => `            Some(${value}) => Ok(Self::${variant}(serde_json::from_value(value).map_err(|error| {
                D::Error::custom(format_args!("{} {}: {}", ${JSON.stringify(tag)}, ${value}, error))
            })?)),`,
	)
	.join("\n")}
            None => Err(D::Error::custom(${JSON.stringify(`missing or non-boolean tag \`${tag}\``)})),
        }
    }
}`,
			serializeOnly: false,
		});
	};

	for (const id of Object.keys(model.defs).sort()) emitDef(id);

	// ---- method layer ------------------------------------------------------
	const methods = Object.entries(model.methods).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	const typeFor = (slot: JsonSchema | undefined, method: string): string => {
		const id = slot ? refId(slot) : null;
		if (!id) {
			errors.push(`${method}: catalog slot must be a named schema`);
			return VALUE;
		}
		return id;
	};
	const markers: string[] = [];
	const notifications: [string, string, string][] = [];
	const serverRequests: [string, string, string][] = [];
	const clientParams: [string, string][] = [];
	const clientResults: [string, string][] = [];
	const serverResults: [string, string][] = [];
	const capabilityOf = (value: string | undefined) =>
		value ? `Some(${JSON.stringify(value)})` : "None";
	for (const [method, entry] of methods as [string, MethodEntry][]) {
		const variant = pascal(method);
		const params = typeFor(entry.params, method);
		if (entry.from === "ui" && entry.kind === "request") {
			const result = typeFor(entry.result, method);
			markers.push(`    /// \`${method}\` request (UI -> runtime).
    pub(crate) struct ${variant};
    impl ClientRequest for ${variant} {
        const METHOD: &'static str = ${JSON.stringify(method)};
        const CAPABILITY: Option<&'static str> = ${capabilityOf(entry.capability)};
        type Params = ${params};
        type Result = ${result};
    }`);
			if (!serializeOnly(params)) clientParams.push([method, params]);
			clientResults.push([method, result]);
		} else if (entry.from === "ui") {
			markers.push(`    /// \`${method}\` notification (UI -> runtime).
    pub(crate) struct ${variant};
    impl ClientNotification for ${variant} {
        const METHOD: &'static str = ${JSON.stringify(method)};
        type Params = ${params};
    }`);
			if (!serializeOnly(params)) clientParams.push([method, params]);
		} else if (entry.kind === "request") {
			const result = typeFor(entry.result, method);
			markers.push(`    /// Reply to the \`${method}\` request (runtime -> UI).
    pub(crate) struct ${variant};
    impl ServerRequestReply for ${variant} {
        const METHOD: &'static str = ${JSON.stringify(method)};
        const UI_CAPABILITY: Option<&'static str> = ${capabilityOf(entry.uiCapability)};
        type Result = ${result};
    }`);
			serverRequests.push([variant, method, params]);
			if (!serializeOnly(result)) serverResults.push([method, result]);
		} else {
			notifications.push([variant, method, params]);
		}
	}

	const decodeEnum = (
		name: string,
		doc: string,
		entries: [string, string, string][],
	) => `/// ${doc}
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ${name} {
${entries.map(([variant, , params]) => `    ${variant}(${params}),`).join("\n")}
    /// A method this client does not know; ignore it or use the generic fallback.
    Unknown { method: String, params: serde_json::Value },
}
impl ${name} {
    pub(crate) fn decode(method: &str, params: serde_json::Value) -> Result<Self, DecodeError> {
        Ok(match method {
${entries.map(([variant, m]) => `            ${JSON.stringify(m)} => Self::${variant}(DecodeError::decode(method, params)?),`).join("\n")}
            _ => Self::Unknown { method: method.to_owned(), params },
        })
    }

    /// The params encoded back to JSON (unknown fields are not kept).
    pub(crate) fn params(&self) -> serde_json::Value {
        match self {
${entries.map(([variant]) => `            Self::${variant}(params) => serde_json::to_value(params).unwrap_or(serde_json::Value::Null),`).join("\n")}
            Self::Unknown { params, .. } => params.clone(),
        }
    }
}`;

	const roundtrip = (
		fn: string,
		entries: [string, string][],
	) => `    pub(crate) fn ${fn}(method: &str, value: serde_json::Value) -> Option<Result<serde_json::Value, serde_json::Error>> {
        Some(match method {
${entries.map(([method, type]) => `            ${JSON.stringify(method)} => roundtrip::<${type}>(value),`).join("\n")}
            _ => return None,
        })
    }`;

	const errorCodes = Object.entries(options.rpcErrorCodes)
		.map(([key, value]) => `    pub(crate) const ${key}: i64 = ${value};`)
		.join("\n");

	const methodLayer = `/// Request sent by this client (UI -> runtime).
pub(crate) trait ClientRequest {
    const METHOD: &'static str;
    /// Server capability the client checks before sending, if any.
    const CAPABILITY: Option<&'static str>;
    type Params: Serialize;
    type Result: serde::de::DeserializeOwned;
}

/// Notification sent by this client (UI -> runtime).
pub(crate) trait ClientNotification {
    const METHOD: &'static str;
    type Params: Serialize;
}

/// Result this client returns for a runtime -> UI request.
pub(crate) trait ServerRequestReply {
    const METHOD: &'static str;
    /// UI capability the runtime checks before sending, if any.
    const UI_CAPABILITY: Option<&'static str>;
    type Result: Serialize;
}

/// Method markers generated from the catalog.
pub(crate) mod methods {
    use super::*;

${markers.join("\n\n")}
}

${decodeEnum("ServerNotification", "Runtime -> UI notification, decoded by method name.", notifications)}

${decodeEnum("ServerRequest", "Runtime -> UI request params, decoded by method name.", serverRequests)}

/// JSON-RPC error codes from \`RPC_ERROR_CODE\`.
pub(crate) mod rpc_error_code {
${errorCodes}
}

/// Typed round trips used by the shared fixture tests.
#[cfg(test)]
pub(crate) mod fixture_support {
    use super::*;

    fn roundtrip<T: Serialize + serde::de::DeserializeOwned>(
        value: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Error> {
        let typed: T = serde_json::from_value(value)?;
        serde_json::to_value(typed)
    }

${roundtrip("client_params", clientParams)}

${roundtrip("client_result", clientResults)}

${roundtrip("server_result", serverResults)}
}`;

	const header = `// @generated by tools/protocol-codegen (bun run generate:protocol). Do not edit.
// Source: the @codelia/protocol method catalog. Spec: dev-docs/specs/protocol-codegen.md.
#![allow(dead_code, clippy::large_enum_variant, clippy::enum_variant_names)]

use super::{deserialize_present, deserialize_required_nullable, ConstBool, DecodeError, Patch};
use serde::{Deserialize, Serialize};

pub(crate) const PROTOCOL_VERSION: &str = ${JSON.stringify(options.protocolVersion)};`;

	const body = [...items.keys()]
		.sort()
		.map((name) => items.get(name)?.code)
		.join("\n\n");
	return {
		code: `${header}\n\n${body}\n\n${methodLayer}\n`,
		errors,
	};
};
