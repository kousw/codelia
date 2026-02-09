import { z } from "zod";

export const SkillScopeSchema = z.enum(["repo", "user"]);

export const SkillMetadataSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		description: z.string().min(1),
		path: z.string().min(1),
		dir: z.string().min(1),
		scope: SkillScopeSchema,
		mtime_ms: z.number().int().nonnegative(),
	})
	.strict();

export const SkillLoadErrorSchema = z
	.object({
		path: z.string().min(1),
		message: z.string().min(1),
	})
	.strict();

export const SkillCatalogSchema = z
	.object({
		skills: z.array(SkillMetadataSchema),
		errors: z.array(SkillLoadErrorSchema),
		truncated: z.boolean(),
	})
	.strict();

export const SkillSearchReasonSchema = z.enum([
	"exact_name",
	"exact_path",
	"prefix",
	"token_overlap",
]);

export const SkillSearchResultSchema = z
	.object({
		skill: SkillMetadataSchema,
		score: z.number(),
		reason: SkillSearchReasonSchema,
	})
	.strict();
