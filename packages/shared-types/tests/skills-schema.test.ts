import { describe, expect, test } from "bun:test";
import {
	SkillCatalogSchema,
	SkillMetadataSchema,
	SkillSearchResultSchema,
} from "../src";

describe("@codelia/shared-types skills schema", () => {
	test("SkillMetadataSchema parses valid payload", () => {
		const parsed = SkillMetadataSchema.parse({
			id: "skill_1",
			name: "repo-review",
			description: "Review with risk checklist.",
			path: "/repo/.agents/skills/repo-review/SKILL.md",
			dir: "/repo/.agents/skills/repo-review",
			scope: "repo",
			mtime_ms: 1738972800000,
		});
		expect(parsed.name).toBe("repo-review");
	});

	test("SkillCatalogSchema rejects unknown properties", () => {
		expect(() =>
			SkillCatalogSchema.parse({
				skills: [],
				errors: [],
				truncated: false,
				extra: true,
			}),
		).toThrow();
	});

	test("SkillSearchResultSchema requires known reason values", () => {
		expect(() =>
			SkillSearchResultSchema.parse({
				skill: SkillMetadataSchema.parse({
					id: "skill_1",
					name: "repo-review",
					description: "Review with risk checklist.",
					path: "/repo/.agents/skills/repo-review/SKILL.md",
					dir: "/repo/.agents/skills/repo-review",
					scope: "repo",
					mtime_ms: 1738972800000,
				}),
				score: 100,
				reason: "fuzzy",
			}),
		).toThrow();
	});
});
