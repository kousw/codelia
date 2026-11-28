import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { PermissionRule } from "@codelia/config";
import type { DependencyKey } from "@codelia/core";
import {
	prepareToolInvocation,
	type Tool,
	type ToolContext,
	ToolPermissionDenied,
	type ToolPermissionHook,
} from "@codelia/core";
import { ProjectsPolicyStore } from "@codelia/storage";
import {
	configurableToolInvocations,
	localAllowStillCurrent,
} from "../local-permission-allows";
import type { RuntimeState } from "../runtime-state";
import type { FileSelection, SandboxContext } from "../sandbox/context";
import {
	bindPatchAdmission,
	getPatchApprovalTargets,
	isBuiltinApplyPatch,
} from "../tools/apply-patch";
import { isNativeTuiClientTool } from "../tools/client";
import { serializeApprovalInput } from "./approval-input";
import { getOperatorContext, setOperatorContext } from "./operator-context";
import { shellPolicySnapshot, shellPolicyVersion } from "./policy-index";
import { comparableResourceName, resourceContainsPath } from "./resource-paths";
import {
	type ApprovalOrigin,
	coversApprovalResource,
	type ExecutionProfile,
	type Resource,
} from "./route";
import {
	configuredWorkspaceWrite,
	hasWorkspaceWriteGrant,
	runtimeApprovalDispatcher,
	runtimeWorkspaceGrant,
} from "./runtime-approval";
import { isWithin } from "./shell-backend";
import { matchToolRule, parseRawArgsForPrompt } from "./utils";

export const immediateBuiltins: ReadonlySet<string> = new Set([
	"read",
	"read_line",
	"attachment_read",
	"conversation_search",
	"conversation_read",
	"agents_resolve",
	"skill_load",
	"skill_search",
	"todo_read",
	"todo_new",
	"todo_append",
	"todo_patch",
	"todo_clear",
	"tool_output_cache",
	"tool_output_cache_line",
	"tool_output_cache_grep",
	"task_list",
	"task_status",
	"task_result",
	"task_wait",
	"task_cancel",
	"task_send_message",
	"task_receive_messages",
	"shell_list",
	"shell_status",
	"shell_logs",
	"shell_wait",
	"shell_result",
	"shell_cancel",
	"shell_stdin_write",
	"lane_list",
	"lane_status",
	"image_inspect",
	"done",
	"get_goal",
	"update_goal",
]);

export type ToolAuthority = Readonly<{
	ceiling: readonly Resource[];
	granted: readonly Resource[];
	launchRule?: string;
}>;

export type ToolEffect = Readonly<{
	resources: readonly Resource[];
	kind: "external_update" | "dependency_read";
}>;

type Registration = Readonly<{
	id: string;
	name: string;
	kind: "builtin" | "mcp" | "host" | "client";
	paidExternal?: true;
	nativeClientUi?: true;
}>;

const fileRequests = (
	name: string,
	raw: string,
): Array<{
	operand: string;
	access: "read" | "write";
	requiresDirectoryMutation?: boolean;
	patchKind?: ReturnType<typeof getPatchApprovalTargets>[number]["kind"];
}> => {
	const args = parseRawArgsForPrompt(raw);
	if (name === "apply_patch" && typeof args?.patch === "string") {
		return getPatchApprovalTargets(args.patch).map((target) => ({
			operand: target.path,
			access: args.dry_run === true ? "read" : "write",
			patchKind: target.kind,
			requiresDirectoryMutation:
				args?.dry_run !== true && target.kind !== "update",
		}));
	}
	if (name === "image_export" && typeof args?.output_path === "string")
		return [
			{
				operand: args.output_path,
				access: "write",
				requiresDirectoryMutation: true,
			},
		];
	if (
		(name === "decision" || name === "image_generate") &&
		Array.isArray(args?.images)
	) {
		return args.images.flatMap((source: unknown) => {
			if (
				!source ||
				typeof source !== "object" ||
				!("type" in source) ||
				source.type !== "file" ||
				!("file_path" in source) ||
				typeof source.file_path !== "string"
			)
				return [];
			return [{ operand: source.file_path, access: "read" as const }];
		});
	}
	if (typeof args?.file_path !== "string") return [];
	if (name === "read" || name === "read_line" || name === "view_image")
		return [{ operand: args.file_path, access: "read" }];
	if (name === "edit" || name === "write")
		return [{ operand: args.file_path, access: "write" }];
	return [];
};

