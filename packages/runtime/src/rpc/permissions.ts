import type { CodeliaConfig, PermissionRule } from "@codelia/config";
import { loadConfig, removePermissionRules } from "@codelia/config-loader";
import {
	type PermissionRuleEntry,
	type PermissionRuleScope,
	type PermissionRuleSpec,
	type PermissionsListParams,
	type PermissionsListResult,
	type PermissionsRemoveParams,
	type PermissionsRemoveResult,
	RPC_ERROR_CODE,
} from "@codelia/protocol";
import { resolveConfigPath, resolveProjectConfigPath } from "../config";
import { resolveApprovalModeForRuntime } from "../permissions/approval-mode";
import { buildSystemPermissions } from "../permissions/service";
import type { RuntimeState } from "../runtime-state";
import { resolveConfigWorkspaceDir, supportsConfigReadWrite } from "./config";
import { sendError, sendResult } from "./transport";

const MAX_RULE_FIELD_LENGTH = 4096;
const RULE_FIELDS = ["tool", "command", "command_glob", "skill_name"] as const;

const toSpec = (rule: PermissionRule): PermissionRuleSpec => ({
	tool: rule.tool,
	...(rule.command !== undefined ? { command: rule.command } : {}),
	...(rule.command_glob !== undefined
		? { command_glob: rule.command_glob }
		: {}),
	...(rule.skill_name !== undefined ? { skill_name: rule.skill_name } : {}),
});

/** Returns the normalized rule, or null when the shape is invalid. */
const parseRuleSpec = (value: unknown): PermissionRuleSpec | null => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !RULE_FIELDS.includes(key as never))) {
		return null;
	}
	for (const field of RULE_FIELDS) {
		const entry = record[field];
		if (entry === undefined && field !== "tool") continue;
		if (
			typeof entry !== "string" ||
			!entry.trim() ||
			entry.length > MAX_RULE_FIELD_LENGTH
		) {
			return null;
		}
	}
	return toSpec(record as PermissionRule);
};

const fileRules = (
	config: CodeliaConfig | null,
	scope: PermissionRuleScope,
): PermissionRuleEntry[] => [
	...(config?.permissions?.allow ?? []).map((rule) => ({
		kind: "allow" as const,
		scope,
		rule: toSpec(rule),
		removable: true,
	})),
	...(config?.permissions?.deny ?? []).map((rule) => ({
		kind: "deny" as const,
		scope,
		rule: toSpec(rule),
		removable: true,
	})),
];

export const createPermissionsHandlers = ({
	state,
	log,
}: {
	state: RuntimeState;
	log: (message: string) => void;
}) => {
	const rejectUnsupported = (id: string): boolean => {
		if (supportsConfigReadWrite(state)) return false;
		sendError(id, {
			code: RPC_ERROR_CODE.INVALID_PARAMS,
			message: "permission rules are not available for this runtime",
		});
		return true;
	};

	const handlePermissionsList = async (
		id: string,
		params: PermissionsListParams | undefined,
	): Promise<void> => {
		if (rejectUnsupported(id)) return;
		if (
			params?.include_system !== undefined &&
			typeof params.include_system !== "boolean"
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "include_system must be a boolean",
			});
			return;
		}
		const workspaceDir = resolveConfigWorkspaceDir(state);
		const paths = {
			global: resolveConfigPath(),
			project: workspaceDir ? resolveProjectConfigPath(workspaceDir) : null,
		};
		const errors: NonNullable<PermissionsListResult["errors"]> = [];
		// A broken layer is reported and listed as empty; its text is not echoed.
		const load = async (scope: PermissionRuleScope, path: string | null) => {
			if (!path) return null;
			try {
				return await loadConfig(path);
			} catch {
				errors.push({ scope, message: `${scope} config could not be parsed` });
				return null;
			}
		};
		const [globalConfig, projectConfig] = await Promise.all([
			load("global", paths.global),
			load("project", paths.project),
		]);
		let approvalMode: PermissionsListResult["approval_mode"] = null;
		try {
			// No startup selection: listing never prompts or persists a mode.
			const sandboxRoot = workspaceDir ?? process.cwd();
			const resolved = await resolveApprovalModeForRuntime({
				workingDir: sandboxRoot,
				runtimeSandboxRoot: sandboxRoot,
			});
			approvalMode = {
				value: resolved.approvalMode,
				source: resolved.source,
				...(state.agent && state.approvalMode
					? { active: state.approvalMode }
					: {}),
			};
		} catch {
			errors.push({
				scope: "approval_mode",
				message: "approval mode could not be resolved",
			});
		}
		const rules: PermissionRuleEntry[] = [
			...fileRules(globalConfig, "global"),
			...fileRules(projectConfig, "project"),
		];
		if (params?.include_system && approvalMode) {
			const system = buildSystemPermissions(approvalMode.value);
			for (const rule of system.allow ?? []) {
				rules.push({
					kind: "allow",
					scope: "system",
					rule: toSpec(rule),
					removable: false,
				});
			}
		}
		const result: PermissionsListResult = {
			approval_mode: approvalMode,
			paths,
			rules,
			...(errors.length ? { errors } : {}),
		};
		sendResult(id, result);
	};

	const handlePermissionsRemove = async (
		id: string,
		params: PermissionsRemoveParams | undefined,
	): Promise<void> => {
		if (rejectUnsupported(id)) return;
		if (state.activeRunId) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: "runtime busy",
			});
			return;
		}
		const invalid = (message: string) =>
			sendError(id, { code: RPC_ERROR_CODE.INVALID_PARAMS, message });
		const scope = params?.scope;
		const kind = params?.kind;
		if (scope !== "global" && scope !== "project") {
			invalid("scope must be global or project");
			return;
		}
		if (kind !== "allow" && kind !== "deny") {
			invalid("kind must be allow or deny");
			return;
		}
		const rule = parseRuleSpec(params?.rule);
		if (!rule) {
			invalid("rule must have a tool and only string rule fields");
			return;
		}
		const workspaceDir = resolveConfigWorkspaceDir(state);
		const path =
			scope === "global"
				? resolveConfigPath()
				: workspaceDir
					? resolveProjectConfigPath(workspaceDir)
					: null;
		if (!path) {
			invalid("project scope requires a workspace directory");
			return;
		}
		let removed: number | "busy";
		try {
			// Recheck idleness under the admission lock so no run starts mid-write.
			removed = await state.withAdmissionLock(async () => {
				if (state.activeRunId) return "busy" as const;
				const count = await removePermissionRules(path, kind, rule);
				// PermissionService (incl. in-memory remembered rules) is built with the agent.
				if (count > 0) state.invalidateAgentCache();
				return count;
			});
		} catch {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: `${scope} config write failed`,
			});
			return;
		}
		if (removed === "busy") {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: "runtime busy",
			});
			return;
		}
		const result: PermissionsRemoveResult = { scope, kind, path, removed };
		sendResult(id, result);
		log(`permissions.remove scope=${scope} kind=${kind} removed=${removed}`);
	};

	return { handlePermissionsList, handlePermissionsRemove };
};
