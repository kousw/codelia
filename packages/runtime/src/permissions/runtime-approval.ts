import { realpathSync } from "node:fs";
import path from "node:path";
import type { SandboxMode } from "@codelia/shared-types";
import { debugLog, log } from "../logger";
import { requestUiPick } from "../rpc/ui-requests";
import type { RuntimeState } from "../runtime-state";
import { createDirectoryMutationBroker } from "../sandbox/file-mutations";
import {
	ApprovalDispatcher,
	type ApprovalService,
	type SessionGrant,
} from "./dispatch";
import { LaunchRuleStore } from "./launch-rules";
import { runtimeLocalAutoReview } from "./local-reviewer";
import {
	localShellInstallPaths,
	protectsAdditionalWritePaths,
} from "./local-shell-installation";
import { shellPolicySnapshot, shellPolicyVersion } from "./policy-index";
import { reviewDiagnosticText } from "./review-failure";
import { runtimeResourcePolicy } from "./runtime-resource-policy";
import {
	createShellAuthorizer,
	defaultShellAuthority,
	type ShellAuthorizer,
} from "./shell-approval";
import {
	directoryIdentity,
	MacSeatbeltBackend,
	macAdditionalWriteLauncherPaths,
	selectProtectedShellBackend,
	shellBinPaths,
	UserShellBackend,
	workspacePathProtection,
} from "./shell-backend";

export const runtimeShellBackend = (
	{ sourcePreset, adapters }: RuntimeState["effectiveEnvironment"],
	mode: SandboxMode = "workspace-write",
) =>
	mode === "full-access" &&
	sourcePreset === "tui-local" &&
	!adapters.shellProtectionBackend
		? new UserShellBackend()
		: selectProtectedShellBackend({
				macBackend:
					process.env.CODELIA_MAC_SHELL_BACKEND === "mxc" ? "mxc" : "seatbelt",
				allowStandard: sourcePreset === "tui-local",
				adapter: adapters.shellProtectionBackend,
			});

export const configuredWorkspaceWrite = (
	state: RuntimeState,
	mode: SandboxMode = state.sandboxMode.value,
): "forbid" | "confirm" | "granted" =>
	mode === "readonly"
		? "forbid"
		: (state.effectiveEnvironment.adapters.approvalShellAuthority
				?.workspaceWrite ?? "granted");

const workspaceGrants = new WeakMap<RuntimeState, Map<string, string>>();
export const hasWorkspaceWriteGrant = (
	state: RuntimeState,
	workspace: string,
): boolean =>
	workspaceGrants.get(state)?.get(state.sessionId ?? "operator") === workspace;
export const removeWorkspaceWriteGrant = (
	state: RuntimeState,
	workspace: string,
): boolean => {
	if (!hasWorkspaceWriteGrant(state, workspace)) return false;
	const removed =
		workspaceGrants.get(state)?.delete(state.sessionId ?? "operator") === true;
	if (removed) {
		state.reviseApprovalAuthority();
	}
	return removed;
};

export const runtimeWorkspaceGrant = (
	state: RuntimeState,
	workspace: string,
	owner: string,
): SessionGrant => ({
	description: `Workspace writes under ${workspace} for this session.`,
	commit: () => {
		const grants = workspaceGrants.get(state) ?? new Map<string, string>();
		grants.set(owner, workspace);
		workspaceGrants.set(state, grants);
	},
});

const ruleStores = new WeakMap<RuntimeState, LaunchRuleStore>();
export const runtimeLaunchRules = (state: RuntimeState): LaunchRuleStore => {
	const existing = ruleStores.get(state);
	if (existing) return existing;
	const store =
		state.effectiveEnvironment.adapters.approvalLaunchRuleStore ??
		new LaunchRuleStore();
	ruleStores.set(state, store);
	return store;
};

