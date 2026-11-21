import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { PermissionRule } from "@codelia/config";
import type { SandboxMode } from "@codelia/shared-types";
import { localAllowStillCurrent } from "../local-permission-allows";
import { terminateChild } from "../tasks/shell-executor";
import {
	ApprovalDispatcher,
	type ApprovalRequest,
	type SessionGrant,
} from "./dispatch";
import {
	bindSuggestedLaunch,
	buildExactLaunchCandidate,
	exactCommandWords,
	fileIdentity,
	type LaunchRuleStore,
	type LaunchRuleSuggestion,
	legacyLocalTestEvidence,
} from "./launch-rules";
import { prepareMcpServiceEnvironment } from "./mcp-service-environment";
import type { ApprovalReceiptScope } from "./request-receipts";
import { resourceContainsPath } from "./resource-paths";
import {
	type ReviewHistoryReferences,
	validateRuleSuggestionEvidence,
} from "./review-evidence";
import { reviewDiagnostic } from "./review-failure";
import type { ApprovalFacts, ApprovalOrigin, Resource } from "./route";
import { matchesShellAllow } from "./shell-allow";
import {
	analyzeShell,
	isSimpleAndChain,
	type ShellInvocation,
	singleCommandWords,
} from "./shell-analysis";
import {
	canonicalPolicyPaths,
	directoryIdentity,
	isWithin,
	type ProtectedShellBackend,
	platformShellSource,
	resolveShellExecutable,
	type ShellChild,
	type ShellProtection,
	selectProtectedShellBackend,
	shellBinPaths,
	supportsProtectedShell,
	workspacePathProtection,
} from "./shell-backend";
import {
	classifyShellOperations,
	hasNonExecutingOperands,
} from "./shell-command-policy";
import {
	areAllExecutableLinksOutsideRestrictedPaths,
	bindBashCommand,
	bindKnownSystemExecutable,
	isRootControlledSharedExecutable,
} from "./shell-path";
import { resolveSystemBash } from "./system-bash";
import { toolchainHomes } from "./toolchain-homes";
import { isShellPermissionRule, matchBashRule } from "./utils";

export type ShellAuthority = Readonly<{
	investigation: boolean;
	workspaceWrite: "forbid" | "confirm" | "granted";
	stdinPipe: "forbid" | "confirm" | "granted";
	extraWriteCeiling?: readonly string[];
}>;

export const defaultShellAuthority: ShellAuthority = Object.freeze({
	investigation: true,
	workspaceWrite: "confirm",
	stdinPipe: "forbid",
});

export type ShellAdmission = (taskId?: string) => ShellChild;

export type ShellApprovalInput = {
	cwd: string;
	stdin?: "closed" | "pipe";
	timeoutSeconds?: number;
	origin: ApprovalOrigin;
	id?: string;
	receiptScope?: ApprovalReceiptScope;
	owner?: string;
	signal?: AbortSignal;
	deny?: readonly PermissionRule[];
	binding?: string;
	runId?: string;
	reviewHistory?: ReviewHistoryReferences;
	trustedService?: boolean;
	mcpServiceEnvironment?: Readonly<Record<string, string>>;
	grantWorkspaceForSession?: SessionGrant;
	additionalWriteRoots?: readonly string[];
	/** Initial ceiling of an admitted child, supplied only by its parent channel. */
	childSandboxCeiling?: "readonly" | "workspace-write";
} & (
	| { source: string; argv?: never }
	| { argv: readonly string[]; source?: never }
);

export type ShellAuthorizer = <T>(
	input: ShellApprovalInput,
	execute: (admission: ShellAdmission) => T | Promise<T>,
) => Promise<T>;

const safePreview = (invocation: ShellInvocation): string =>
	invocation.kind === "source"
		? invocation.source
		: JSON.stringify([invocation.executable, ...invocation.args]);

const isFixedBashInvocation = (
	invocation: Extract<ShellInvocation, { kind: "source" }>,
) =>
	invocation.dialect === "bash" &&
	invocation.options.length === 3 &&
	invocation.options[0] === "--noprofile" &&
	invocation.options[1] === "--norc" &&
	invocation.options[2] === "-c" &&
	invocation.executable === resolveSystemBash();

