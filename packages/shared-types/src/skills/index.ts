import type { z } from "zod";
import {
	SkillCatalogSchema,
	SkillLoadErrorSchema,
	SkillMetadataSchema,
	SkillScopeSchema,
	SkillSearchReasonSchema,
	SkillSearchResultSchema,
} from "./schema";

export type SkillScope = z.infer<typeof SkillScopeSchema>;
export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;
export type SkillLoadError = z.infer<typeof SkillLoadErrorSchema>;
export type SkillCatalog = z.infer<typeof SkillCatalogSchema>;
export type SkillSearchReason = z.infer<typeof SkillSearchReasonSchema>;
export type SkillSearchResult = z.infer<typeof SkillSearchResultSchema>;

export {
	SkillScopeSchema,
	SkillMetadataSchema,
	SkillLoadErrorSchema,
	SkillCatalogSchema,
	SkillSearchReasonSchema,
	SkillSearchResultSchema,
};