const confirmationReasons: Readonly<Record<string, string>> = {
	additional_resources: "This request needs access that has not been granted.",
	destructive: "This operation can destroy or replace existing state.",
	external_mutation:
		"This operation can change external state or contact another service.",
	policy_change: "Only a user can change this permission.",
	interactive_stdin: "Further input could change what the process runs.",
	indirect_execution:
		"This command can select or evaluate additional code that was not analyzed.",
	unrestricted_program:
		"This program can run other code with your login user's filesystem and network access.",
	unbound_working_directory:
		"The working directory for subsequent commands could not be bound to this workspace.",
	opaque_invocation:
		"The runtime could not resolve all of this invocation's operations.",
	review_denied: "Auto approve declined this command.",
	review_not_delegated: "Auto approve is unavailable for this request.",
	review_evidence_unavailable:
		"The runtime could not provide enough shareable evidence for Auto approve.",
	review_unavailable: "Auto approve did not return a usable decision.",
	review_inconclusive:
		"Auto approve could not determine whether this command fits your request.",
	ask_user: "Auto approve asks you to decide this request.",
	no_launch_rule: "No existing launch permission covers this operation.",
};

const dispatchers = new WeakMap<RuntimeState, ApprovalDispatcher>();

export const runtimeApprovalDispatcher = (
	state: RuntimeState,
): ApprovalDispatcher => {
	const cached = dispatchers.get(state);
	if (cached) return cached;
	const adapters = state.effectiveEnvironment.adapters;
	const confirmation: ApprovalService = adapters.approvalService ?? {
		available: () => !!state.uiCapabilities?.supports_structured_approval,
		confirm: async (request, signal) => {
			const labels = {
				allow_once: request.shellStage ? "Run once" : "Allow once",
				setup_allowance: "Set up future allowance…",
				deny_continue: request.shellStage ? "Skip" : "Deny and continue",
				deny_stop: "Deny and stop turn",
				save_session: request.shellStage
					? "Save for this session and run"
					: "Allow and save for this session",
				save_project: request.shellStage
					? "Save for this workspace and run"
					: "Allow and save for this project",
				grant_session: "Allow workspace writes for this session",
			} as const;
			const reason = request.reviewDiagnostic
				? reviewDiagnosticText(request.reviewDiagnostic)
				: (confirmationReasons[
						request.reviewFallback ?? request.route.reason
					] ?? "This operation requires your confirmation.");
			const shell = request.subject === "shell";
			const preview = [
				...(request.shellStage === "rule" && request.saveDescription
					? [`Future allowance: ${request.saveDescription}`, ""]
					: []),
				...(shell ? [`Command: ${request.preview}`, ""] : []),
				...(request.shellStage === "unavailable"
					? ["A reusable rule could not be prepared for this command."]
					: []),
				request.reviewReason
					? `${reason} Reviewer explanation: ${request.reviewReason}`
					: reason,
				...(request.reviewWithheldForPrivacy
					? ["Review evidence stayed local. Decide this request once."]
					: []),
				...(!shell ? [request.preview] : []),
				`Execution profile: ${request.route.profile}`,
				...request.route.additional.map(
					({ operation, target }) => `Once only: ${operation} ${target}`,
				),
				`Expires: ${new Date(request.expiresAt).toISOString()}`,
			].join("\n");
			const reply = await requestUiPick(
				state,
				{
					run_id:
						request.origin === "mcp_service"
							? undefined
							: (state.activeRunId ?? undefined),
					title:
						request.shellStage === "rule"
							? "Save this command allowance?"
							: `Approve ${request.subject}?`,
					message: preview,
					approval: true,
					items: request.choices.map((choice) => ({
						id: `${request.requestId}/${choice}`,
						label: labels[choice],
						...(choice.startsWith("save_") && request.shellStage !== "rule"
							? { detail: request.saveDescription }
							: {}),
					})),
				},
				signal,
			);
			if (!Array.isArray(reply?.ids) || reply.ids.length !== 1) return null;
			const choice = request.choices.find(
				(candidate) => reply.ids[0] === `${request.requestId}/${candidate}`,
			);
			return choice ? { requestId: request.requestId, choice } : null;
		},
	};
	const dispatcher = new ApprovalDispatcher({
		confirmation,
		review:
			adapters.approvalReviewer ??
			(state.effectiveEnvironment.sourcePreset === "tui-local"
				? runtimeLocalAutoReview(state).adapter
				: undefined),
		audit: (entry) => {
			state.recordAutoReviewFailure(entry);
			debugLog(`approval ${JSON.stringify(entry)}`);
			if (entry.state === "save_failed")
				log("The tool was approved once. The launch rule could not be saved.");
			try {
				adapters.approvalAudit?.(entry);
			} catch {
				/* Audit failures do not alter execution. */
			}
		},
	});
	dispatchers.set(state, dispatcher);
	return dispatcher;
};

