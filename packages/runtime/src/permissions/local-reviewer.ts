import { createHash, createHmac, randomBytes } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { AutoReviewStatus } from "@codelia/protocol";
import {
	resolveStoragePaths,
	verifyOwnedAncestorsSync,
	verifyUserStorageLocationSync,
} from "@codelia/storage";
import { z } from "zod";
import { extractAccountId } from "../auth/openai-oauth";
import {
	builtinApiKeyBase,
	isOfficialApiKeyBase,
} from "../auth/provider-api-base";
import { AuthResolver, readConfiguredProviderAuth } from "../auth/resolver";
import type { OAuthTokens } from "../auth/store";
import { readEnvValue } from "../config";
import { resolveEffectiveModelConfig } from "../effective-model";
import { debugLog } from "../logger";
import { getResponsesProvider } from "../responses-provider";
import type { RuntimeState } from "../runtime-state";
import { approvalHistoryScope } from "./approval-history";
import {
	codexReviewEndpoint,
	createCodexApprovalReviewer,
} from "./codex-reviewer";
import type { ApprovalRequest, ReviewAdapter } from "./dispatch";
import type { LaunchRuleSuggestion } from "./launch-rules";
import { shellPolicyVersion } from "./policy-index";
import {
	fitsApprovalReviewPacket,
	ruleSuggestionSchema,
} from "./public-reviewer";
import {
	requestedReviewHistory,
	requireLocalShellEvidence,
	validateRuleSuggestionEvidence,
} from "./review-evidence";
import { ReviewFailureError, readReviewFailure } from "./review-failure";
import { containsReviewCredential } from "./review-privacy";
import {
	localReviewModels,
	type RegisteredReviewModel,
	reviewModelDetails,
	reviewModelLabel,
	selectFollowingReviewModel,
	selectLocalReviewModel,
} from "./reviewer-models";
import { confinedAutoLaunchDirectoryName } from "./workspace-config-paths";

export const localReviewConfigName = "auto-review.json";

const privateFileLimit = 4096;
const baseConfig = {
	enabled: z.boolean(),
	categories: z.tuple([z.literal("local_test")]),
};
const pinned = {
	provider: z.string().min(1).max(64).optional(),
	model: z.string().min(1).max(128).optional(),
};
const legacyBudget = z.number().int().positive();
const configSchema = z.union([
	z.strictObject({
		version: z.literal(3),
		enabled: z.boolean(),
		categories: z.tuple([z.literal("local_shell")]),
		mode: z.literal("follow"),
	}),
	z.strictObject({
		...pinned,
		version: z.literal(3),
		enabled: z.boolean(),
		categories: z.tuple([z.literal("local_shell")]),
		mode: z.literal("pin"),
	}),
	z.strictObject({
		...baseConfig,
		version: z.literal(2),
		mode: z.literal("follow"),
	}),
	z.strictObject({
		...baseConfig,
		...pinned,
		version: z.literal(2),
		mode: z.literal("pin"),
	}),
	z.strictObject({
		...baseConfig,
		version: z.literal(1),
		mode: z.literal("follow"),
		max_cost_usd_micros: legacyBudget,
	}),
	z.strictObject({
		...baseConfig,
		...pinned,
		version: z.literal(1),
		mode: z.literal("pin").optional(),
		credential_file: z.string().min(1).max(128),
		max_cost_usd_micros: legacyBudget,
	}),
]);
type Config = z.infer<typeof configSchema>;
type ChatRoute = RuntimeState["reviewChatRoute"];
type Status = AutoReviewStatus["state"];
type ConfigurationIssue = NonNullable<AutoReviewStatus["issue"]>;
type ReviewSelection =
	| { mode: "follow" }
	| { mode: "pin"; reviewer: RegisteredReviewModel };

const followProvider = (route: ChatRoute) =>
	route?.kind === "builtin" ? route.provider : undefined;

// Prior to the first run, show an explicitly configured model without bootstrapping
// an agent or prompting for credentials. Admission always uses the admitted agent.
export const reviewChatRouteForStatus = async (
	state: RuntimeState,
	workspace: string,
): Promise<ChatRoute> => {
	const route = state.reviewChatRoute;
	if (route || state.activeRunId) return route;
	try {
		const config = await resolveEffectiveModelConfig(state, workspace);
		if (!config.provider) return undefined;
		return getResponsesProvider(config, config.provider)
			? { kind: "named" }
			: {
					kind: "builtin",
					provider: config.provider,
					apiBase: builtinApiKeyBase(config.provider),
				};
	} catch {
		return undefined;
	}
};