const fixedBashBuiltins = new Set([
	"pwd",
	"true",
	"false",
	"echo",
	"printf",
	"set",
]);

export const createShellAuthorizer =
	({
		root,
		backend = selectProtectedShellBackend({ allowStandard: true }),
		dispatcher = new ApprovalDispatcher(),
		policy = () => ({}),
		context = () => "",
		requireAnalysis,
		extraProtectedPaths = [],
		extraReadOnlyPaths = [],
		extraReviewPrivatePaths = [],
		authority = defaultShellAuthority,
		sandboxMode = "workspace-write",
		shellPath,
		launchRules,
		proposeLaunchRule,
		resolveSource = platformShellSource,
		autoReviewEnabled,
		confinedLaunchRevision,
		confinedLaunchUnavailable,
		allowSharedGitObjects = false,
	}: {
		root: string;
		backend?: ProtectedShellBackend;
		dispatcher?: ApprovalDispatcher;
		policy?: () => {
			allow?: readonly PermissionRule[];
			deny?: readonly PermissionRule[];
			version?: string;
		};
		context?: () => string;
		requireAnalysis?: boolean;
		extraProtectedPaths?: readonly string[];
		extraReadOnlyPaths?: readonly string[];
		extraReviewPrivatePaths?: readonly string[];
		authority?: ShellAuthority;
		sandboxMode?: SandboxMode;
		shellPath?: string;
		launchRules?: LaunchRuleStore;
		proposeLaunchRule?: (
			request: ApprovalRequest,
			words: readonly string[],
			signal: AbortSignal,
		) => Promise<LaunchRuleSuggestion | undefined>;
		resolveSource?: (source: string) => ShellInvocation;
		autoReviewEnabled?: () => boolean;
		confinedLaunchRevision?: () => string | undefined;
		confinedLaunchUnavailable?: () => boolean;
		allowSharedGitObjects?: boolean;
	}): ShellAuthorizer =>
	async (input, execute) => {
		if (!backend) throw new Error("sandbox_unavailable");
		const cwd = realpathSync(input.cwd);
		const workspace = realpathSync(root);
		const cwdIdentity = directoryIdentity(cwd);
		const rootIdentity = directoryIdentity(workspace);
		const stdin = input.stdin ?? "closed";
		const binPaths = shellBinPaths(shellPath);
		const extraWrite = [
			...new Set(
				(input.additionalWriteRoots ?? []).map((entry) =>
					realpathSync(path.resolve(cwd, entry)),
				),
			),
		];
		const writeCeiling =
			sandboxMode === "readonly"
				? []
				: (authority.extraWriteCeiling ?? []).map((entry) =>
						realpathSync(entry),
					);
		const requestedExecutable = input.argv?.[0];
		const invocation: ShellInvocation =
			input.source !== undefined
				? (() => {
						const selected = resolveSource(input.source);
						if (selected.kind !== "source" || selected.source !== input.source)
							throw new Error("unbound_shell_source");
						return Object.freeze({
							...selected,
							options: Object.freeze([...selected.options]),
						});
					})()
				: Object.freeze({
						kind: "argv",
						executable: resolveShellExecutable(input.argv[0], binPaths, cwd),
						args: Object.freeze(input.argv.slice(1)),
					});
		const original = input.source ?? JSON.stringify(input.argv);
		const requestedCommand = input.argv?.join(" ");
		const serviceEnvironment = input.mcpServiceEnvironment;
		if (
			serviceEnvironment &&
			(input.origin !== "mcp_service" || stdin !== "pipe")
		)
			throw new Error("Invalid MCP service environment request");
		const serviceLaunch =
			serviceEnvironment && Object.keys(serviceEnvironment).length > 0
				? prepareMcpServiceEnvironment(invocation, serviceEnvironment)
				: undefined;
		const serviceLauncherIdentity = serviceLaunch
			? fileIdentity(serviceLaunch.invocation.executable)
			: undefined;
		const analyzed = analyzeShell(invocation);
		const trustedBun = (() => {
			if (
				!analyzed.operations.some(
					({ argv }) => path.basename(argv[0]) === "bun",
				)
			)
				return undefined;
			try {
				return resolveShellExecutable("bun", binPaths, cwd);
			} catch {
				return undefined;
			}
		})();
		const analysis = {
			...analyzed,
			operations: analyzed.operations.map((operation) => {
				const [command, ...args] = operation.argv;
				return trustedBun && command === trustedBun
					? { ...operation, argv: ["bun", ...args] }
					: operation;
			}),
		};
		const invocationIdentity = (() => {
			try {
				return fileIdentity(invocation.executable);
			} catch {
				return undefined;
			}
		})();
		const effects = classifyShellOperations(analysis);
		const destructive = effects.humanOnly === "destructive";
		const externalMutation = effects.humanOnly === "external_mutation";
		const service = input.origin === "mcp_service";
		const operatorProbe = input.origin === "startup" || service;
		const profile: ShellProtection["profile"] =
			sandboxMode === "full-access"
				? "full-access"
				: sandboxMode !== "readonly" &&
						(!effects.investigation ||
							stdin === "pipe" ||
							extraWrite.length > 0) &&
						!operatorProbe
					? "development"
					: "investigation";
		const resolvePathProtection = () =>
			profile === "full-access"
				? {
						protectedPaths: canonicalPolicyPaths(extraProtectedPaths),
						readOnlyPaths: canonicalPolicyPaths(extraReadOnlyPaths),
					}
				: workspacePathProtection(
						workspace,
						extraProtectedPaths,
						[cwd, ...extraWrite],
						sandboxMode,
						allowSharedGitObjects &&
							profile === "development" &&
							extraWrite.length === 0,
						extraReadOnlyPaths,
					);
		const pathProtection = resolvePathProtection();
		const { protectedPaths } = pathProtection;
		const pathBinding = JSON.stringify(pathProtection);
		const rustHomes =
			profile === "full-access"
				? toolchainHomes(process.env, null)
				: toolchainHomes();
		const protection: ShellProtection = Object.freeze({
			profile,
			root: workspace,
			cwd,
			...pathProtection,
			stdin,
			binPaths,
			...(rustHomes.CARGO_HOME || rustHomes.RUSTUP_HOME
				? { toolchainHomes: rustHomes }
				: {}),
			writeRoots: Object.freeze(
				profile === "development" ? [workspace, ...extraWrite] : [],
			),
		});
		const fixedShell =
			invocation.kind === "source" && isFixedBashInvocation(invocation);
		const unboundCommandPaths = [
			workspace,
			...extraWrite,
			...(profile === "full-access"
				? []
				: process.platform === "darwin"
					? ["/dev"]
					: ["/dev", "/proc", "/sys"]),
		];
		const maskedCommandPaths = [
			...protectedPaths,
			...(profile === "full-access"
				? []
				: [process.platform === "darwin" ? "/private/var/run" : "/run"]),
		];
		const commandPathPolicy = (target: string) => {
			if (
				unboundCommandPaths.some((entry) => resourceContainsPath(entry, target))
			)
				return "unbound";
			if (
				maskedCommandPaths.some((entry) => resourceContainsPath(entry, target))
			)
				return "masked";
		};
		const bindKnownCommands = (): string | undefined => {
			if (invocation.kind === "source" && !fixedShell) return undefined;
			try {
				if (backend.supportsCommandBinding !== true) return undefined;
				const commands = new Set(
					analysis.operations.map(({ argv }) => argv[0]),
				);
				const identities: string[] = [];
				for (const command of commands) {
					if (fixedShell && fixedBashBuiltins.has(command)) continue;
					const executable = bindKnownSystemExecutable(
						command,
						binPaths,
						commandPathPolicy,
						invocation.kind === "argv",
					);
					if (!executable) return undefined;
					identities.push(fileIdentity(executable));
				}
				return JSON.stringify(identities);
			} catch {
				return undefined;
			}
		};
		const knownCommands =
			effects.localRead || effects.fullAccessInspectable
				? bindKnownCommands()
				: undefined;
		const localRead = effects.localRead && knownCommands !== undefined;
		const resource: Resource = Object.freeze(
			profile === "full-access"
				? { operation: "invoke", target: "shell.full-access" }
				: {
						operation: profile === "development" ? "write" : "read",
						target: workspace,
					},
		);
		const owner = input.owner ?? "runtime";
		const additional: Resource[] = extraWrite
			.filter((target) => !isWithin(workspace, target))
			.map((target) => Object.freeze({ operation: "write", target }));
		const stdinResource: Resource = Object.freeze({
			operation: "invoke",
			target: "shell.stdin",
		});
		const resources = Object.freeze([
			resource,
			...additional,
			...(stdin === "pipe" ? [stdinResource] : []),
		]);
		const isDevelopment = profile === "development";
		const workspacePolicy =
			profile === "full-access"
				? authority.workspaceWrite === "forbid" || !authority.investigation
					? "forbid"
					: "granted"
				: isDevelopment
					? authority.workspaceWrite
					: authority.investigation
						? "granted"
						: "forbid";
		const stdinPolicy = service
			? "granted"
			: input.origin === "child_agent"
				? "forbid"
				: authority.stdinPipe;
		const ceiling = Object.freeze([
			...(workspacePolicy !== "forbid" ? [resource] : []),
			...(stdinPolicy !== "forbid" ? [stdinResource] : []),
			...(input.origin === "child_agent"
				? []
				: additional.filter(
						({ target }) =>
							writeCeiling.some((allowed) => isWithin(allowed, target)) &&
							!protectedPaths.some((item) => isWithin(item, target)),
					)),
		]);
		const grant = Object.freeze([
			...(workspacePolicy === "granted" ? [resource] : []),
			...(stdinPolicy === "granted" ? [stdinResource] : []),
		]);
		const writeIdentities = extraWrite.map(directoryIdentity);
		const confinedRuleScope =
			profile !== "full-access" &&
			workspacePolicy === "granted" &&
			(input.origin === "parent_agent" || input.origin === "operator") &&
			stdin === "closed" &&
			extraWrite.length === 0 &&
			!effects.humanOnly &&
			!effects.indirectExecution &&
			process.platform !== "win32" &&
			(invocation.kind === "argv" || fixedShell);
		const canBindLaunch =
			confinedRuleScope &&
			!!launchRules &&
			!!backend.exactLaunchBindingId &&
			backend.supportsExactLaunchBinding !== undefined;
		const builtinWords =
			confinedRuleScope && fixedShell && backend.supportsCommandBinding === true
				? singleCommandWords(invocation, analyzed)
				: undefined;
		const boundBuiltin =
			builtinWords && fixedBashBuiltins.has(builtinWords[0])
				? builtinWords
				: undefined;
		const words = canBindLaunch
			? exactCommandWords(invocation, analyzed)
			: undefined;
		const bindLaunchExecutable = () => {
			if (!words) return undefined;
			const binding = bindBashCommand(
				requestedExecutable ?? words[0],
				binPaths,
				commandPathPolicy,
				(file, info) =>
					isRootControlledSharedExecutable(file, info) ||
					areAllExecutableLinksOutsideRestrictedPaths(
						file,
						info,
						commandPathPolicy,
					),
			);
			return invocation.kind === "argv" &&
				binding?.executable !== invocation.executable
				? undefined
				: binding;
		};
		const initialLaunchBinding = bindLaunchExecutable();
		const initialBackendIdentity = backend.exactLaunchBindingId;
		const candidate = (() => {
			if (
				!words ||
				profile === "full-access" ||
				(input.origin !== "parent_agent" && input.origin !== "operator")
			)
				return undefined;
			try {
				const binding = initialLaunchBinding;
				if (!binding) return undefined;
				const { executable } = binding;
				const candidate = buildExactLaunchCandidate(
					{
						project: workspace,
						cwd,
						executable,
						argv0: words[0],
						args: words.slice(1),
						origin: input.origin,
						profile,
						authority: createHash("sha256")
							.update(
								JSON.stringify([
									sandboxMode,
									rootIdentity,
									cwdIdentity,
									protection,
									ceiling,
									grant,
									backend.exactLaunchBindingId,
									binding.lookupPath,
									invocation.executable,
									invocationIdentity,
									invocation.kind === "source" ? invocation.options : [],
									input.deny ?? [],
									policy().deny ?? [],
								]),
							)
							.digest("hex"),
					},
					invocation,
				);
				return candidate &&
					backend.supportsExactLaunchBinding?.(candidate, protection) ===
						true &&
					supportsProtectedShell(backend, protection, candidate.invocation)
					? candidate
					: undefined;
			} catch {
				return undefined;
			}
		})();

		const interactive =
			proposeLaunchRule &&
			profile !== "full-access" &&
			(input.origin === "parent_agent" || input.origin === "operator");
		const configuredWords =
			candidate && words
				? requestedExecutable
					? [requestedExecutable, ...words.slice(1)]
					: words
				: boundBuiltin;
		const directoryChange = analysis.operations.find(({ argv }) =>
			["cd", "pushd", "popd"].includes(argv[0]),
		);
		const cdOperand = directoryChange?.argv[1];
		const resolveReviewedDirectory = () => {
			if (!cdOperand) return undefined;
			try {
				const resolved = realpathSync(path.resolve(cwd, cdOperand));
				return isWithin(workspace, resolved) &&
					!protectedPaths.some((entry) => isWithin(entry, resolved))
					? { path: resolved, identity: directoryIdentity(resolved) }
					: undefined;
			} catch {
				return undefined;
			}
		};
		let reviewed: ReturnType<typeof resolveReviewedDirectory>;
		if (
			directoryChange &&
			invocation.kind === "source" &&
			isSimpleAndChain(invocation.source, analysis) &&
			analysis.operations[0] === directoryChange &&
			directoryChange.argv[0] === "cd" &&
			directoryChange.argv.length === 2 &&
			cdOperand &&
			!cdOperand.startsWith("-") &&
			!path.isAbsolute(cdOperand) &&
			analysis.operations
				.slice(1)
				.every(({ argv }) => !["cd", "pushd", "popd"].includes(argv[0])) &&
			(analysis.operations.length === 2 || !effects.indirectExecution)
		) {
			reviewed = resolveReviewedDirectory();
		}
		const reviewedDirectory = reviewed?.path;
		const knownFullAccessLaunch =
			effects.fullAccessInspectable && knownCommands !== undefined;
		const opaqueReason =
			directoryChange && !reviewedDirectory
				? "unbound_working_directory"
				: !service && stdin !== "closed"
					? "interactive_stdin"
					: effects.humanOnly === "indirect_execution"
						? "indirect_execution"
						: profile === "full-access" && !knownFullAccessLaunch
							? "unrestricted_program"
							: undefined;
		const reviewable =
			!operatorProbe &&
			!analysis.opaque &&
			!opaqueReason &&
			!effects.humanOnly &&
			stdin === "closed" &&
			extraWrite.length === 0;
		// The narrow SDK reviewer delegation predates exact saved launches; an
		// opt-in to one capability must not change the scope of the other.
		const legacyTest = (() => {
			if (
				!launchRules ||
				profile !== "development" ||
				!trustedBun ||
				!backend.supportsLaunchBinding ||
				process.platform === "win32" ||
				(invocation.kind === "source" && !fixedShell) ||
				bindBashCommand("bun", binPaths, commandPathPolicy)?.executable !==
					trustedBun
			)
				return undefined;
			const candidate = legacyLocalTestEvidence({
				analysis,
				project: workspace,
				cwd,
				origin: input.origin,
				stdin,
				executable: trustedBun,
			});
			try {
				return candidate &&
					backend.supportsLaunchBinding(candidate, protection) === true
					? candidate
					: undefined;
			} catch {
				return undefined;
			}
		})();
		const matchingRule = (
			allows: readonly PermissionRule[] | undefined,
		): string | undefined => {
			const allow =
				configuredWords &&
				allows?.find(
					(rule) =>
						matchesShellAllow(
							rule,
							configuredWords,
							invocation.kind === "source" ? invocation.source : undefined,
						) && localAllowStillCurrent(rule),
				);
			if (allow)
				return `local_shell_allow/${createHash("sha256").update(JSON.stringify(allow)).digest("hex")}`;
			if (!candidate || !launchRules) return undefined;
			const saved = launchRules.match(candidate.rule, owner);
			if (saved) return saved.id;
			return legacyTest &&
				legacyTest.rule.executable === candidate.rule.executable &&
				launchRules.hasLegacy(legacyTest.rule, owner)
				? legacyTest.rule.id
				: undefined;
		};
		let reliedOnRule: string | undefined;
		const narrowTest =
			profile === "development" &&
			!analysis.compound &&
			analysis.operations[0]?.argv[0] === "bun" &&
			(!!legacyTest ||
				(analysis.operations[0].argv[1] === "test" &&
					analysis.operations[0].argv.length === 2));
		const reviewCoverageDiagnostic =
			stdin !== "closed"
				? reviewDiagnostic("review_evidence_interactive_stdin")
				: extraWrite.length > 0
					? reviewDiagnostic("review_evidence_extra_write")
					: undefined;
		const usesConfinedAutoReview =
			profile !== "full-access" && autoReviewEnabled !== undefined;
		const initialPolicy = policy();
		const initialContext = context();
		const ordinaryConfinedLaunch =
			input.origin === "parent_agent" &&
			profile !== "full-access" &&
			stdin === "closed" &&
			extraWrite.length === 0;
		const launchRevision = ordinaryConfinedLaunch
			? confinedLaunchRevision?.()
			: undefined;
		const autoLaunch = launchRevision !== undefined;
		const bindDenyOperations = () => {
			if (
				analysis.opaque ||
				(invocation.kind === "source" && !fixedShell) ||
				backend.supportsCommandBinding !== true
			)
				return undefined;
			try {
				const bound = [];
				for (const operation of effects.indirectOperations) {
					if (!hasNonExecutingOperands(operation)) return undefined;
					const [name, ...args] = operation.argv;
					const executable = bindKnownSystemExecutable(
						name,
						binPaths,
						commandPathPolicy,
						invocation.kind === "argv",
					);
					if (!executable) return undefined;
					bound.push({ executable, args, identity: fileIdentity(executable) });
				}
				return bound;
			} catch {
				return undefined;
			}
		};
		const boundDenyOperations =
			autoLaunch &&
			effects.indirectExecution &&
			[...(input.deny ?? []), ...(initialPolicy.deny ?? [])].some(
				isShellPermissionRule,
			)
				? bindDenyOperations()
				: undefined;
		const evaluate = (): ApprovalFacts => {
			const current = policy();
			const matchedRule = autoLaunch ? undefined : matchingRule(current.allow);
			if (matchedRule) reliedOnRule = matchedRule;
			const autoReview =
				!autoLaunch &&
				input.origin === "parent_agent" &&
				usesConfinedAutoReview &&
				!((localRead && profile === "investigation") || matchedRule) &&
				autoReviewEnabled?.() === true;
			const denyRules = [...(input.deny ?? []), ...(current.deny ?? [])];
			const denyMatched = denyRules.some(
				(rule) =>
					matchBashRule(rule, original) ||
					(requestedCommand !== undefined &&
						matchBashRule(rule, requestedCommand)) ||
					(!!candidate &&
						matchBashRule(
							rule,
							[candidate.rule.executable, ...candidate.rule.args].join(" "),
						)) ||
					analysis.operations.some(({ argv }) =>
						matchBashRule(rule, argv.join(" ")),
					) ||
					boundDenyOperations?.some(({ executable, args }) =>
						matchBashRule(rule, [executable, ...args].join(" ")),
					),
			);
			const denyUnverifiable =
				(analysis.opaque ||
					((autoLaunch || autoReview) &&
						((effects.indirectExecution && !boundDenyOperations) ||
							opaqueReason === "unbound_working_directory"))) &&
				denyRules.some(isShellPermissionRule);
			const explicitDeny = denyMatched
				? "legacy_deny_rule"
				: denyUnverifiable
					? "deny_rule_unverifiable"
					: undefined;
			const reviewCategory = (
				autoReview
					? reviewCoverageDiagnostic === undefined
					: !usesConfinedAutoReview && reviewable
			)
				? narrowTest
					? "local_test"
					: "local_shell"
				: undefined;
			const userLaunch =
				input.origin === "ui_bang" && !destructive && !analysis.opaque;
			return {
				valid:
					original.trim().length > 0 &&
					!original.includes("\0") &&
					Buffer.byteLength(original) <= 32 * 1024,
				owned: true,
				registered: true,
				explicitDeny:
					explicitDeny ??
					(!autoLaunch &&
					ordinaryConfinedLaunch &&
					!matchedRule &&
					confinedLaunchUnavailable?.()
						? "confined_launch_config_unavailable"
						: undefined),
				enforceable:
					invocationIdentity !== undefined &&
					supportsProtectedShell(backend, protection, invocation) &&
					(!serviceLaunch ||
						supportsProtectedShell(
							backend,
							protection,
							serviceLaunch.invocation,
						)),
				profile,
				requested: resources,
				ceiling:
					isWithin(workspace, cwd) &&
					!protectedPaths.some((item) => isWithin(item, cwd))
						? ceiling
						: [],
				granted: grant,
				opaque: analysis.opaque || (opaqueReason !== undefined && !service),
				opaqueReason,
				requireAnalysis,
				autoReview,
				confinedAutoLaunch: autoLaunch,
				...(reviewCategory ? { reviewCategory } : {}),
				...(externalMutation
					? { humanOnly: "external_mutation" as const }
					: {}),
				...(destructive ? { humanOnly: "destructive" as const } : {}),
				...(matchedRule ? { launchRule: matchedRule } : {}),
				...(service && input.trustedService
					? { launchRule: "configured_mcp_service" }
					: {}),
				...(profile !== "full-access" &&
				stdin === "closed" &&
				((localRead && profile === "investigation") ||
					userLaunch ||
					input.origin === "startup")
					? {
							launchRule:
								localRead && profile === "investigation"
									? "builtin_investigation_v1"
									: "interactive_bang",
						}
					: {}),
			};
		};
		const stillCurrent = (): boolean => {
			try {
				const currentPolicy = policy();
				const currentDirectory = reviewed && resolveReviewedDirectory();
				return (
					context() === initialContext &&
					(!autoLaunch || confinedLaunchRevision?.() === launchRevision) &&
					(!boundDenyOperations ||
						JSON.stringify(bindDenyOperations()) ===
							JSON.stringify(boundDenyOperations)) &&
					(!reviewed ||
						(currentDirectory?.path === reviewed.path &&
							currentDirectory.identity === reviewed.identity)) &&
					currentPolicy.version === initialPolicy.version &&
					realpathSync(input.cwd) === cwd &&
					realpathSync(root) === workspace &&
					directoryIdentity(cwd) === cwdIdentity &&
					directoryIdentity(workspace) === rootIdentity &&
					JSON.stringify(resolvePathProtection()) === pathBinding &&
					extraWrite.every(
						(entry, index) =>
							directoryIdentity(entry) === writeIdentities[index],
					) &&
					(knownCommands === undefined ||
						bindKnownCommands() === knownCommands) &&
					(!boundBuiltin || backend.supportsCommandBinding === true) &&
					(!fixedShell ||
						(invocation.kind === "source" &&
							isFixedBashInvocation(invocation))) &&
					(!candidate ||
						(backend.exactLaunchBindingId === initialBackendIdentity &&
							JSON.stringify(bindLaunchExecutable()) ===
								JSON.stringify(initialLaunchBinding) &&
							fileIdentity(candidate.rule.executable) ===
								candidate.rule.executableIdentity)) &&
					fileIdentity(invocation.executable) === invocationIdentity &&
					(!serviceLaunch ||
						fileIdentity(serviceLaunch.invocation.executable) ===
							serviceLauncherIdentity) &&
					(!legacyTest ||
						(bindBashCommand("bun", binPaths, commandPathPolicy)?.executable ===
							legacyTest.rule.executable &&
							fileIdentity(legacyTest.rule.executable) ===
								legacyTest.rule.executableIdentity &&
							realpathSync(path.resolve(cwd, legacyTest.operand)) ===
								legacyTest.target &&
							fileIdentity(legacyTest.target) === legacyTest.targetIdentity)) &&
					(!reliedOnRule || matchingRule(currentPolicy.allow) === reliedOnRule)
				);
			} catch {
				return false;
			}
		};
		const confirmationOptions = (() => {
			if (!candidate || !launchRules)
				return interactive ? { interactiveShell: {} } : {};
			const save = (
				proposal: NonNullable<ReturnType<typeof bindSuggestedLaunch>>,
			) => ({
				description: proposal.description,
				commit: (scope: "session" | "project") =>
					launchRules.save(proposal.rule, scope, owner),
			});
			if (!interactive) return { save: save(candidate) };
			return {
				interactiveShell: {
					propose: async (request: ApprovalRequest, signal: AbortSignal) => {
						const words = Object.freeze([
							candidate.rule.argv0,
							...candidate.rule.args,
						]);
						const suggestion = await proposeLaunchRule(request, words, signal);
						const proposal = bindSuggestedLaunch(candidate, suggestion);
						if (signal.aborted || !stillCurrent()) return undefined;
						if (proposal) return save(proposal);
						if (validateRuleSuggestionEvidence(request, workspace, words))
							return save(candidate);
						return undefined;
					},
				},
			};
		})();

		return dispatcher.dispatch({
			request: {
				id: input.id ?? randomUUID(),
				owner,
				origin: input.origin,
				subject: "shell",
				registration: "builtin.shell/1",
				input: JSON.stringify({
					invocation,
					protection,
					analysis,
					opaqueReason:
						opaqueReason ??
						(effects.indirectExecution ? "indirect_execution" : undefined),
					...(autoReviewEnabled &&
					profile !== "full-access" &&
					input.origin === "parent_agent"
						? { reviewHistory: input.reviewHistory }
						: {}),
					...(reviewedDirectory ? { reviewedDirectory } : {}),
					...((autoReviewEnabled || interactive) &&
					extraReviewPrivatePaths.length > 0
						? { reviewPrivatePaths: extraReviewPrivatePaths }
						: {}),
					cwdIdentity,
					rootIdentity,
					executableIdentity:
						candidate?.rule.executableIdentity ?? invocationIdentity,
					timeoutSeconds: input.timeoutSeconds,
					binding: input.binding,
					...(serviceLaunch
						? {
								serviceEnvironmentNames: serviceLaunch.names,
								serviceEnvironmentDigest: createHash("sha256")
									.update(serviceLaunch.frame)
									.digest("hex"),
							}
						: {}),
				}),
				authorityVersion: initialPolicy.version ?? "",
				intentVersion: initialContext,
				connectionGeneration: String(input.receiptScope?.generation ?? 0),
				runId: input.runId,
			},
			evaluate,
			stillCurrent,
			preview: () =>
				`${safePreview(invocation).replaceAll("\n", "\n  ")}\n\nWorking directory: ${cwd}\nStdin: ${stdin}\n${profile === "full-access" ? "OS sandbox off. The command can access files and the network as your user." : "Network: off"}${profile === "development" ? "\nIn-place edits to ordinary files with existing hard links are visible through those links." : ""}${serviceLaunch ? `\nMCP environment keys: ${serviceLaunch.names.join(", ")}` : ""}`,
			signal: input.signal,
			reviewRetryKey: JSON.stringify([invocation, cwd, profile, resources]),
			reviewRetryEvidenceKey: input.reviewHistory
				? JSON.stringify(input.reviewHistory)
				: undefined,
			reviewCoverageDiagnostic,
			deduplicate: input.id !== undefined,
			receiptScope: input.receiptScope,
			...(profile === "development" &&
			authority.workspaceWrite === "confirm" &&
			input.grantWorkspaceForSession
				? {
						grantSession: input.grantWorkspaceForSession,
					}
				: {}),
			...confirmationOptions,
			deferConsumption: true,
			execute: (consume, saveScope) =>
				execute((taskId) => {
					const boundLaunch = candidate && (saveScope || reliedOnRule);
					if (
						boundLaunch &&
						backend.supportsExactLaunchBinding?.(candidate, protection) !== true
					)
						throw new Error("approval_expired");
					if (
						legacyTest &&
						reliedOnRule === legacyTest.rule.id &&
						backend.supportsLaunchBinding?.(legacyTest, protection) !== true
					)
						throw new Error("approval_expired");
					const launch = boundLaunch ? candidate.invocation : invocation;
					if (!supportsProtectedShell(backend, protection, launch))
						throw new Error("sandbox_unavailable");
					if (
						serviceLaunch &&
						!supportsProtectedShell(
							backend,
							protection,
							serviceLaunch.invocation,
						)
					)
						throw new Error("sandbox_unavailable");
					consume({ taskId });
					const child = backend.launch(
						serviceLaunch?.invocation ?? launch,
						protection,
					);
					if (serviceLaunch) {
						if (!child.stdin) {
							terminateChild(child, "SIGTERM");
							throw new Error("Protected MCP stdin is unavailable");
						}
						const input = child.stdin;
						input.once("error", () => input.destroy());
						input.write(serviceLaunch.frame);
					}
					return child;
				}),
		});
	};
