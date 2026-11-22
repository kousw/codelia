import { realpathSync } from "node:fs";
import type { CodeliaConfig, PermissionRule } from "@codelia/config";
import { loadConfig, removePermissionRules } from "@codelia/config-loader";
import {
	type PermissionRuleEntry,
	type PermissionRuleScope,
	type PermissionRuleSpec,
	type PermissionsListResult,
	type PermissionsRemoveResult,
	type ProjectAllowTrust,
	type ProjectAllowTrustSetResult,
	RPC_ERROR_CODE,
} from "@codelia/protocol";
import { ProjectsPolicyStore } from "@codelia/storage";
import { resolveConfigPath, resolveProjectConfigPath } from "../config";
import {
	configurableToolInvocations,
	getProjectAllowTrust,
	setProjectAllowTrust,
} from "../local-permission-allows";
import {
	configuredWorkspaceWrite,
	hasWorkspaceWriteGrant,
	removeWorkspaceWriteGrant,
	runtimeLaunchRules,
} from "../permissions/runtime-approval";
import { immediateBuiltins } from "../permissions/tool-approval";
import type { RuntimeState } from "../runtime-state";
import { resolveConfigWorkspaceDir, supportsConfigReadWrite } from "./config";
import { parseRequestParams, sendRequestResult } from "./protocol";
import { sendError } from "./transport";

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

const localProjectAllows = (state: RuntimeState): boolean =>
	state.effectiveEnvironment.sourcePreset === "tui-local" &&
	supportsConfigReadWrite(state);