export const runtimeFileMutations = async (
	state: RuntimeState,
	root: string,
	mode: SandboxMode = state.sandboxMode.value,
) => {
	if (mode === "readonly") return undefined;
	const environment = state.effectiveEnvironment;
	const adapters = environment.adapters;
	const backend = runtimeShellBackend(environment, mode);
	if (!backend) return undefined;
	const workspace = realpathSync(root);
	const resourcePolicy = await runtimeResourcePolicy(state, workspace);
	return createDirectoryMutationBroker({
		backend,
		useFixedSeatbelt: !adapters.shellProtectionBackend,
		resolveProtection: () =>
			Object.freeze({
				profile: mode === "full-access" ? "full-access" : "development",
				root: workspace,
				cwd: workspace,
				writeRoots: Object.freeze([workspace]),
				stdin: "pipe",
				...workspacePathProtection(
					workspace,
					resourcePolicy.protectedPaths,
					[],
					mode,
					false,
					resourcePolicy.readOnlyPaths,
				),
				binPaths: shellBinPaths(adapters.shellPath),
			}),
	});
};

const bindServiceDirectory = (requested: string) => {
	const resolved = realpathSync(requested);
	const identity = directoryIdentity(resolved);
	return {
		resolved,
		current: () => {
			try {
				return (
					realpathSync(requested) === resolved &&
					directoryIdentity(resolved) === identity
				);
			} catch {
				return false;
			}
		},
	};
};

