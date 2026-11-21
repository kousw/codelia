import type { PermissionRule } from "@codelia/config";

const REGEX_SPECIAL_CHARS = new Set([
	"\\",
	"^",
	"$",
	"+",
	"?",
	".",
	"(",
	")",
	"|",
	"{",
	"}",
	"[",
	"]",
]);
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const globToRegExp = (pattern: string): RegExp => {
	let escaped = "";
	for (const char of pattern) {
		switch (char) {
			case "*":
				escaped += ".*";
				break;
			case "?":
				escaped += ".";
				break;
			default:
				escaped += REGEX_SPECIAL_CHARS.has(char) ? `\\${char}` : char;
		}
	}
	return new RegExp(`^${escaped}$`);
};

const matchCommandPrefix = (segment: string, ruleCommand: string): boolean => {
	const normalizedRule = normalizeCommand(ruleCommand);
	if (!normalizedRule) return false;
	const ruleTokens = normalizedRule.split(" ");
	const segmentTokens = segment.split(" ");
	if (segmentTokens.length < ruleTokens.length) {
		return false;
	}
	for (let index = 0; index < ruleTokens.length; index += 1) {
		if (segmentTokens[index] !== ruleTokens[index]) {
			return false;
		}
	}
	return true;
};

export const matchCommandGlob = (segment: string, pattern: string): boolean =>
	globToRegExp(pattern).test(segment);

const ruleHasBashConstraint = (rule: PermissionRule): boolean =>
	Boolean(rule.command || rule.command_glob);

const ruleHasSkillConstraint = (rule: PermissionRule): boolean =>
	typeof rule.skill_name === "string" && rule.skill_name.length > 0;

export const parseRawArgsForPrompt = (
	rawArgs: string,
): Record<string, unknown> | null => {
	try {
		const parsed = JSON.parse(rawArgs) as unknown;
		return typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
};

const normalizeSkillName = (value: string): string | null => {
	const normalized = value.trim().toLowerCase();
	if (!normalized || !SKILL_NAME_PATTERN.test(normalized)) {
		return null;
	}
	return normalized;
};

const extractSkillNameFromPath = (value: string): string | null => {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const normalizedPath = trimmed.replaceAll("\\", "/");
	const segments = normalizedPath
		.split("/")
		.filter((segment) => segment.length > 0);
	if (!segments.length) return null;
	const last = segments[segments.length - 1];
	if (last.toLowerCase() === "skill.md" && segments.length > 1) {
		return normalizeSkillName(segments[segments.length - 2]);
	}
	return normalizeSkillName(last);
};

const extractSkillLoadName = (rawArgs: string): string | null => {
	const parsed = parseRawArgsForPrompt(rawArgs);
	if (!parsed) return null;
	const skillPath = parsed.path;
	if (typeof skillPath === "string" && skillPath.trim()) {
		return extractSkillNameFromPath(skillPath);
	}
	return typeof parsed.name === "string"
		? normalizeSkillName(parsed.name)
		: null;
};

const matchSkillLoadRule = (rule: PermissionRule, rawArgs: string): boolean => {
	if (rule.tool !== "skill_load") return false;
	if (ruleHasBashConstraint(rule)) return false;
	if (!ruleHasSkillConstraint(rule)) return true;
	const requested = extractSkillLoadName(rawArgs);
	const configured =
		typeof rule.skill_name === "string"
			? normalizeSkillName(rule.skill_name)
			: null;
	return requested !== null && configured !== null && requested === configured;
};

export const matchToolRule = (
	rule: PermissionRule,
	toolName: string,
	rawArgs: string,
): boolean => {
	if (rule.tool !== toolName) return false;
	if (toolName === "skill_load") {
		return matchSkillLoadRule(rule, rawArgs);
	}
	return !ruleHasBashConstraint(rule) && !ruleHasSkillConstraint(rule);
};

const normalizeCommand = (value: string): string =>
	value.trim().replace(/\s+/g, " ");

export const isShellPermissionRule = (rule: PermissionRule): boolean =>
	(rule.tool === "shell" || rule.tool === "bash") &&
	!ruleHasSkillConstraint(rule);

export const matchBashRule = (
	rule: PermissionRule,
	segment: string,
): boolean => {
	if (!isShellPermissionRule(rule)) return false;
	const normalizedSegment = normalizeCommand(segment);
	if (!normalizedSegment) return false;
	if (!rule.command && !rule.command_glob) return true;
	if (rule.command && !matchCommandPrefix(normalizedSegment, rule.command)) {
		return false;
	}
	if (
		rule.command_glob &&
		!matchCommandGlob(normalizedSegment, rule.command_glob)
	) {
		return false;
	}
	return true;
};
