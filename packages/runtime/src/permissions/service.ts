import path from "node:path";
import type { PermissionRule, PermissionsConfig } from "@codelia/config";
import {
	type BashPathGuard,
	deriveRememberCommand,
	extractCommand,
	extractSkillLoadName,
	formatPermissionRulePreview,
	isCdSegment,
	isSameRule,
	matchBashRule,
	matchFullCommandRule,
	matchSkillLoadRule,
	matchToolRule,
	normalizeCommand,
	parseRawArgsForPrompt,
	resolveCdTarget,
	splitCommandSegments,
} from "./utils";

export type PermissionDecision = {
	decision: "allow" | "deny" | "confirm";
	reason?: string;
};

const SYSTEM_TOOL_ALLOWLIST = [
	"read",
	"grep",
	"glob_search",
	"todo_read",
	"todo_write",
	"tool_output_cache",
	"tool_output_cache_grep",
	"agents_resolve",
	"skill_search",
	"skill_load",
	"lane_list",
	"lane_status",
	"done",
];

const SYSTEM_BASH_ALLOWLIST = [
	"pwd",
	"ls",
	"rg",
	"grep",
	"find",
	"sort",
	"cat",
	"head",
	"tail",
	"wc",
	"stat",
	"file",
	"uname",
	"whoami",
	"date",
	"git status",
	"git diff",
	"git show",
	"git log",
	"git rev-parse",
	"git ls-files",
	"git grep",
];

export const buildSystemPermissions = (): PermissionsConfig => ({
	allow: [
		...SYSTEM_TOOL_ALLOWLIST.map((tool) => ({ tool })),
		...SYSTEM_BASH_ALLOWLIST.map((command) => ({ tool: "bash", command })),
	],
});

const mergePermissions = (
	configs: Array<PermissionsConfig | null | undefined>,
): PermissionsConfig => {
	const allow: PermissionRule[] = [];
	const deny: PermissionRule[] = [];
	for (const config of configs) {
		if (!config) continue;
		if (config.allow) allow.push(...config.allow);
		if (config.deny) deny.push(...config.deny);
	}
	return {
		allow: allow.length ? allow : undefined,
		deny: deny.length ? deny : undefined,
	};
};

export class PermissionService {
	private allowRules: PermissionRule[];
	private readonly denyRules: PermissionRule[];
	private readonly bashPathGuard?: BashPathGuard;

	constructor(options: {
		system?: PermissionsConfig;
		user?: PermissionsConfig;
		bashPathGuard?: BashPathGuard;
	}) {
		const merged = mergePermissions([options.system, options.user]);
		this.allowRules = merged.allow ?? [];
		this.denyRules = merged.deny ?? [];
		if (options.bashPathGuard) {
			this.bashPathGuard = {
				rootDir: path.resolve(options.bashPathGuard.rootDir),
				workingDir: path.resolve(options.bashPathGuard.workingDir),
			};
		}
	}

	rememberAllow(toolName: string, rawArgs: string): PermissionRule[] {
		const rules = this.buildAllowRules(toolName, rawArgs);
		if (!rules.length) return [];
		const remembered: PermissionRule[] = [];
		for (const rule of rules) {
			if (this.allowRules.some((existing) => isSameRule(existing, rule))) {
				continue;
			}
			this.allowRules.push(rule);
			remembered.push(rule);
		}
		return remembered;
	}

	getConfirmPrompt(
		toolName: string,
		rawArgs: string,
	): { title: string; message: string } {
		const rememberPreview = this.buildRememberPreview(toolName, rawArgs);
		if (toolName === "bash") {
			const command = extractCommand(rawArgs) ?? rawArgs;
			return {
				title: "Run command?",
				message: `${command}${rememberPreview}`,
			};
		}
		if (toolName === "skill_load") {
			const parsed = parseRawArgsForPrompt(rawArgs);
			const skillName = extractSkillLoadName(rawArgs);
			const explicitPath =
				parsed && typeof parsed.path === "string" ? parsed.path.trim() : "";
			return {
				title: "Load skill?",
				message: `${skillName ? skillName : explicitPath || `skill_load ${rawArgs}`}${rememberPreview}`,
			};
		}
		return { title: "Run tool?", message: `${toolName} ${rawArgs}` };
	}

	evaluate(toolName: string, rawArgs: string): PermissionDecision {
		if (toolName === "bash") {
			return this.evaluateBash(rawArgs);
		}
		return this.evaluateTool(toolName, rawArgs);
	}