export const authorizeRuntimeShell =
	(state: RuntimeState): ShellAuthorizer =>
	async (input, execute) => {
		const requestedRoot = state.runtimeSandboxRoot ?? state.runtimeWorkingDir;
		if (!requestedRoot) throw new Error("sandbox_unavailable");
		const environment = state.effectiveEnvironment;
		const service = input.origin === "mcp_service";
		// Resolve both directory operands before any policy lookup can suspend.
		const serviceRoot = service
			? bindServiceDirectory(requestedRoot)
			: undefined;
		const serviceCwd = service ? bindServiceDirectory(input.cwd) : undefined;
		const root = serviceRoot?.resolved ?? requestedRoot;
		const scope = service ? "workspace" : "session";
		const context = () => {
			if (
				environment !== state.effectiveEnvironment ||
				serviceRoot?.current() === false ||
				serviceCwd?.current() === false
			)
				return null;
			return state.approvalContext(scope);
		};
		const snapshot = context();
		if (snapshot === null) throw new Error("approval_expired");
		const receiptScope = state.approvalReceiptScope(scope);
		const signal = state.approvalSignal(input.signal, scope);
		const adapters = environment.adapters;
		const mode =
			input.origin === "child_agent" && input.childSandboxCeiling === "readonly"
				? "readonly"
				: state.sandboxMode.value;
		const sandboxMode =
			mode === "full-access" &&
			(input.origin === "child_agent" ||
				input.origin === "startup" ||
				input.origin === "mcp_service")
				? "workspace-write"
				: mode;
		const backend = runtimeShellBackend(environment, sandboxMode);
		if (!backend) throw new Error("sandbox_unavailable");
		const currentPolicyVersion = () => shellPolicyVersion(state, root, scope);
		const version = currentPolicyVersion();
		const checkedContext = () => {
			if (context() !== snapshot) throw new Error("approval_expired");
			return snapshot;
		};
		const [policy, resourcePolicy] = await Promise.all([
			shellPolicySnapshot(state, root, version),
			runtimeResourcePolicy(state, root),
		]);
		const checkedPolicy = () => {
			if (currentPolicyVersion() !== version)
				throw new Error("approval_expired");
			return policy;
		};
		if (
			backend instanceof UserShellBackend &&
			resourcePolicy.hostProtectedPaths.length
		)
			throw new Error("protected_paths_require_shell_isolation");
		checkedContext();
		checkedPolicy();
		if (signal.aborted) throw new Error("approval_expired");
		if (
			(input.origin === "child_agent" ||
				(input.origin === "parent_agent" && input.owner !== undefined)) &&
			state.sessionId !== input.owner
		)
			throw new Error("owner_mismatch");
		const store =
			environment.sourcePreset === "tui-local" ||
			adapters.approvalLaunchRuleStore
				? runtimeLaunchRules(state)
				: undefined;
		const workspace = realpathSync(root);
		const owner = service
			? "workspace"
			: (input.owner ?? state.sessionId ?? "operator");
		const hostAuthority =
			adapters.approvalShellAuthority ??
			(environment.sourcePreset === "tui-local"
				? {
						...defaultShellAuthority,
						extraWriteCeiling: [path.parse(workspace).root],
					}
				: defaultShellAuthority);
		const authority = {
			...hostAuthority,
			workspaceWrite: configuredWorkspaceWrite(state, sandboxMode),
		};
		const workspaceGrant =
			sandboxMode === "workspace-write" &&
			input.origin !== "child_agent" &&
			input.origin !== "startup" &&
			input.origin !== "mcp_service" &&
			authority.workspaceWrite === "confirm"
				? runtimeWorkspaceGrant(state, workspace, owner)
				: undefined;
		const localAutoReview =
			environment.sourcePreset === "tui-local" &&
			!service &&
			!adapters.approvalReviewer &&
			state.activeRunId !== null &&
			(!input.runId || input.runId === state.activeRunId)
				? runtimeLocalAutoReview(state)
				: undefined;
		const authorize = createShellAuthorizer({
			root,
			backend,
			sandboxMode,
			shellPath: adapters.shellPath,
			allowSharedGitObjects:
				state.sandboxMode.value === "workspace-write" &&
				environment.sourcePreset === "tui-local" &&
				!adapters.shellProtectionBackend &&
				backend instanceof MacSeatbeltBackend,
			allowsAdditionalWrite:
				environment.sourcePreset === "tui-local"
					? (protection, additional) =>
							protectsAdditionalWritePaths(additional, [
								...localShellInstallPaths(),
								...(backend instanceof MacSeatbeltBackend
									? macAdditionalWriteLauncherPaths(protection)
									: []),
							])
					: undefined,
			requireAnalysis: adapters.approvalRequireAnalysis,
			resolveSource: adapters.approvalShellSource,
			autoReviewEnabled: localAutoReview
				? () => localAutoReview.isEnabled(workspace)
				: undefined,
			confinedLaunchRevision:
				localAutoReview && owner === state.sessionId
					? () => localAutoReview.confinedLaunchRevision(workspace)
					: undefined,
			confinedLaunchUnavailable:
				localAutoReview && owner === state.sessionId
					? () => localAutoReview.confinedLaunchUnavailable(workspace)
					: undefined,
			extraProtectedPaths:
				sandboxMode === "full-access"
					? resourcePolicy.hostProtectedPaths
					: resourcePolicy.protectedPaths,
			extraReadOnlyPaths: resourcePolicy.readOnlyPaths,
			extraReviewPrivatePaths: [
				...resourcePolicy.protectedPaths,
				...resourcePolicy.readOnlyPaths,
			],
			authority:
				!service &&
				hasWorkspaceWriteGrant(state, workspace) &&
				authority.workspaceWrite !== "forbid"
					? { ...authority, workspaceWrite: "granted" }
					: authority,
			launchRules: store,
			proposeLaunchRule:
				environment.sourcePreset === "tui-local" &&
				state.uiCapabilities?.supports_structured_approval &&
				!adapters.approvalService &&
				!adapters.approvalReviewer
					? (request, words, signal) =>
							runtimeLocalAutoReview(state).proposeLaunchRule(
								request,
								words,
								signal,
							)
					: undefined,
			dispatcher: runtimeApprovalDispatcher(state),
			policy: checkedPolicy,
			context: checkedContext,
		});
		return authorize(
			{
				...input,
				cwd: serviceCwd?.resolved ?? input.cwd,
				receiptScope,
				owner,
				grantWorkspaceForSession: workspaceGrant,
				signal,
				runId: service
					? undefined
					: (input.runId ?? state.activeRunId ?? undefined),
			},
			execute,
		);
	};