const resolveConfiguredReviewer = (
	config: Config,
	registry: readonly RegisteredReviewModel[],
	chatRoute: ChatRoute,
): { reviewer: RegisteredReviewModel } | { issue: ConfigurationIssue } => {
	if (config.mode === "follow") {
		if (!chatRoute) return { issue: "review_chat_provider_unresolved" };
		const provider = followProvider(chatRoute);
		const reviewer = provider && selectFollowingReviewModel(registry, provider);
		return reviewer
			? { reviewer }
			: { issue: "review_chat_provider_unsupported" };
	}
	const reviewer = selectLocalReviewModel(
		registry,
		config.provider,
		config.model,
	);
	if (!reviewer) return { issue: "unregistered_review_model" };
	return { reviewer };
};

type ReviewConnection =
	| {
			method: "api_key";
			token: string;
			scope?: string;
			organization?: string;
			project?: string;
	  }
	| {
			method: "codex_oauth";
			token: string;
			accountId?: string;
			expiresAt: number;
	  };

const authBindingSecret = randomBytes(32);
const usableToken = (value: unknown): value is string =>
	typeof value === "string" && /^[!-~]+$/u.test(value);
const oauthAccount = (oauth: OAuthTokens): string | undefined =>
	oauth.account_id || extractAccountId(oauth);

const resolveReviewConnection = (
	reviewer: RegisteredReviewModel,
	chatRoute: ChatRoute,
): { connection: ReviewConnection } | { issue: ConfigurationIssue } => {
	const auth = readConfiguredProviderAuth(reviewer.provider);
	if (auth?.method === "api_key" && usableToken(auth.api_key)) {
		const scope = builtinApiKeyBase(reviewer.provider);
		const actualBase =
			chatRoute?.kind === "builtin" && chatRoute.provider === reviewer.provider
				? chatRoute.apiBase
				: undefined;
		if (
			scope &&
			(!isOfficialApiKeyBase(reviewer.provider, scope) ||
				(auth.api_base !== undefined && auth.api_base !== scope) ||
				(actualBase !== undefined && actualBase !== scope))
		)
			return { issue: "review_auth_incompatible" };
		const organization =
			reviewer.provider === "openai"
				? readEnvValue("OPENAI_ORG_ID")
				: undefined;
		const project =
			reviewer.provider === "openai"
				? readEnvValue("OPENAI_PROJECT_ID")
				: undefined;
		if (
			(organization && !usableToken(organization)) ||
			(project && !usableToken(project))
		)
			return { issue: "review_auth_incompatible" };
		return {
			connection: {
				method: "api_key",
				token: auth.api_key,
				scope,
				organization,
				project,
			},
		};
	}
	if (auth?.method === "oauth") {
		if (reviewer.provider !== "openai")
			return { issue: "review_auth_incompatible" };
		const oauth = auth.oauth;
		if (
			!oauth ||
			!usableToken(oauth.access_token) ||
			!Number.isFinite(oauth.expires_at)
		)
			return { issue: "review_auth_unavailable" };
		const accountId = oauthAccount(oauth);
		if (accountId && !/^[a-z0-9_-]+$/iu.test(accountId))
			return { issue: "review_auth_incompatible" };
		if (
			oauth.expires_at <= Date.now() &&
			(!accountId || !usableToken(oauth.refresh_token))
		)
			return { issue: "review_auth_unavailable" };
		return {
			connection: {
				method: "codex_oauth",
				token: oauth.access_token,
				accountId,
				expiresAt: oauth.expires_at,
			},
		};
	}
	return { issue: "review_auth_unavailable" };
};

const reviewDestination = (
	reviewer: RegisteredReviewModel,
	connection: ReviewConnection,
) =>
	connection.method === "codex_oauth" ? codexReviewEndpoint : reviewer.endpoint;

const reviewDetails = (
	reviewer: RegisteredReviewModel,
	connection?: ReviewConnection,
) =>
	connection?.method === "codex_oauth"
		? [
				`Destination ${codexReviewEndpoint}`,
				"Authentication: existing Codex sign-in. Codex plan usage and applicable account data terms apply.",
				"Conversation storage is disabled for this request.",
			]
		: reviewModelDetails(reviewer);

type Settings = {
	status: "active";
	connection: ReviewConnection;
	revision: string;
	reviewer: RegisteredReviewModel;
};

