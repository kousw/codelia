import { z } from "zod";

/** Config file layer. `project` is `<workspace>/.codelia/config.json`. */
export const ConfigScopeSchema = z
	.enum(["global", "project"])
	.meta({ id: "ConfigScope" });
export type ConfigScope = z.infer<typeof ConfigScopeSchema>;

/** Where an effective value came from. */
export const ConfigValueSourceSchema = z
	.enum(["default", "global", "project"])
	.meta({ id: "ConfigValueSource" });
export type ConfigValueSource = z.infer<typeof ConfigValueSourceSchema>;

export const ConfigValueTypeSchema = z
	.enum(["boolean", "integer", "string", "enum"])
	.meta({ id: "ConfigValueType" });
export type ConfigValueType = z.infer<typeof ConfigValueTypeSchema>;

export const ConfigScalarSchema = z
	.union([z.string(), z.number(), z.boolean()])
	.meta({ id: "ConfigScalar" });
export type ConfigScalar = z.infer<typeof ConfigScalarSchema>;

export const ConfigEntrySchema = z
	.object({
		/** Dotted key, e.g. `search.mode`. Only registry keys are exposed. */
		key: z.string(),
		/** Effective value; null when unset and runtime has no fixed default. */
		value: ConfigScalarSchema.nullable(),
		source: ConfigValueSourceSchema,
		/** Value in the global file, when set there. */
		global: ConfigScalarSchema.optional(),
		/** Value in the project file, when set there. */
		project: ConfigScalarSchema.optional(),
		type: ConfigValueTypeSchema,
		enum: z.array(ConfigScalarSchema).optional(),
		min: z.number().optional(),
		max: z.number().optional(),
		/** Scope runtime writes the group to when a client has no preference. */
		default_scope: ConfigScopeSchema,
		/** False: read-only here; change it through `write_via`. */
		writable: z.boolean(),
		write_via: z.string().optional(),
	})
	.meta({ id: "ConfigEntry" });
export type ConfigEntry = z.infer<typeof ConfigEntrySchema>;

export const ConfigGetParamsSchema = z
	.object({
		/** Omitted returns every registry key. */
		keys: z.array(z.string()).optional(),
	})
	.meta({ id: "ConfigGetParams" });
export type ConfigGetParams = z.infer<typeof ConfigGetParamsSchema>;

export const ConfigPathsSchema = z
	.object({ global: z.string(), project: z.string().nullable() })
	.meta({ id: "ConfigPaths" });

export const ConfigLayerErrorSchema = z
	.object({ scope: ConfigScopeSchema, message: z.string() })
	.meta({ id: "ConfigLayerError" });

export const ConfigGetResultSchema = z
	.object({
		paths: ConfigPathsSchema,
		entries: z.array(ConfigEntrySchema),
		/** Unreadable layers (treated as empty); messages contain no file contents. */
		errors: z.array(ConfigLayerErrorSchema).optional(),
	})
	.meta({ id: "ConfigGetResult" });
export type ConfigGetResult = z.infer<typeof ConfigGetResultSchema>;

export const ConfigSetParamsSchema = z
	.object({
		scope: ConfigScopeSchema,
		key: z.string(),
		/** Required unless `unset` is true. */
		value: ConfigScalarSchema.optional(),
		/** Remove the key from that file (empty parent objects are pruned). */
		unset: z.boolean().optional(),
	})
	.meta({ id: "ConfigSetParams" });
export type ConfigSetParams = z.infer<typeof ConfigSetParamsSchema>;

export const ConfigSetResultSchema = z
	.object({
		key: z.string(),
		scope: ConfigScopeSchema,
		path: z.string(),
		entry: ConfigEntrySchema,
		/** When the change takes effect: the next `run.start` rebuilds the agent. */
		applies: z.literal("next_run"),
	})
	.meta({ id: "ConfigSetResult" });
export type ConfigSetResult = z.infer<typeof ConfigSetResultSchema>;
