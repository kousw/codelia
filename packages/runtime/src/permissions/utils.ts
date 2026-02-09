import path from "node:path";
import type { PermissionRule } from "@codelia/config";

const REDIRECT_OPERATORS = new Set(["<", ">", ">>", "2>", "2>>"]);
const SPLIT_OPERATORS = [
	"2>>",
	"|&",
	"||",
	"&&",
	">>",
	"2>",
	"|",
	">",
	"<",
	";",
];
const CD_UNSAFE_TARGET_PATTERN = /["'`$&|;<>(){}[\]*?!~\\]/;

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
const SUBCOMMAND_TOKEN_PATTERN = /^[A-Za-z0-9:_-]+$/;
const COMMAND_TOKEN_PATTERN = /^[A-Za-z0-9._+@:-]+$/;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const COMMAND_WRAPPER_TOKENS = new Set([
	"env",
	"command",
	"builtin",
	"nohup",
	"time",
	"sudo",
	"nice",
	"ionice",
	"chrt",
	"timeout",
	"stdbuf",
]);
const COMMANDS_WITH_SUBCOMMAND = new Set([
	"git",
	"jj",
	"bun",
	"bunx",
	"npx",
	"npm",
	"pnpm",
	"yarn",
	"cargo",
	"go",
	"docker",
	"kubectl",
	"gh",
]);
type ThirdTokenRule = "any" | Set<string>;
const COMMANDS_WITH_THIRD_TOKEN = new Map<string, ThirdTokenRule>([
	["npx", "any"],
	["bunx", "any"],
	["bun", new Set(["x"])],
	["npm", new Set(["exec"])],
	["pnpm", new Set(["dlx", "exec"])],
	["yarn", new Set(["dlx"])],
]);
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type BashPathGuard = {
	rootDir: string;
	workingDir: string;
};

type CommandSegment = {
	text: string;
	isCommand: boolean;
};

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

const matchCommandGlob = (segment: string, pattern: string): boolean =>
	globToRegExp(pattern).test(segment);

const ruleHasBashConstraint = (rule: PermissionRule): boolean =>
	Boolean(rule.command || rule.command_glob);

const ruleHasSkillConstraint = (rule: PermissionRule): boolean =>
	typeof rule.skill_name === "string" && rule.skill_name.length > 0;

const parseRawArgsObject = (
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

export const extractSkillLoadName = (rawArgs: string): string | null => {
	const parsed = parseRawArgsObject(rawArgs);
	if (!parsed) return null;
	const name = parsed.name;
	if (typeof name === "string") {
		const normalized = normalizeSkillName(name);
		if (normalized) return normalized;
	}
	const skillPath = parsed.path;
	if (typeof skillPath === "string") {
		return extractSkillNameFromPath(skillPath);
	}
	return null;
};

export const matchSkillLoadRule = (
	rule: PermissionRule,
	rawArgs: string,
): boolean => {
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

export const isSameRule = (
	left: PermissionRule,
	right: PermissionRule,
): boolean =>
	left.tool === right.tool &&
	left.command === right.command &&
	left.command_glob === right.command_glob &&
	left.skill_name === right.skill_name;

const splitCommand = (value: string): CommandSegment[] => {
	const segments: string[] = [];
	const operators: string[] = [];
	let buffer = "";
	let inSingle = false;
	let inDouble = false;
	let index = 0;

	const matchOperator = (input: string, start: number): string | null => {
		for (const op of SPLIT_OPERATORS) {
			if (input.startsWith(op, start)) return op;
		}
		return null;
	};

	while (index < value.length) {
		const char = value[index];
		if (char === "\\" && !inSingle) {
			const next = value[index + 1] ?? "";
			buffer += char + next;
			index += next ? 2 : 1;
			continue;
		}
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			buffer += char;
			index += 1;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			buffer += char;
			index += 1;
			continue;
		}
		if (!inSingle && !inDouble) {
			const op = matchOperator(value, index);
			if (op) {
				segments.push(buffer);
				operators.push(op);
				buffer = "";
				index += op.length;
				continue;
			}
		}
		buffer += char;
		index += 1;
	}
	segments.push(buffer);

	const result: CommandSegment[] = [];
	let isCommand = true;
	for (let i = 0; i < segments.length; i += 1) {
		result.push({ text: segments[i], isCommand });
		const op = operators[i];
		if (!op) continue;
		isCommand = !REDIRECT_OPERATORS.has(op);
	}
	return result;
};

const tokenizeShellWords = (value: string): string[] | null => {
	const tokens: string[] = [];
	let buffer = "";
	let inSingle = false;
	let inDouble = false;
	let escaping = false;

	for (const char of value) {
		if (escaping) {
			buffer += char;
			escaping = false;
			continue;
		}
		if (char === "\\" && !inSingle) {
			escaping = true;
			continue;
		}
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble && /\s/.test(char)) {
			if (buffer) {
				tokens.push(buffer);
				buffer = "";
			}
			continue;
		}
		buffer += char;
	}

	if (escaping || inSingle || inDouble) {
		return null;
	}
	if (buffer) {
		tokens.push(buffer);
	}
	return tokens;
};

export const normalizeCommand = (value: string): string =>
	value.trim().replace(/\s+/g, " ");

export const matchBashRule = (
	rule: PermissionRule,
	segment: string,
): boolean => {
	if (rule.tool !== "bash") return false;
	if (ruleHasSkillConstraint(rule)) return false;
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

export const matchFullCommandRule = (
	rule: PermissionRule,
	command: string,
): boolean =>
	rule.tool === "bash" && !!rule.command_glob && matchBashRule(rule, command);

export const splitCommandSegments = (command: string): string[] =>
	splitCommand(command)
		.filter((segment) => segment.isCommand)
		.map((segment) => normalizeCommand(segment.text))
		.filter((segment) => segment.length > 0);

export const extractCommand = (rawArgs: string): string | null => {
	const parsed = parseRawArgsObject(rawArgs);
	if (!parsed) return null;
	return typeof parsed.command === "string" ? parsed.command : null;
};

export const deriveRememberCommand = (segment: string): string | null => {
	const tokens = tokenizeShellWords(normalizeCommand(segment));
	if (!tokens || !tokens.length) return null;
	let primaryIndex = 0;
	while (
		primaryIndex < tokens.length &&
		ENV_ASSIGNMENT_PATTERN.test(tokens[primaryIndex])
	) {
		primaryIndex += 1;
	}
	if (primaryIndex > 0) return null;
	if (primaryIndex >= tokens.length) return null;
	const primaryToken = tokens[primaryIndex];
	const primary = path.basename(primaryToken);
	if (!primary || primary === "." || primary === "..") return null;
	if (!COMMAND_TOKEN_PATTERN.test(primary)) return null;
	if (COMMAND_WRAPPER_TOKENS.has(primary)) return null;
	const secondary = tokens[primaryIndex + 1];
	if (!secondary) return primary;
	if (!COMMANDS_WITH_SUBCOMMAND.has(primary)) return primary;
	if (!SUBCOMMAND_TOKEN_PATTERN.test(secondary)) return primary;
	const thirdTokenRule = COMMANDS_WITH_THIRD_TOKEN.get(primary);
	const tertiary = tokens[primaryIndex + 2];
	if (
		thirdTokenRule &&
		tertiary &&
		SUBCOMMAND_TOKEN_PATTERN.test(tertiary) &&
		(thirdTokenRule === "any" || thirdTokenRule.has(secondary))
	) {
		return `${primary} ${secondary} ${tertiary}`;
	}
	return `${primary} ${secondary}`;
};

export const formatPermissionRulePreview = (rule: PermissionRule): string => {
	if (rule.tool === "bash") {
		if (rule.command) {
			return `bash: ${rule.command}`;
		}
		if (rule.command_glob) {
			return `bash: ${rule.command_glob}`;
		}
	}
	if (rule.tool === "skill_load" && rule.skill_name) {
		return `skill_load: ${rule.skill_name}`;
	}
	return rule.tool;
};

export const isCdSegment = (segment: string): boolean =>
	segment === "cd" || segment.startsWith("cd ");

export const resolveCdTarget = (
	segment: string,
	currentWorkingDir: string,
	rootDir: string,
): string | null => {
	const tokens = segment.split(" ").filter(Boolean);
	if (tokens[0] !== "cd") return null;
	if (tokens.length !== 2) return null;
	const target = tokens[1];
	if (target === "-" || CD_UNSAFE_TARGET_PATTERN.test(target)) return null;
	const resolved = path.resolve(currentWorkingDir, target);
	const relative = path.relative(rootDir, resolved);
	if (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	) {
		return resolved;
	}
	return null;
};

export const parseRawArgsForPrompt = (
	rawArgs: string,
): Record<string, unknown> | null => parseRawArgsObject(rawArgs);
