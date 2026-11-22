import type { SkillCatalog } from "@codelia/shared-types";
import { wireInt } from "@codelia/shared-types";
import { z } from "zod";

// Wire shapes of the shared-types skill schemas. Those keep their runtime
// validation (strict objects, non-empty strings), which the wire subset does
// not carry; tests/protocol-catalog.test.ts checks that the types stay equal.

export const SkillMetadataWireSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		description: z.string(),
		path: z.string(),
		dir: z.string(),
		scope: z.enum(["repo", "user"]),
		mtime_ms: wireInt(),
	})
	.meta({ id: "SkillMetadata" });

export const SkillLoadErrorWireSchema = z
	.object({ path: z.string(), message: z.string() })
	.meta({ id: "SkillLoadError" });

export const SkillCatalogWireSchema = z
	.object({
		skills: z.array(SkillMetadataWireSchema),
		errors: z.array(SkillLoadErrorWireSchema),
		truncated: z.boolean(),
	})
	.meta({ id: "SkillCatalog" });

export const SkillsListParamsSchema = z
	.object({
		cwd: z.string().optional(),
		force_reload: z.boolean().optional(),
	})
	.meta({ id: "SkillsListParams" });
export type SkillsListParams = z.infer<typeof SkillsListParamsSchema>;

export const SkillsListResultSchema = SkillCatalogWireSchema;
export type SkillsListResult = SkillCatalog;