	private evaluateTool(toolName: string, rawArgs: string): PermissionDecision {
		if (this.denyRules.some((rule) => matchToolRule(rule, toolName, rawArgs))) {
			return { decision: "deny", reason: `blocked by deny rule (${toolName})` };
		}
		if (
			this.allowRules.some((rule) => matchToolRule(rule, toolName, rawArgs))
		) {
			return { decision: "allow" };
		}
		return { decision: "confirm" };
	}

	private evaluateBash(rawArgs: string): PermissionDecision {
		const command = extractCommand(rawArgs);
		if (!command) {
			return { decision: "confirm", reason: "missing command" };
		}
		const normalized = normalizeCommand(command);
		if (!normalized) {
			return { decision: "confirm", reason: "empty command" };
		}

		if (this.denyRules.some((rule) => matchFullCommandRule(rule, normalized))) {
			return {
				decision: "deny",
				reason: `blocked by deny rule (${normalized})`,
			};
		}
		const segments = splitCommandSegments(normalized);
		if (!segments.length) {
			return { decision: "confirm", reason: "empty command" };
		}
		if (
			!segments.some((segment) => isCdSegment(segment)) &&
			this.allowRules.some((rule) => matchFullCommandRule(rule, normalized))
		) {
			return { decision: "allow" };
		}

		for (const segment of segments) {
			if (this.denyRules.some((rule) => matchBashRule(rule, segment))) {
				return {
					decision: "deny",
					reason: `blocked by deny rule (${segment})`,
				};
			}
		}

		let currentWorkingDir = this.bashPathGuard?.workingDir;
		for (const segment of segments) {
			if (isCdSegment(segment)) {
				if (!this.bashPathGuard || !currentWorkingDir) {
					return {
						decision: "confirm",
						reason: `cd requires confirmation (${segment})`,
					};
				}
				const resolved = resolveCdTarget(
					segment,
					currentWorkingDir,
					this.bashPathGuard.rootDir,
				);
				if (!resolved) {
					return {
						decision: "confirm",
						reason: `cd target requires confirmation (${segment})`,
					};
				}
				currentWorkingDir = resolved;
				continue;
			}
			if (this.allowRules.some((rule) => matchBashRule(rule, segment))) {
				continue;
			}
			return {
				decision: "confirm",
				reason: `segment requires confirmation (${segment})`,
			};
		}
		return { decision: "allow" };
	}

	private buildAllowRules(toolName: string, rawArgs: string): PermissionRule[] {
		if (toolName === "skill_load") {
			const skillName = extractSkillLoadName(rawArgs);
			if (!skillName) return [];
			return [{ tool: "skill_load", skill_name: skillName }];
		}
		if (toolName !== "bash") {
			return [{ tool: toolName }];
		}
		const command = extractCommand(rawArgs);
		if (!command) return [];
		const normalized = normalizeCommand(command);
		if (!normalized) return [];
		const segments = splitCommandSegments(normalized);
		if (!segments.length) return [];
		const rules: PermissionRule[] = [];
		for (const segment of segments) {
			if (isCdSegment(segment)) continue;
			const rememberCommand = deriveRememberCommand(segment);
			if (!rememberCommand) continue;
			const rule: PermissionRule = { tool: "bash", command: rememberCommand };
			if (rules.some((existing) => isSameRule(existing, rule))) continue;
			rules.push(rule);
		}
		return rules;
	}

	private buildRememberPreview(toolName: string, rawArgs: string): string {
		const rules = this.buildAllowRules(toolName, rawArgs).filter(
			(rule) => !this.isRuleAlreadyAllowed(rule),
		);
		if (!rules.length) return "";
		const previewLimit = 5;
		const previewLines = rules
			.slice(0, previewLimit)
			.map((rule) => `- ${formatPermissionRulePreview(rule)}`);
		if (rules.length > previewLimit) {
			previewLines.push(`- ...and ${rules.length - previewLimit} more`);
		}
		return `\n\nRemember (don't ask again):\n${previewLines.join("\n")}`;
	}

	private isRuleAlreadyAllowed(rule: PermissionRule): boolean {
		if (this.allowRules.some((existing) => isSameRule(existing, rule))) {
			return true;
		}
		if (rule.tool === "bash") {
			const probe = rule.command_glob ?? rule.command;
			if (!probe) return false;
			return this.allowRules.some((existing) => matchBashRule(existing, probe));
		}
		if (rule.tool === "skill_load" && rule.skill_name) {
			const probeArgs = JSON.stringify({ name: rule.skill_name });
			return this.allowRules.some((existing) =>
				matchSkillLoadRule(existing, probeArgs),
			);
		}
		return false;
	}
}