const stamp = (stat: BigIntStats): string =>
	`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

const privateFile = (stat: BigIntStats): boolean =>
	process.geteuid !== undefined &&
	stat.isFile() &&
	stat.uid === BigInt(process.geteuid()) &&
	(stat.mode & 0o077n) === 0n &&
	stat.nlink === 1n &&
	stat.size > 0n &&
	stat.size <= BigInt(privateFileLimit);

const readPrivateFile = (file: string, expected: string) => {
	const fd = openSync(
		file,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = fstatSync(fd, { bigint: true });
		if (!privateFile(before) || stamp(before) !== expected)
			throw new Error("local_review_file_changed");
		const buffer = Buffer.alloc(privateFileLimit + 1);
		const bytes = readSync(fd, buffer, 0, buffer.length, 0);
		if (
			bytes !== Number(before.size) ||
			stamp(fstatSync(fd, { bigint: true })) !== expected
		)
			throw new Error("local_review_file_changed");
		return new TextDecoder("utf-8", { fatal: true }).decode(
			buffer.subarray(0, bytes),
		);
	} finally {
		closeSync(fd);
	}
};

const configDirectory = () => path.resolve(resolveStoragePaths().configDir);

const isMissing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT";

// Resolve existing ancestors before creating a missing config directory.
const resolvedLocationWithAncestor = (
	location: string,
): { resolved: string; existingAncestor: string } => {
	try {
		const resolved = realpathSync(location);
		return { resolved, existingAncestor: resolved };
	} catch (error) {
		const parent = path.dirname(location);
		if (!isMissing(error) || parent === location) throw error;
		if (lstatSync(location, { throwIfNoEntry: false })?.isSymbolicLink())
			throw new Error("review_config_symlink_redirect");
		const ancestor = resolvedLocationWithAncestor(parent);
		return {
			resolved: path.join(ancestor.resolved, path.basename(location)),
			existingAncestor: ancestor.existingAncestor,
		};
	}
};

type ConfigSnapshot = {
	directory: string;
	config?: Config;
	version?: string;
};

const confinedConfigSchema = z.strictObject({
	enabled: z.boolean(),
	workspace_identity: z.string(),
});
const confinedWorkspaceIdentity = (workspace: string) => {
	const { dev, ino } = lstatSync(workspace, { bigint: true });
	return `${dev}:${ino}`;
};

export const confinedWorkspaceConfigName = (workspace: string): string =>
	`${createHash("sha256").update(workspace).digest("hex")}.json`;

const requirePrivateConfigDirectory = (
	directory: string,
	checkAncestors = false,
): void => {
	const uid = process.geteuid?.();
	if (uid === undefined) throw new Error("review_config_unavailable");
	const parent = lstatSync(directory, { bigint: true });
	if (
		!parent.isDirectory() ||
		parent.uid !== BigInt(uid) ||
		(parent.mode & 0o022n) !== 0n
	)
		throw new Error("review_config_unsafe_directory");
	if (checkAncestors)
		verifyOwnedAncestorsSync(directory, uid, "review_config_unsafe_directory");
};

const readOwnedConfig = (
	workspace: string,
	name: string,
	subdirectory?: string,
) => {
	if (typeof process.geteuid !== "function")
		throw new Error("review_config_unavailable");
	const baseDir = configDirectory();
	const requested = subdirectory ? path.join(baseDir, subdirectory) : baseDir;
	const root = realpathSync(workspace);
	const { resolved: directory, existingAncestor } =
		resolvedLocationWithAncestor(requested);
	if (subdirectory) {
		const baseResolved = resolvedLocationWithAncestor(baseDir);
		if (directory !== path.join(baseResolved.resolved, subdirectory))
			throw new Error("review_config_symlink_redirect");
	}
	const { insideWorkspace } = verifyUserStorageLocationSync({
		workspace: root,
		configured: requested,
		resolved: directory,
		relativePath: subdirectory ?? "",
		errorMessage: "review_config_inside_workspace",
		redirectErrorMessage: "review_config_symlink_redirect",
	});
	const file = path.join(directory, name);
	let version: string;
	try {
		version = stamp(lstatSync(file, { bigint: true }));
	} catch (error) {
		if (!isMissing(error)) throw error;
		return { directory, existingAncestor, insideWorkspace };
	}
	requirePrivateConfigDirectory(directory, insideWorkspace);
	if (subdirectory)
		requirePrivateConfigDirectory(path.dirname(directory), insideWorkspace);
	const value: unknown = JSON.parse(readPrivateFile(file, version));
	return { directory, existingAncestor, insideWorkspace, version, value };
};

const readConfig = (workspace: string): ConfigSnapshot => {
	const { directory, version, value } = readOwnedConfig(
		workspace,
		localReviewConfigName,
	);
	return {
		directory,
		version,
		config: version ? configSchema.parse(value) : undefined,
	};
};

const readConfinedSelection = (workspace: string) => {
	const { directory, version, value } = readOwnedConfig(
		workspace,
		confinedWorkspaceConfigName(workspace),
		confinedAutoLaunchDirectoryName,
	);
	return {
		directory,
		version,
		config: version ? confinedConfigSchema.parse(value) : undefined,
	};
};

const writeConfig = (
	workspace: string,
	expected: Pick<ConfigSnapshot, "directory" | "version">,
	config: Config | z.infer<typeof confinedConfigSchema>,
	name = localReviewConfigName,
	subdirectory?: string,
): void => {
	const checkCurrent = () => {
		const current = readOwnedConfig(workspace, name, subdirectory);
		if (
			current.directory !== expected.directory ||
			current.version !== expected.version
		)
			throw new Error("review_config_changed");
		return current;
	};
	const beforeCreate = checkCurrent();
	if (beforeCreate.insideWorkspace)
		requirePrivateConfigDirectory(beforeCreate.existingAncestor, true);
	mkdirSync(expected.directory, { mode: 0o700, recursive: true });
	requirePrivateConfigDirectory(
		expected.directory,
		beforeCreate.insideWorkspace,
	);
	if (subdirectory)
		requirePrivateConfigDirectory(
			path.dirname(expected.directory),
			beforeCreate.insideWorkspace,
		);
	checkCurrent();
	const temp = mkdtempSync(path.join(expected.directory, ".auto-review-"));
	try {
		const file = path.join(temp, name);
		writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		checkCurrent();
		requirePrivateConfigDirectory(
			expected.directory,
			beforeCreate.insideWorkspace,
		);
		renameSync(file, path.join(expected.directory, name));
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
};

const readSettings = (
	registry: readonly RegisteredReviewModel[],
	chatRoute: ChatRoute,
	snapshot: ConfigSnapshot,
):
	| Settings
	| {
			status: Exclude<Status, "active">;
			issue?: ConfigurationIssue;
	  } => {
	try {
		const { config, directory, version } = snapshot;
		if (!config?.enabled) return { status: "off" };
		if (config.version !== 3)
			return { status: "unavailable", issue: "review_reconfigure_required" };
		const selection = resolveConfiguredReviewer(config, registry, chatRoute);
		if ("issue" in selection)
			return { status: "unavailable", issue: selection.issue };
		const { reviewer } = selection;
		const auth = resolveReviewConnection(reviewer, chatRoute);
		if ("issue" in auth) return { status: "unavailable", issue: auth.issue };
		const { connection } = auth;
		const identity = createHmac("sha256", authBindingSecret)
			.update(
				JSON.stringify(
					connection.method === "codex_oauth"
						? [connection.method, connection.accountId ?? connection.token]
						: connection,
				),
			)
			.digest("hex");
		return {
			status: "active",
			connection,
			revision: JSON.stringify([
				directory,
				version,
				identity,
				reviewer.provider,
				reviewer.model,
				reviewer.revision,
				reviewDestination(reviewer, connection),
				reviewer.billing,
			]),
			reviewer,
		};
	} catch {
		return { status: "unavailable" };
	}
};

const localReviewers = new WeakMap<RuntimeState, LocalAutoReview>();
export const runtimeLocalAutoReview = (state: RuntimeState) => {
	let entry = localReviewers.get(state);
	if (!entry) {
		entry = new LocalAutoReview(state);
		localReviewers.set(state, entry);
	}
	return entry;
};

export class LocalAutoReview {
	private revisionGeneration = 0;
	private lastObserved?: { revision: string; provider: string };
	private readonly configuredWorkspaces = new Set<string>();
	private readonly enabledLaunchWorkspaces = new Set<string>();
	private readonly preparedReview = new WeakMap<
		ApprovalRequest,
		{ adapter: ReviewAdapter; revision: string }
	>();
	private configChanges = new AbortController();

	constructor(
		private readonly state: RuntimeState,
		private readonly registry: readonly RegisteredReviewModel[] = localReviewModels,
	) {}

	private observeConfig(
		root: string,
		snapshot = readConfig(root),
	): ConfigSnapshot {
		if (snapshot.config?.version === 3 && snapshot.config.enabled)
			this.configuredWorkspaces.add(root);
		else if (snapshot.config?.enabled === false)
			this.configuredWorkspaces.delete(root);
		return snapshot;
	}

	private observeSettings(
		workspace: string,
		snapshot?: ConfigSnapshot,
		route = this.state.reviewChatRoute,
	) {
		let settings: ReturnType<typeof readSettings>;
		try {
			const root = realpathSync(workspace);
			const observed = this.observeConfig(root, snapshot);
			settings =
				!observed.config && this.configuredWorkspaces.has(root)
					? { status: "unavailable" }
					: readSettings(this.registry, route, observed);
		} catch {
			settings = { status: "unavailable" };
		}
		const next =
			settings.status === "active"
				? { revision: settings.revision, provider: settings.reviewer.provider }
				: undefined;
		if (this.lastObserved && this.lastObserved.revision !== next?.revision)
			this.abortPendingReview();
		this.lastObserved = next;
		return settings;
	}

	revokeAuth(provider?: string): void {
		if (!provider || this.lastObserved?.provider === provider)
			this.configurationChanged();
	}

	private abortPendingReview(): void {
		this.revisionGeneration++;
		this.configChanges.abort();
		this.configChanges = new AbortController();
	}

	startupStatus(workspace: string, route = this.state.reviewChatRoute) {
		const status = this.status(workspace, route);
		return {
			auto_review: status.state,
			auto_review_confined_launch_enabled: status.confined_launch_enabled,
			...(status.confined_launch_issue
				? { auto_review_confined_launch_issue: status.confined_launch_issue }
				: {}),
			...(status.issue ? { auto_review_issue: status.issue } : {}),
		};
	}

	confinedLaunchRevision(workspace: string): string | undefined {
		return this.confinedLaunchStatus(workspace).revision;
	}

	confinedLaunchUnavailable(workspace: string): boolean {
		return this.confinedLaunchStatus(workspace).blocksLaunch;
	}

	private confinedLaunchStatus(workspace: string): {
		revision?: string;
		blocksLaunch: boolean;
		hasIssue: boolean;
	} {
		let root = workspace;
		try {
			root = realpathSync(workspace);
			const { config, version } = readConfinedSelection(root);
			if (
				config?.enabled &&
				config.workspace_identity === confinedWorkspaceIdentity(root)
			) {
				this.enabledLaunchWorkspaces.add(root);
				return {
					revision: version,
					blocksLaunch: false,
					hasIssue: false,
				};
			}
			if (config) this.enabledLaunchWorkspaces.delete(root);
			const observed = this.enabledLaunchWorkspaces.has(root);
			return { blocksLaunch: observed, hasIssue: observed };
		} catch (error) {
			const observed = this.enabledLaunchWorkspaces.has(root);
			const unverifiablePlatform =
				error instanceof Error && error.message === "review_config_unavailable";
			return {
				blocksLaunch: observed,
				hasIssue: observed || !unverifiablePlatform,
			};
		}
	}

	isEnabled(workspace: string): boolean {
		if (typeof process.geteuid !== "function") return false;
		let root: string;
		try {
			root = realpathSync(workspace);
		} catch {
			return false;
		}
		if (!this.confinedLaunchStatus(root).revision) return false;
		try {
			const snapshot = this.observeConfig(root);
			if (snapshot.config)
				return this.observeSettings(root, snapshot).status === "active";
		} catch {
			// An already configured review cannot fall back to a new dialog on
			// loss of the trusted settings. Only a trusted off setting clears it.
		}
		return this.configuredWorkspaces.has(root);
	}

	configuration(workspace: string) {
		const root = realpathSync(workspace);
		const identity = confinedWorkspaceIdentity(root);
		const launchSelection = readConfinedSelection(root);
		let snapshot: ConfigSnapshot | undefined;
		try {
			snapshot = this.observeConfig(root);
		} catch {}
		const signal = this.configChanges.signal;
		const setLaunch = (enabled: boolean) => {
			if (signal.aborted || confinedWorkspaceIdentity(root) !== identity)
				throw new Error("review_config_changed");
			writeConfig(
				root,
				launchSelection,
				{ enabled, workspace_identity: identity },
				confinedWorkspaceConfigName(root),
				confinedAutoLaunchDirectoryName,
			);
			if (enabled) this.enabledLaunchWorkspaces.add(root);
			else this.enabledLaunchWorkspaces.delete(root);
			this.configurationChanged();
		};
		return {
			signal,
			enable: () => setLaunch(true),
			select: (selection: ReviewSelection) => {
				const reviewer =
					selection.mode === "pin" ? selection.reviewer : undefined;
				if (
					!snapshot ||
					signal.aborted ||
					(reviewer && !this.registry.includes(reviewer))
				)
					throw new Error("review_config_invalid");
				writeConfig(
					root,
					snapshot,
					configSchema.parse({
						version: 3,
						enabled: true,
						categories: ["local_shell"],
						...(selection.mode === "pin"
							? {
									mode: "pin",
									provider: selection.reviewer.provider,
									model: selection.reviewer.model,
								}
							: { mode: "follow" }),
					}),
				);
				this.configuredWorkspaces.add(root);
				setLaunch(true);
			},
			disable: () => setLaunch(false),
		};
	}

	private configurationChanged(): void {
		this.lastObserved = undefined;
		this.abortPendingReview();
	}

	status(
		workspace: string,
		route = this.state.reviewChatRoute,
	): AutoReviewStatus {
		const launch = this.confinedLaunchStatus(workspace);
		const confinedStatus = {
			confined_launch_enabled: launch.revision !== undefined,
			...(launch.hasIssue
				? {
						confined_launch_issue:
							"confined_launch_config_unavailable" as const,
					}
				: {}),
		};
		try {
			const snapshot = readConfig(workspace);
			const settings = this.observeSettings(workspace, snapshot, route);
			const config = snapshot.config;
			const selection =
				config && resolveConfiguredReviewer(config, this.registry, route);
			const reviewer =
				selection && "reviewer" in selection ? selection.reviewer : undefined;
			return {
				state: settings.status,
				...confinedStatus,
				...(config ? { mode: config.mode ?? "pin" } : {}),
				...(reviewer
					? {
							provider: reviewer.provider,
							model: reviewer.model,
							label: reviewModelLabel(reviewer),
							details: reviewDetails(
								reviewer,
								settings.status === "active" ? settings.connection : undefined,
							),
						}
					: {}),
				...(settings.status === "unavailable"
					? { issue: settings.issue ?? "review_config_unavailable" }
					: {}),
			};
		} catch {
			this.observeSettings(workspace);
			return {
				state: "unavailable",
				...confinedStatus,
				issue: "review_config_unavailable",
			};
		}
	}

	private current(
		request: ApprovalRequest,
	): (Settings & { workspace: string }) | undefined {
		const { state } = this;
		const root = state.runtimeSandboxRoot ?? state.runtimeWorkingDir;
		if (
			!root ||
			state.effectiveEnvironment.sourcePreset !== "tui-local" ||
			state.effectiveEnvironment.adapters.approvalReviewer ||
			request.origin !== "parent_agent" ||
			request.registration !== "builtin.shell/1" ||
			request.owner !== state.sessionId ||
			!request.runId ||
			request.runId !== state.activeRunId ||
			request.intentVersion !== state.approvalContext()
		)
			return undefined;
		try {
			const workspace = realpathSync(root);
			const settings = this.observeSettings(workspace);
			return settings.status === "active"
				? {
						...settings,
						workspace,
						revision: JSON.stringify([
							this.revisionGeneration,
							settings.revision,
						]),
					}
				: undefined;
		} catch {
			return undefined;
		}
	}

	/** Called only after a local operator chooses to set up a reusable shell rule. */
	async proposeLaunchRule(
		request: ApprovalRequest,
		words: readonly string[],
		signal: AbortSignal,
	): Promise<LaunchRuleSuggestion | undefined> {
		const { state } = this;
		const root = state.runtimeSandboxRoot ?? state.runtimeWorkingDir;
		const isCurrent = () =>
			!signal.aborted &&
			state.effectiveEnvironment.sourcePreset === "tui-local" &&
			!state.effectiveEnvironment.adapters.approvalReviewer &&
			request.registration === "builtin.shell/1" &&
			request.owner === (state.sessionId ?? "operator") &&
			!!root &&
			request.authorityVersion === shellPolicyVersion(state, root) &&
			request.intentVersion === state.approvalContext() &&
			(request.origin === "parent_agent"
				? !!request.runId && request.runId === state.activeRunId
				: request.origin === "operator" &&
					(!request.runId || request.runId === state.activeRunId)) &&
			(state.runtimeSandboxRoot ?? state.runtimeWorkingDir) === root;
		if (!root || !isCurrent()) return;
		try {
			const workspace = realpathSync(root);
			const settingsForRequest = async () => {
				const route = await reviewChatRouteForStatus(state, workspace);
				const snapshot = this.observeConfig(workspace);
				if (!snapshot.config && this.configuredWorkspaces.has(workspace))
					return;
				const config = snapshot.config?.enabled
					? snapshot.config
					: ({
							version: 3,
							mode: "follow",
							enabled: true,
							categories: ["local_shell"],
						} satisfies Config);
				const settings = readSettings(this.registry, route, {
					...snapshot,
					config,
				});
				return settings.status === "active" && isCurrent()
					? settings
					: undefined;
			};
			let settings = await settingsForRequest();
			if (!settings) return;
			const revision = settings.revision;
			const lifetime = this.revisionGeneration;
			const combined = AbortSignal.any([signal, this.configChanges.signal]);
			const runId = request.runId ?? state.activeRunId;
			const intent = runId && state.approvalUserIntent(runId);
			if (runId && !intent) return;
			const references = requestedReviewHistory(request);
			const scope =
				references && approvalHistoryScope(workspace, references.cwd);
			const history =
				request.runId && references && scope
					? await state.approvalUserHistory(
							request.runId,
							references.references,
							scope,
						)
					: undefined;
			if (
				!validateRuleSuggestionEvidence(
					request,
					workspace,
					words,
					intent || undefined,
					history ?? undefined,
				)
			)
				return;
			const packet = JSON.stringify({ request_id: request.id, argv: words });
			if (!fitsApprovalReviewPacket(packet, combined)) return;
			settings = await settingsForRequest();
			if (!settings || settings.revision !== revision || combined.aborted)
				return;
			if (
				settings.connection.method === "codex_oauth" &&
				settings.connection.expiresAt <= Date.now()
			) {
				const account = settings.connection.accountId;
				if (!account) return;
				const resolver = await AuthResolver.create(state, () => {});
				await resolver.getOpenAiAccessToken({
					signal: combined,
					matches: (oauth) => oauthAccount(oauth) === account,
				});
				settings = await settingsForRequest();
				if (!settings || settings.revision !== revision) return;
			}
			const { connection, reviewer } = settings;
			if (
				combined.aborted ||
				lifetime !== this.revisionGeneration ||
				packet.includes(JSON.stringify(connection.token).slice(1, -1))
			)
				return;
			const options = {
				purpose: "rule_suggestion" as const,
				buildEvidence: async () => null,
			};
			const adapter =
				connection.method === "codex_oauth"
					? createCodexApprovalReviewer(reviewer.model, connection, options)
					: reviewer.createAdapter({
							...options,
							apiKey: connection.token,
							organization: connection.organization,
							project: connection.project,
						});
			if (adapter.reserve && !adapter.reserve(packet, combined, request))
				return;
			const result = ruleSuggestionSchema.safeParse(
				await adapter.review(packet, combined, request),
			);
			if (
				!result.success ||
				result.data.request_id !== request.id ||
				combined.aborted ||
				lifetime !== this.revisionGeneration ||
				(await settingsForRequest())?.revision !== revision
			)
				return;
			const { kind, argv_prefix: prefix } = result.data;
			if (kind === "exact") return prefix.length === 0 ? { kind } : undefined;
			if (
				prefix.length < 2 ||
				prefix.length > words.length ||
				!prefix.every((word, index) => word === words[index])
			)
				return;
			return { kind, words: prefix };
		} catch (error) {
			const diagnostic = readReviewFailure(error);
			if (diagnostic)
				debugLog(`approval.rule_suggestion_unavailable ${diagnostic.code}`);
			return undefined;
		}
	}

	readonly adapter: ReviewAdapter = {
		categories: ["local_test", "local_shell"],
		reviewSignal: () => this.configChanges.signal,
		reviewVersion: (request) => {
			const current = this.current(request);
			return current?.revision;
		},
		privacyConfirmationPreview: (preview, request, diagnostic) => {
			const token = this.current(request)?.connection.token;
			if (!token) return undefined;
			const redacted = preview.replaceAll(token, "[credential omitted]");
			if (containsReviewCredential(redacted)) return undefined;
			if (
				diagnostic.code === "review_evidence_credential" &&
				redacted === preview &&
				diagnostic.location !== "user_intent" &&
				diagnostic.location !== "user_correction" &&
				diagnostic.location !== "earlier_goal_steer" &&
				diagnostic.location !== "historical_user_message" &&
				diagnostic.location !== "historical_proposal"
			)
				return undefined;
			return redacted;
		},
		buildEvidence: async (request, signal) => {
			const settings = this.current(request);
			const workspace = settings?.workspace;
			const intent =
				request.runId && this.state.approvalUserIntent(request.runId);
			if (!settings || !workspace) return null;
			if (!intent || !request.runId)
				throw new ReviewFailureError(
					"review_evidence_intent_unavailable",
					undefined,
					"user_intent",
				);
			const requested = requestedReviewHistory(request);
			const scope = requested && approvalHistoryScope(workspace, requested.cwd);
			const history =
				requested && scope
					? await this.state
							.approvalUserHistory(request.runId, requested.references, scope)
							.catch(() => null)
					: undefined;
			signal.throwIfAborted();
			if (requested && !history)
				throw new ReviewFailureError(
					"review_evidence_history_unavailable",
					undefined,
					"conversation_history",
				);
			const evidence = requireLocalShellEvidence(
				request,
				workspace,
				intent,
				history ?? undefined,
			);
			const connection = settings.connection;
			const encodedToken = JSON.stringify(connection.token).slice(1, -1);
			if (JSON.stringify(evidence.operation).includes(encodedToken))
				throw new ReviewFailureError(
					"review_evidence_credential",
					undefined,
					"shell_request",
				);
			if (JSON.stringify(evidence.intent).includes(encodedToken))
				throw new ReviewFailureError(
					"review_evidence_credential",
					undefined,
					"user_intent",
				);
			if (
				connection.method === "codex_oauth" &&
				connection.expiresAt <= Date.now()
			) {
				signal.throwIfAborted();
				try {
					const resolver = await AuthResolver.create(this.state, () => {});
					if (this.current(request)?.revision !== settings.revision)
						return null;
					await resolver.getOpenAiAccessToken({
						signal,
						matches: (oauth) =>
							!!connection.accountId &&
							oauthAccount(oauth) === connection.accountId,
					});
				} catch {
					throw new ReviewFailureError("review_auth");
				}
				if (this.current(request)?.revision !== settings.revision) return null;
			}
			return {
				...evidence,
				binding: createHash("sha256")
					.update(
						JSON.stringify([
							request.id,
							request.registration,
							request.intentVersion,
							request.authorityVersion,
							evidence,
						]),
					)
					.digest("hex"),
			};
		},
		reserve: (packet, signal, request) => {
			const settings = this.current(request);
			if (!settings || signal.aborted) return false;
			if (
				packet.includes(JSON.stringify(settings.connection.token).slice(1, -1))
			)
				throw new ReviewFailureError(
					"review_evidence_credential",
					undefined,
					"reviewer_packet",
				);
			if (!fitsApprovalReviewPacket(packet, signal)) return false;
			const { reviewer, connection } = settings;
			if (
				connection.method === "codex_oauth" &&
				connection.expiresAt <= Date.now()
			)
				throw new ReviewFailureError("review_auth");
			const options = {
				buildEvidence: async () => null,
				recordUsage: (usage: {
					model: string;
					inputTokens: number;
					outputTokens: number;
					durationMs: number;
				}) =>
					debugLog(
						`approval.review_usage ${JSON.stringify({ requestId: request.id, provider: reviewer.provider, ...usage })}`,
					),
			};
			const adapter =
				connection.method === "codex_oauth"
					? createCodexApprovalReviewer(reviewer.model, connection, options)
					: reviewer.createAdapter({
							...options,
							apiKey: connection.token,
							organization: connection.organization,
							project: connection.project,
						});
			if (adapter.reserve && !adapter.reserve(packet, signal, request))
				return false;
			this.preparedReview.set(request, {
				adapter,
				revision: settings.revision,
			});
			return true;
		},
		review: async (packet, signal, request) => {
			const prepared = this.preparedReview.get(request);
			this.preparedReview.delete(request);
			if (!prepared) throw new ReviewFailureError("review_preparation_failed");
			if (
				signal.aborted ||
				this.current(request)?.revision !== prepared.revision
			)
				return null;
			const response = await prepared.adapter.review(packet, signal, request);
			return !signal.aborted &&
				this.current(request)?.revision === prepared.revision
				? response
				: null;
		},
	};
}