export const supportsProjectAllowTrust = (state: RuntimeState): boolean =>
	localProjectAllows(state) && typeof process.geteuid === "function";

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
		raw: unknown,
	): Promise<void> => {
		if (rejectUnsupported(id)) return;
		const parsed = parseRequestParams("permissions.list", raw);
		if (!parsed.ok) return sendError(id, parsed.error);
		const params = parsed.params;
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
		const { source, legacy } = state.sandboxMode;
		const approvalMode: PermissionsListResult["approval_mode"] =
			legacy && source !== "sdk" ? { value: legacy, source } : null;
		const rules: PermissionRuleEntry[] = [
			...fileRules(globalConfig, "global"),
			...fileRules(projectConfig, "project"),
		];
		if (params?.include_system) {
			for (const tool of immediateBuiltins) {
				rules.push({
					kind: "allow",
					scope: "system",
					rule: { tool },
					removable: false,
				});
			}
		}
		let launchRules: PermissionsListResult["launch_rules"];
		if (
			workspaceDir &&
			state.effectiveEnvironment.sourcePreset === "tui-local"
		) {
			try {
				launchRules = runtimeLaunchRules(state)
					.list(realpathSync(workspaceDir), state.sessionId ?? "operator")
					.map((rule) => ({
						id: rule.id,
						template: rule.template,
						origin: rule.origin,
						executable: rule.executable,
						profile: rule.profile,
						scope: rule.scope,
						...(rule.template === "exact-argv/v2" ||
						rule.template === "argv-prefix/v1"
							? {
									cwd: rule.cwd,
									args: rule.args,
									argv0: rule.argv0,
									launchKind: rule.launchKind,
									...(rule.template === "exact-argv/v2" &&
									rule.source !== undefined
										? { source: rule.source }
										: {}),
								}
							: {}),
					}));
			} catch {
				errors.push({
					scope: "launch_rules",
					message: "Launch rule store is unavailable",
				});
			}
		}
		let trust: ProjectAllowTrust | undefined;
		let remembered: Array<{ tool: string }> | undefined;
		if (workspaceDir && localProjectAllows(state)) {
			try {
				const workspace = realpathSync(workspaceDir);
				const { remembered: personal, ...projectTrust } =
					await getProjectAllowTrust(state, workspace);
				remembered = personal;
				trust = {
					workspace,
					...projectTrust,
				};
			} catch {
				errors.push({
					scope: "project_allow_trust",
					message: "Project allow trust is unavailable",
				});
			}
		}
		const result: PermissionsListResult = {
			...(remembered?.length ? { remembered_tools: remembered } : {}),
			...(trust ? { project_allow_trust: trust } : {}),
			...(launchRules ? { launch_rules: launchRules } : {}),
			...(workspaceDir
				? {
						workspace_write_granted:
							configuredWorkspaceWrite(state) === "granted" ||
							(configuredWorkspaceWrite(state) === "confirm" &&
								hasWorkspaceWriteGrant(state, workspaceDir)),
					}
				: {}),
			sandbox_mode: state.sandboxMode,
			approval_mode: approvalMode,
			paths,
			rules,
			...(errors.length ? { errors } : {}),
		};
		sendRequestResult("permissions.list", id, result);
	};

	const handlePermissionsRemove = async (
		id: string,
		raw: unknown,
	): Promise<void> => {
		if (rejectUnsupported(id)) return;
		const parsed = parseRequestParams("permissions.remove", raw);
		if (!parsed.ok) return sendError(id, parsed.error);
		// The checks below reject unknown rule keys, so they read the original
		// value rather than the stripped one.
		const params = raw as typeof parsed.params;
		if (params && "remembered_tool" in params) {
			const root = resolveConfigWorkspaceDir(state);
			if (
				!root ||
				!localProjectAllows(state) ||
				params.scope !== "project" ||
				!configurableToolInvocations.has(params.remembered_tool)
			) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "Invalid remembered tool",
				});
				return;
			}
			try {
				const workspace = realpathSync(root);
				const removed = await state.withAdmissionLock(async () => {
					if (state.activeRunId) return "busy" as const;
					return new ProjectsPolicyStore().updateRememberedTool(
						workspace,
						params.remembered_tool,
						false,
						() => {
							if (
								resolveConfigWorkspaceDir(state) !== root ||
								realpathSync(root) !== workspace
							)
								throw new Error("workspace_changed");
						},
					);
				});
				if (removed === "busy") {
					sendError(id, {
						code: RPC_ERROR_CODE.RUNTIME_BUSY,
						message: "runtime busy",
					});
					return;
				}
				if (removed) state.reviseApprovalAuthority();
				sendRequestResult("permissions.remove", id, {
					...params,
					removed: Number(removed),
				} satisfies PermissionsRemoveResult);
			} catch {
				sendError(id, {
					code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
					message: "Remembered tool removal failed",
				});
			}
			return;
		}
		if (params && "resource" in params) {
			const workspaceDir = resolveConfigWorkspaceDir(state);
			if (
				!workspaceDir ||
				params.resource !== "workspace_write" ||
				params.scope !== "session"
			) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "Invalid workspace grant reference",
				});
				return;
			}
			const removed = removeWorkspaceWriteGrant(state, workspaceDir);
			sendRequestResult("permissions.remove", id, {
				resource: params.resource,
				scope: "session",
				removed: removed ? 1 : 0,
			} satisfies PermissionsRemoveResult);
			return;
		}
		if (params && "launch_rule_id" in params) {
			const workspaceDir = resolveConfigWorkspaceDir(state);
			if (
				!workspaceDir ||
				!/^[a-f0-9]{64}$/u.test(params.launch_rule_id) ||
				(params.scope !== "session" && params.scope !== "project") ||
				state.effectiveEnvironment.sourcePreset !== "tui-local"
			) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "Invalid launch rule reference",
				});
				return;
			}
			try {
				const removed = runtimeLaunchRules(state).remove(
					realpathSync(workspaceDir),
					state.sessionId ?? "operator",
					params.launch_rule_id,
					params.scope,
				);
				if (removed) state.reviseApprovalAuthority();
				const result: PermissionsRemoveResult = {
					...params,
					removed: removed ? 1 : 0,
				};
				sendRequestResult("permissions.remove", id, result);
			} catch {
				sendError(id, {
					code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
					message: "Launch rule removal failed",
				});
			}
			return;
		}
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
				// The agent snapshots the file-tool deny rules.
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
		sendRequestResult("permissions.remove", id, result);
		log(`permissions.remove scope=${scope} kind=${kind} removed=${removed}`);
	};

	const handleProjectAllowTrustSet = async (
		id: string,
		raw: unknown,
	): Promise<void> => {
		if (!supportsProjectAllowTrust(state)) {
			sendError(id, {
				code: RPC_ERROR_CODE.METHOD_NOT_FOUND,
				message:
					"Project allow trust changes are unavailable for this runtime.",
			});
			return;
		}
		const parsed = parseRequestParams("permissions.projectTrust.set", raw);
		if (!parsed.ok) return sendError(id, parsed.error);
		const params = parsed.params;
		if (
			typeof params?.workspace !== "string" ||
			typeof params.trusted !== "boolean" ||
			typeof params.expected_revision !== "string" ||
			!params.expected_revision
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message:
					"Expected a reviewed project allow list for this local workspace",
			});
			return;
		}
		try {
			await state.withAdmissionLock(async () => {
				if (state.activeRunId) {
					sendError(id, {
						code: RPC_ERROR_CODE.RUNTIME_BUSY,
						message: "runtime busy",
					});
					return;
				}
				const root = resolveConfigWorkspaceDir(state);
				if (!root || realpathSync(root) !== params.workspace) {
					sendError(id, {
						code: RPC_ERROR_CODE.INVALID_PARAMS,
						message:
							"Workspace changed. Review the current project allow list again.",
					});
					return;
				}
				await setProjectAllowTrust(
					state,
					params.workspace,
					params.trusted,
					params.expected_revision,
				);
				state.invalidateAgentCache();
				sendRequestResult("permissions.projectTrust.set", id, {
					workspace: params.workspace,
					trusted: params.trusted,
				} satisfies ProjectAllowTrustSetResult);
			});
		} catch (error) {
			const changed =
				error instanceof Error &&
				error.message === "project_allow_trust_changed";
			sendError(id, {
				code: changed
					? RPC_ERROR_CODE.INVALID_PARAMS
					: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: changed
					? "The project allow list or its trust state changed. Review it again."
					: "Project allow trust is unavailable.",
			});
		}
	};
	return {
		handlePermissionsList,
		handlePermissionsRemove,
		handleProjectAllowTrustSet,
	};
};
