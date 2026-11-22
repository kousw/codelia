// Helpers for protocol wire schemas. The Rust generator in
// tools/protocol-codegen reads the metadata these helpers attach, so it never
// has to guess what null means or which key discriminates a union.
// See dev-docs/specs/protocol-codegen.md section 3.
import { z } from "zod";

/** JSON Schema key that states what `null` means on an optional field. */
export const WIRE_PRESENCE_KEY = "x-codelia-presence";
/** JSON Schema key that names the discriminator of a tagged union. */
export const WIRE_TAG_KEY = "x-codelia-tag";
/** JSON Schema key that marks a union told apart by a required key. */
export const WIRE_KEYED_KEY = "x-codelia-keyed";

/** Integer on the wire: counters, sequence numbers, sizes, ms timestamps. */
export const wireInt = () => z.int();

/** Optional field where absent keeps, `null` clears and a value sets. */
export const clearable = <T extends z.ZodType>(schema: T) =>
	schema
		.nullable()
		.optional()
		.meta({ [WIRE_PRESENCE_KEY]: "tri-state" });

/** Optional field where absent and `null` both mean "not reported". */
export const nullish = <T extends z.ZodType>(schema: T) =>
	schema
		.nullable()
		.optional()
		.meta({ [WIRE_PRESENCE_KEY]: "collapse" });

/**
 * Union discriminated by a literal at `tag`. Branch literals are unique
 * strings, or exactly `true` and `false`. One string-tagged branch may make
 * its literal optional; a value without the tag then belongs to it (for
 * payloads written before the tag existed). Every tagged union is a named wire
 * type, so `meta.id` is required.
 */
export const tagged = <
	Tag extends string,
	const Branches extends readonly [
		z.core.$ZodTypeDiscriminable<Tag>,
		...z.core.$ZodTypeDiscriminable<Tag>[],
	],
>(
	tag: Tag,
	branches: Branches,
	meta: { id: string; description?: string },
) => z.discriminatedUnion(tag, branches).meta({ ...meta, [WIRE_TAG_KEY]: tag });

/**
 * Union of named object branches without a shared discriminator. Each branch
 * must have a required key that no other branch declares; receivers pick the
 * branch by which of those keys is present. Prefer `tagged` for new shapes.
 */
export const keyed = <
	const Branches extends readonly [z.ZodObject, z.ZodObject, ...z.ZodObject[]],
>(
	branches: Branches,
	meta: { id: string; description?: string },
) => z.union(branches).meta({ ...meta, [WIRE_KEYED_KEY]: true });