type BoundFiles = {
	current: () => boolean;
	resources: Resource[];
	enforceable: boolean;
	deferConsumption?: boolean;
	ordinaryPatch?: boolean;
	patchPreview?: boolean;
};
const securedTools = new WeakSet<Tool>();
export const isSecuredRuntimeTool = (tool: Tool): boolean =>
	securedTools.has(tool);

const checkPatchTargetsAreIndependent = (targets: readonly FileSelection[]) => {
	const names = new Map<string, string[]>();
	const existing = new Set<string>();
	for (const { target, identity } of targets) {
		const inode = identity?.split(":", 2).join(":");
		const key = comparableResourceName(target);
		const equivalent = names.get(key) ?? [];
		if (
			(inode !== undefined && existing.has(inode)) ||
			equivalent.some((candidate) => resourceContainsPath(candidate, target))
		)
			throw new Error("Patch applies multiple changes to the same file");
		if (inode !== undefined) existing.add(inode);
		equivalent.push(target);
		names.set(key, equivalent);
	}
	for (const { target } of targets) {
		for (
			let entry = target, parent = path.dirname(entry);
			entry !== parent;
			entry = parent, parent = path.dirname(entry)
		) {
			const candidates = names.get(comparableResourceName(parent));
			if (
				candidates?.some((candidate) => resourceContainsPath(candidate, target))
			)
				throw new Error("Patch targets a file and a path inside it");
		}
	}
};

const previewInvocation = (
	name: string,
	raw: string,
	builtin: boolean,
): string => {
	const args = parseRawArgsForPrompt(raw);
	const target =
		args?.file_path ??
		args?.output_path ??
		args?.url ??
		args?.target ??
		args?.path;
	if (name === "decision" && builtin) {
		const model =
			args?.provider === "google" ? "gemini-decision-1" : "gpt-6-luna";
		return `${model} (API-key billing)\nRequest: ${raw.slice(0, 8192)}`;
	}
	if (name === "image_generate" && builtin)
		return `${String(args?.provider)}/${String(args?.requested_model)}\n${String(args?.billing)}\nRequest: ${raw.slice(0, 8192)}`;
	if (["write", "edit", "apply_patch"].includes(name) && builtin)
		return `${name}\nRequest: ${raw.slice(0, 8192)}`;
	if (!builtin)
		return `${name} (host managed)\nArguments: ${raw.slice(0, 8192)}`;
	return typeof target === "string"
		? `${name}\nTarget: ${target.slice(0, 2048)}`
		: name;
};

