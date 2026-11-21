import { describe, expect, test } from "bun:test";
import { matchBashRule, matchToolRule } from "../src/permissions/utils";

describe("configured deny rules", () => {
	test("matches shell command prefixes at a token boundary, including bash rules", () => {
		const rule = { tool: "bash", command: "git clean" };
		expect(matchBashRule(rule, "git   clean -n")).toBe(true);
		expect(matchBashRule(rule, "git cleanup")).toBe(false);
	});

	test("requires both the configured prefix and glob to match", () => {
		const rule = { tool: "shell", command: "git", command_glob: "* --force" };
		expect(matchBashRule(rule, "git clean --force")).toBe(true);
		expect(matchBashRule(rule, "git clean -n")).toBe(false);
		expect(matchBashRule(rule, "checkout --force")).toBe(false);
	});

	test("matches a restricted skill by normalized name and by manifest path", () => {
		const rule = { tool: "skill_load", skill_name: "test-skill" };
		for (const args of [
			{ name: " TEST-SKILL " },
			{ path: "skills/test-skill/SKILL.md" },
			{ name: "unused-name", path: "skills/test-skill/SKILL.md" },
			{ path: "skills\\test-skill\\skill.md" },
		]) {
			expect(matchToolRule(rule, "skill_load", JSON.stringify(args))).toBe(
				true,
			);
		}
		expect(matchToolRule(rule, "skill_load", '{"name":"other"}')).toBe(false);
		expect(matchToolRule(rule, "skill_load", "null")).toBe(false);
		expect(matchToolRule(rule, "skill_list", "{}")).toBe(false);
	});

	test("unconstrained tool denies match only the configured tool", () => {
		expect(matchToolRule({ tool: "read" }, "read", "{}")).toBe(true);
		expect(matchToolRule({ tool: "read" }, "write", "{}")).toBe(false);
		expect(matchToolRule({ tool: "read", skill_name: "x" }, "read", "{}")).toBe(
			false,
		);
	});
});