export const createRuntimeToolApproval = ({
	state,
	builtinNames,
	deny,
	sandboxKey,
}: {
	state: RuntimeState;
	builtinNames: ReadonlySet<string>;
	deny?: readonly PermissionRule[];
	sandboxKey?: DependencyKey<SandboxContext> | null;
}) => {
	const dispatcher = runtimeApprovalDispatcher(state);
	const adapters = state.effectiveEnvironment.adapters;
	const internalCalls = new WeakMap<
		ToolContext,
		{ registration: Registration; files?: BoundFiles }
	>();
	const builtinReads = new Map<string, Registration>();
	const dispatch = async <T>(
		registration: Registration,
		origin: ApprovalOrigin,
		raw: string,
		ctx: ToolContext,
		execute: (consume: () => void) => T | Promise<T>,
		files?: BoundFiles,
	): Promise<T> => {
		const approvalStartedAt = performance.now();
		let approvalRecorded = false;
		const recordApprovalWait = () => {
			if (approvalRecorded) return;
			approvalRecorded = true;
			ctx.recordApprovalWaitMs?.(
				Math.max(0, performance.now() - approvalStartedAt),
			);
		};
		const tool = registration.name;
		const builtin = registration.kind === "builtin";
		const args = parseRawArgsForPrompt(raw);
		const localRead =
			registration.nativeClientUi === true ||
			(builtin &&
				(immediateBuiltins.has(tool) ||
					files?.patchPreview === true ||
					(tool === "view_image" &&
						typeof args?.file_path === "string" &&
						args.url === undefined)));
		const context = state.approvalContext();
		const owner = state.sessionId ?? "operator";
		const generation = state.approvalConnectionGeneration;
		const target: Resource = { operation: "invoke", target: tool };
		const paidNetwork: Resource[] =
			registration.paidExternal && args
				? [
						{
							operation: "network",
							target:
								tool === "decision"
									? `${String(args.provider)}:decisions`
									: `${String(args.provider)}:image-generation:${String(args.endpoint)}`,
						},
					]
				: [];
		const effect =
			args && !registration.paidExternal
				? adapters.approvalToolEffect?.(registration, args)
				: undefined;
		const effectKind = effect?.kind;
		const effectResources = Object.freeze(
			(effect?.resources ?? []).map((resource) =>
				Object.freeze({ ...resource }),
			),
		);
		const opaque =
			registration.kind !== "builtin" &&
			!registration.nativeClientUi &&
			!effect;
		const policyRevision = adapters.approvalPolicyRevision?.();
		const configuredWorkspaceAccess = configuredWorkspaceWrite(state);
		const root = state.runtimeSandboxRoot ?? state.runtimeWorkingDir;
		const workspace = root && !localRead && files ? realpathSync(root) : root;
		const workspaceAccess =
			workspace &&
			configuredWorkspaceAccess !== "forbid" &&
			hasWorkspaceWriteGrant(state, workspace)
				? "granted"
				: configuredWorkspaceAccess;
		const workspaceGrant =
			workspace &&
			workspaceAccess === "confirm" &&
			builtin &&
			origin === "parent_agent" &&
			state.effectiveEnvironment.sourcePreset === "tui-local" &&
			!adapters.approvalToolAuthority &&
			(tool === "write" || tool === "edit" || tool === "apply_patch") &&
			files?.resources.length &&
			files.resources.every(
				({ operation, target }) =>
					operation === "write" && isWithin(workspace, target),
			)
				? runtimeWorkspaceGrant(state, workspace, owner)
				: undefined;
		const localDevelopment =
			builtin &&
			["write", "edit", "apply_patch", "image_export"].includes(tool) &&
			workspaceAccess === "granted" &&
			!!files?.resources.some((resource) => resource.operation === "write");
		const ordinaryPatch =
			files?.ordinaryPatch === true &&
			state.sandboxMode.value === "workspace-write" &&
			state.effectiveEnvironment.sourcePreset === "tui-local" &&
			!adapters.approvalToolAuthority &&
			!adapters.approvalToolEffect;
		const configuredPolicy =
			root &&
			builtin &&
			builtinNames.has(tool) &&
			configurableToolInvocations.has(tool) &&
			!localRead &&
			!localDevelopment &&
			(origin === "parent_agent" || origin === "operator") &&
			state.effectiveEnvironment.sourcePreset === "tui-local" &&
			state.effectiveEnvironment.config.source === "runtime-default" &&
			!adapters.approvalToolAuthority &&
			!adapters.approvalToolEffect
				? await shellPolicySnapshot(
						state,
						root,
						shellPolicyVersion(state, root),
					)
				: undefined;
		const matchesTool = (rule: PermissionRule) =>
			matchToolRule(rule, tool, raw);
		const allowed = (rule: PermissionRule) =>
			matchesTool(rule) && localAllowStillCurrent(rule);
		let configuredInvocation = configuredPolicy?.allow.find(allowed);
		const explicitlyDenied =
			deny?.some(matchesTool) || configuredPolicy?.deny?.some(matchesTool);
		let expectedPolicyVersion = configuredPolicy?.version;
		const current = () =>
			state.approvalContext() === context &&
			adapters.approvalPolicyRevision?.() === policyRevision &&
			(expectedPolicyVersion === undefined ||
				(!!root &&
					shellPolicyVersion(state, root) === expectedPolicyVersion)) &&
			(!configuredInvocation || localAllowStillCurrent(configuredInvocation)) &&
			(files?.current() ?? true);
		let save:
			| { description: string; rememberProject: () => Promise<void> }
			| undefined;
		if (
			configuredPolicy &&
			root &&
			!explicitlyDenied &&
			!configuredInvocation &&
			!files?.resources.length
		) {
			const project = realpathSync(root);
			const store = new ProjectsPolicyStore();
			const writable = await store.verifyProjectModeWritable(project).then(
				() => true,
				() => false,
			);
			if (writable)
				save = {
					description: `Remember ${tool} for this workspace in your personal permissions.`,
					rememberProject: async () => {
						await store.updateRememberedTool(project, tool, true, () => {
							if (ctx.signal?.aborted || !current())
								throw new Error("approval_expired");
						});
						const version = shellPolicyVersion(state, root);
						const latest = await shellPolicySnapshot(state, root, version);
						const saved = latest.allow.find(allowed);
						if (latest.deny?.some(matchesTool) || !saved)
							throw new Error("approval_expired");
						expectedPolicyVersion = version;
						configuredInvocation = saved;
					},
				};
		}
		const toolAuthority = () => {
			const provided = adapters.approvalToolAuthority?.(registration);
			if (provided) return provided;
			const localResources = files?.resources ?? [];
			return {
				ceiling: [
					{ operation: "invoke", target: registration.name } as const,
					...paidNetwork,
					...localResources.filter(
						(resource) =>
							resource.operation !== "write" || workspaceAccess !== "forbid",
					),
				],
				granted: [
					...(localRead || localDevelopment || configuredInvocation
						? [{ operation: "invoke", target: registration.name } as const]
						: []),
					...localResources.filter(
						(resource) =>
							resource.operation === "read" || workspaceAccess === "granted",
					),
				],
				launchRule: localRead
					? "builtin_operation_v1"
					: localDevelopment && (tool !== "apply_patch" || ordinaryPatch)
						? "builtin_development_v1"
						: configuredInvocation
							? "configured_tool_allow"
							: undefined,
			};
		};
		const check = () => {
			const authority = toolAuthority();
			return {
				valid: !!args,
				owned: registration.kind !== "client" || state.activeRunId !== null,
				registered: true,
				enforceable: files?.enforceable ?? true,
				explicitDeny: explicitlyDenied
					? "legacy_deny_rule"
					: tool !== "read" &&
							adapters.approvalToolAuthority &&
							builtinReads.has("read") &&
							files?.resources.some(
								({ operation, target }) =>
									operation === "read" && !readAuthority("read", target),
							)
						? "outside_read_authority"
						: undefined,
				profile: (registration.paidExternal
					? "host_managed"
					: localRead
						? "investigation"
						: builtin
							? "development"
							: "host_managed") as ExecutionProfile,
				requested: [
					target,
					...(files?.resources ?? []),
					...paidNetwork,
					...effectResources,
				],
				...(registration.paidExternal || effectKind === "external_update"
					? { humanOnly: "external_mutation" as const }
					: {}),
				...(effectKind === "dependency_read"
					? { reviewCategory: "dependency_read" as const }
					: {}),
				ceiling:
					state.sandboxMode.value === "readonly"
						? authority.ceiling.filter(({ operation }) => operation !== "write")
						: authority.ceiling,
				granted: authority.granted,
				opaque: opaque && !authority.launchRule,
				launchRule: authority.launchRule,
			};
		};
		try {
			return await dispatcher.dispatch({
				request: {
					id: randomUUID(),
					owner,
					origin,
					subject: tool,
					registration: registration.id,
					input: raw,
					authorityVersion: String(state.approvalAuthorityGeneration),
					intentVersion: context,
					connectionGeneration: String(generation),
					runId: state.activeRunId ?? undefined,
				},
				evaluate: check,
				stillCurrent: current,
				...(save ? { save } : {}),
				preview: () => previewInvocation(tool, raw, builtin),
				...(workspaceGrant ? { grantSession: workspaceGrant } : {}),
				signal: state.approvalSignal(ctx.signal),
				execute: (consume) => {
					recordApprovalWait();
					return execute(consume);
				},
				deferConsumption: files?.deferConsumption,
			});
		} finally {
			recordApprovalWait();
		}
	};
	const authorize = async (
		origin: ApprovalOrigin,
		call: Parameters<ToolPermissionHook>[0],
		raw: string,
		ctx: ToolContext,
	) => {
		const name = call.function.name;
		const bound = internalCalls.get(ctx);
		if (
			bound
				? bound.registration.name !== name
				: name !== "task_spawn" || !builtinNames.has(name)
		)
			return { decision: "deny" as const, reason: "unregistered_tool" };
		try {
			return await dispatch(
				bound?.registration ?? {
					id: `internal/${name}/1`,
					name,
					kind: "builtin",
				},
				origin,
				raw,
				ctx,
				() => ({ decision: "allow" as const }),
				bound?.files,
			);
		} catch (error) {
			if (error instanceof ToolPermissionDenied) return error.decision;
			throw error;
		}
	};
	const wrap = (
		tool: Tool,
		kind: Registration["kind"],
		internal = false,
	): Tool => {
		const builtinPatch = kind === "builtin" && isBuiltinApplyPatch(tool);
		const registration: Registration = Object.freeze({
			id: randomUUID(),
			name: tool.name,
			kind,
			...(kind === "client" && isNativeTuiClientTool(tool)
				? { nativeClientUi: true as const }
				: {}),
			...(kind === "builtin" &&
			internal &&
			(tool.name === "decision" || tool.name === "image_generate")
				? { paidExternal: true as const }
				: {}),
		});
		if (
			kind === "builtin" &&
			(tool.name === "read" || tool.name === "read_line")
		)
			builtinReads.set(tool.name, registration);
		const wrapped: Tool = {
			...tool,
			async executeRaw(raw, context) {
				const operatorId = getOperatorContext(context);
				const invocationContext = state.approvalContext();
				context.signal?.throwIfAborted();
				const prepared = prepareToolInvocation(tool, raw);
				if (!prepared) tool.validateRaw?.(raw);
				const patchUsesRegisteredHandler =
					builtinPatch && prepared !== undefined;
				const invocationInput = prepared
					? serializeApprovalInput(prepared.input)
					: raw;
				const scope =
					builtinNames.has(tool.name) && kind === "builtin" && sandboxKey
						? fileRequests(tool.name, invocationInput)
						: [];
				let ctx = context;
				let files: BoundFiles | undefined;
				if (scope.length && sandboxKey) {
					const sandbox = await context.resolve(sandboxKey);
					const selected = scope.map((entry) =>
						sandbox.selectFile(
							entry.operand,
							entry.access,
							entry.patchKind === "delete" || entry.patchKind === "move",
						),
					);
					const patchPreview =
						patchUsesRegisteredHandler &&
						selected.every(({ access }) => access === "read");
					if (
						patchPreview &&
						selected.some(({ target }) => !isWithin(sandbox.rootDir, target))
					)
						throw new Error("Patch preview path escapes the workspace");
					const ordinaryPatch =
						patchUsesRegisteredHandler &&
						sandbox.hasResourceProtection &&
						scope.every(({ patchKind }, index) =>
							patchKind === "add"
								? selected[index].identity === null
								: patchKind === "update" && selected[index].identity !== null,
						);
					if (
						patchUsesRegisteredHandler &&
						sandbox.hasResourceProtection &&
						!patchPreview
					)
						checkPatchTargetsAreIndependent(selected);
					const bound = sandbox.bindFiles(selected);
					const needsDirectoryMutation = scope.some(
						(entry, index) =>
							entry.requiresDirectoryMutation ||
							(entry.access === "write" && selected[index].identity === null),
					);
					const enforceable =
						!needsDirectoryMutation || sandbox.supportsDirectoryMutation();
					files = {
						current: () => bound.fileBindingsCurrent(),
						resources: selected.map(({ target, access }) => ({
							operation: access,
							target,
						})),
						enforceable,
						...(patchUsesRegisteredHandler
							? {
									deferConsumption: true,
									ordinaryPatch,
									patchPreview,
								}
							: {}),
					};
					ctx = {
						...context,
						resolve: <T>(key: DependencyKey<T>) =>
							key === sandboxKey
								? Promise.resolve(bound as T)
								: context.resolve(key),
					};
					if (operatorId) setOperatorContext(ctx, operatorId);
				}
				if (
					state.approvalContext() !== invocationContext ||
					context.signal?.aborted
				)
					throw new Error("approval_expired");
				if (internal) {
					// This exact handler has its own gate and receives the bound operands.
					ctx = { ...ctx };
					if (operatorId) setOperatorContext(ctx, operatorId);
					internalCalls.set(ctx, { registration, files });
					return prepared ? prepared.execute(ctx) : tool.executeRaw(raw, ctx);
				}
				return dispatch(
					registration,
					operatorId ? "operator" : "parent_agent",
					invocationInput,
					ctx,
					(consume) => {
						if (patchUsesRegisteredHandler && files?.deferConsumption)
							bindPatchAdmission(ctx, consume);
						return prepared ? prepared.execute(ctx) : tool.executeRaw(raw, ctx);
					},
					files,
				);
			},
		};
		securedTools.add(wrapped);
		return wrapped;
	};
	const dispatchChildFile = <T>(
		name: "write" | "edit",
		raw: string,
		ctx: ToolContext,
		bound: SandboxContext,
		selected: FileSelection,
		execute: (consume: () => void) => T | Promise<T>,
	): Promise<T> =>
		dispatch(
			{ id: `builtin/child/${name}/1`, name, kind: "builtin" },
			"child_agent",
			raw,
			ctx,
			execute,
			{
				current: () => bound.fileBindingsCurrent(),
				resources: [{ operation: selected.access, target: selected.target }],
				enforceable:
					selected.identity !== null || bound.supportsDirectoryMutation(),
				deferConsumption: true,
			},
		);
	const readAuthority = (
		name: "read" | "read_line",
		target: string,
	): boolean => {
		const registration = builtinReads.get(name);
		if (!registration) return false;
		const authority = adapters.approvalToolAuthority?.(registration);
		return (
			!authority ||
			[
				{ operation: "invoke", target: name } as const,
				{ operation: "read", target } as const,
			].every(
				(resource) =>
					coversApprovalResource(authority.ceiling, resource) &&
					coversApprovalResource(authority.granted, resource),
			)
		);
	};
	return Object.assign(authorize, { wrap, dispatchChildFile, readAuthority });
};
