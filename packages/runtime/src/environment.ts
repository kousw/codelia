import path from "node:path";
import type {
	RunEventStoreFactory,
	SessionStateStore,
	Tool,
	ToolOutputCacheStore,
} from "@codelia/core";
import type { PermissionRule, PermissionsConfig } from "@codelia/config";
import type { RpcNotification } from "@codelia/protocol";
import type { ProviderAuth } from "./auth/store";
import type {
	ResolvedExecutionEnvironmentConfig,
	ResolvedModelConfig,
	ResolvedSearchConfig,
	ResolvedSkillsConfig,
	WriteTarget,
} from "./config";
import type { SupportedProvider } from "./auth/resolver";
import type { TaskManager } from "./tasks";

export type RuntimeEnvironmentPreset = "tui-local" | "embedded-no-local-tools";

export type RuntimeEnvironmentInput =
	| { preset: RuntimeEnvironmentPreset }
	| { contract: RuntimeEnvironmentContract };

export type RuntimeEnvironmentContract = {
	workspace: {
		root?: string;
		filesystem: "enabled" | "disabled";
		process: "runtime" | "disabled";
	};
	context: {
		systemPrompt: "runtime-default" | "host";
		projectInstructions: "from-workspace" | "disabled";
		skills: "from-config" | "disabled";
		executionEnvironment: "from-config" | "disabled";
	};
	auth: {
		model: "runtime-default" | "host";
	};
	config: {
		source: "runtime-default" | "host" | "disabled";
	};
	tools: {
		builtin: "full-coding-agent" | "none";
		search: "from-config" | "disabled";
		mcp: "from-config" | "disabled";
		host: "enabled" | "disabled";
	};
	persistence: {
		mode: "runtime" | "volatile";
	};
	events: {
		live: "json-rpc" | "host";
	};
};

export type RuntimeConfigProvider = {
	resolveModelConfig?: (workingDir?: string) => Promise<ResolvedModelConfig>;
	resolvePermissionsConfig?: (
		workingDir?: string,
	) => Promise<PermissionsConfig | undefined>;
	resolveSearchConfig?: (workingDir?: string) => Promise<ResolvedSearchConfig>;
	resolveSkillsConfig?: (workingDir?: string) => Promise<ResolvedSkillsConfig>;
	resolveExecutionEnvironmentConfig?: (
		workingDir?: string,
	) => Promise<ResolvedExecutionEnvironmentConfig>;
	resolveTuiConfig?: (workingDir?: string) => Promise<{ theme?: string }>;
	updateModel?: (
		workingDir: string | undefined,
		model: {
			provider: string;
			name: string;
			reasoning?: "low" | "medium" | "high" | "xhigh";
			fast?: boolean;
		},
	) => Promise<WriteTarget>;
	updateTuiTheme?: (
		workingDir: string | undefined,
		theme: string,
	) => Promise<WriteTarget>;
	appendPermissionAllowRules?: (
		workingDir: string | undefined,
		rules: PermissionRule[],
	) => Promise<void>;
};

export type CredentialProvider = {
	hasAnyAvailableAuth?: () => boolean | Promise<boolean>;
	resolveProvider: (preferred?: string | null) => Promise<SupportedProvider>;
	resolveProviderAuth: (provider: SupportedProvider) => Promise<ProviderAuth>;
	getOpenAiAccessToken?: () => Promise<{ token: string; accountId?: string }>;
	clearAuth?: () => Promise<void>;
};

export type SystemPromptProvider = {
	loadSystemPrompt: (workingDir?: string) => Promise<string> | string;
};

export type ApprovalService = unknown;
export type PromptService = unknown;

export type RuntimeEventSink = {
	emit: (notification: RpcNotification) => Promise<void> | void;
};

export type ToolProvider = {
	getTools: () => Promise<Tool[]> | Tool[];
};

export type RuntimeStores = {
	sessionStateStore?: SessionStateStore;
	runEventStoreFactory?: RunEventStoreFactory;
	toolOutputCacheStore?: ToolOutputCacheStore | null;
	taskManager?: TaskManager;
};

export type RuntimeHostAdapters = {
	systemPromptProvider?: SystemPromptProvider;
	configProvider?: RuntimeConfigProvider;
	credentialProvider?: CredentialProvider;
	approvalService?: ApprovalService;
	promptService?: PromptService;
	eventSink?: RuntimeEventSink;
	stores?: RuntimeStores;
	toolProviders?: ToolProvider[];
};

export type RuntimeOptions = {
	environment?: RuntimeEnvironmentInput;
	adapters?: RuntimeHostAdapters;
};

export type EffectiveEnvironmentSummary = {
	source_preset?: RuntimeEnvironmentPreset;
	workspace: RuntimeEnvironmentContract["workspace"];
	context: RuntimeEnvironmentContract["context"];
	auth: RuntimeEnvironmentContract["auth"];
	config: RuntimeEnvironmentContract["config"];
	tools: RuntimeEnvironmentContract["tools"] & {
		model_visible: string[];
		operator_only: string[];
		disabled: string[];
	};
	persistence: RuntimeEnvironmentContract["persistence"];
	events: RuntimeEnvironmentContract["events"];
};

export type EffectiveRuntimeEnvironment = RuntimeEnvironmentContract & {
	sourcePreset?: RuntimeEnvironmentPreset;
	adapters: RuntimeHostAdapters;
	resolvedTools: {
		modelVisible: string[];
		operatorOnly: string[];
		disabled: string[];
	};
	summary: EffectiveEnvironmentSummary;
};

const cloneContract = (
	contract: RuntimeEnvironmentContract,
): RuntimeEnvironmentContract => ({
	workspace: { ...contract.workspace },
	context: { ...contract.context },
	auth: { ...contract.auth },
	config: { ...contract.config },
	tools: { ...contract.tools },
	persistence: { ...contract.persistence },
	events: { ...contract.events },
});

const defaultWorkspaceRoot = (): string =>
	process.env.CODELIA_SANDBOX_ROOT
		? path.resolve(process.env.CODELIA_SANDBOX_ROOT)
		: process.cwd();

export const runtimeEnvironmentPresets: Record<
	RuntimeEnvironmentPreset,
	RuntimeEnvironmentContract
> = {
	"tui-local": {
		workspace: {
			filesystem: "enabled",
			process: "runtime",
		},
		context: {
			systemPrompt: "runtime-default",
			projectInstructions: "from-workspace",
			skills: "from-config",
			executionEnvironment: "from-config",
		},
		auth: { model: "runtime-default" },
		config: { source: "runtime-default" },
		tools: {
			builtin: "full-coding-agent",
			search: "from-config",
			mcp: "from-config",
			host: "disabled",
		},
		persistence: { mode: "runtime" },
		events: { live: "json-rpc" },
	},
	"embedded-no-local-tools": {
		workspace: {
			filesystem: "disabled",
			process: "disabled",
		},
		context: {
			systemPrompt: "host",
			projectInstructions: "disabled",
			skills: "disabled",
			executionEnvironment: "disabled",
		},
		auth: { model: "host" },
		config: { source: "host" },
		tools: {
			builtin: "none",
			search: "disabled",
			mcp: "disabled",
			host: "enabled",
		},
		persistence: { mode: "volatile" },
		events: { live: "host" },
	},
};

const expandEnvironmentInput = (
	input?: RuntimeEnvironmentInput,
): {
	contract: RuntimeEnvironmentContract;
	sourcePreset?: RuntimeEnvironmentPreset;
} => {
	if (!input) {
		return {
			contract: cloneContract(runtimeEnvironmentPresets["tui-local"]),
			sourcePreset: "tui-local",
		};
	}
	if ("preset" in input) {
		return {
			contract: cloneContract(runtimeEnvironmentPresets[input.preset]),
			sourcePreset: input.preset,
		};
	}
	return { contract: cloneContract(input.contract) };
};

const requireAdapter = (
	condition: boolean,
	name: keyof RuntimeHostAdapters,
	reason: string,
): void => {
	if (!condition) return;
	throw new Error(`Runtime environment requires adapters.${name}: ${reason}`);
};

const rejectContract = (condition: boolean, reason: string): void => {
	if (!condition) return;
	throw new Error(`Invalid runtime environment: ${reason}`);
};

const resolveToolNames = (
	contract: RuntimeEnvironmentContract,
): EffectiveRuntimeEnvironment["resolvedTools"] => {
	const modelVisible: string[] = [];
	const operatorOnly: string[] = [];
	const disabled: string[] = [];

	if (contract.tools.builtin === "full-coding-agent") {
		modelVisible.push("builtin:full-coding-agent");
	} else {
		disabled.push("builtin");
	}
	if (contract.tools.search === "from-config") {
		modelVisible.push("search:from-config");
	} else {
		disabled.push("search");
	}
	if (contract.tools.mcp === "from-config") {
		modelVisible.push("mcp:from-config");
		operatorOnly.push("mcp.list");
	} else {
		disabled.push("mcp");
	}
	if (contract.tools.host === "enabled") {
		modelVisible.push("host-tools");
	} else {
		disabled.push("host-tools");
	}
	if (contract.workspace.process === "runtime") {
		operatorOnly.push("shell.*", "task.*");
	} else {
		disabled.push("process");
	}
	if (contract.context.skills === "from-config") {
		operatorOnly.push("skills.list");
	} else {
		disabled.push("skills");
	}
	if (
		contract.context.projectInstructions === "from-workspace" ||
		contract.context.skills === "from-config" ||
		contract.context.executionEnvironment === "from-config"
	) {
		operatorOnly.push("context.inspect");
	} else {
		disabled.push("local-context");
	}

	return { modelVisible, operatorOnly, disabled };
};

export const resolveRuntimeEnvironment = (
	options: RuntimeOptions = {},
): EffectiveRuntimeEnvironment => {
	const { contract, sourcePreset } = expandEnvironmentInput(
		options.environment,
	);
	const adapters = options.adapters ?? {};

	if (
		contract.workspace.filesystem === "enabled" ||
		contract.workspace.process === "runtime"
	) {
		contract.workspace.root = path.resolve(
			contract.workspace.root ?? defaultWorkspaceRoot(),
		);
	} else if (contract.workspace.root) {
		contract.workspace.root = path.resolve(contract.workspace.root);
	}

	rejectContract(
		contract.workspace.filesystem === "disabled" &&
			(contract.context.projectInstructions === "from-workspace" ||
				contract.context.skills === "from-config" ||
				contract.context.executionEnvironment === "from-config" ||
				contract.tools.builtin === "full-coding-agent" ||
				contract.tools.mcp === "from-config"),
		"workspace filesystem is disabled but local workspace context/tools are enabled",
	);
	rejectContract(
		contract.workspace.process === "disabled" &&
			contract.tools.builtin === "full-coding-agent",
		"full coding-agent builtin tools require runtime process support",
	);
	rejectContract(
		contract.tools.builtin === "full-coding-agent" &&
			(contract.context.projectInstructions !== "from-workspace" ||
				contract.context.skills !== "from-config"),
		"full coding-agent builtin tools require workspace project instructions and skills context",
	);
	rejectContract(
		contract.config.source === "disabled" &&
			(contract.tools.search === "from-config" ||
				contract.tools.mcp === "from-config" ||
				contract.context.skills === "from-config" ||
				contract.context.executionEnvironment === "from-config"),
		"config source is disabled but config-backed features are enabled",
	);
	rejectContract(
		contract.workspace.process === "runtime" &&
			contract.persistence.mode === "volatile" &&
			!adapters.stores?.taskManager,
		"runtime process support with volatile persistence requires adapters.stores.taskManager",
	);

	requireAdapter(
		contract.context.systemPrompt === "host" && !adapters.systemPromptProvider,
		"systemPromptProvider",
		"context.systemPrompt=host",
	);
	requireAdapter(
		contract.config.source === "host" && !adapters.configProvider,
		"configProvider",
		"config.source=host",
	);
	requireAdapter(
		contract.auth.model === "host" && !adapters.credentialProvider,
		"credentialProvider",
		"auth.model=host",
	);
	requireAdapter(
		contract.events.live === "host" && !adapters.eventSink,
		"eventSink",
		"events.live=host",
	);
	requireAdapter(
		contract.tools.host === "enabled" && !adapters.toolProviders,
		"toolProviders",
		"tools.host=enabled",
	);

	const resolvedTools = resolveToolNames(contract);
	const summary: EffectiveEnvironmentSummary = {
		...(sourcePreset ? { source_preset: sourcePreset } : {}),
		workspace: { ...contract.workspace },
		context: { ...contract.context },
		auth: { ...contract.auth },
		config: { ...contract.config },
		tools: {
			...contract.tools,
			model_visible: [...resolvedTools.modelVisible],
			operator_only: [...resolvedTools.operatorOnly],
			disabled: [...resolvedTools.disabled],
		},
		persistence: { ...contract.persistence },
		events: { ...contract.events },
	};

	return {
		...contract,
		...(sourcePreset ? { sourcePreset } : {}),
		adapters,
		resolvedTools,
		summary,
	};
};

export const isTuiLocalEnvironment = (
	environment: EffectiveRuntimeEnvironment,
): boolean =>
	environment.workspace.filesystem === "enabled" &&
	environment.workspace.process === "runtime" &&
	environment.context.systemPrompt === "runtime-default" &&
	environment.context.projectInstructions === "from-workspace" &&
	environment.context.skills === "from-config" &&
	environment.context.executionEnvironment === "from-config" &&
	environment.auth.model === "runtime-default" &&
	environment.config.source === "runtime-default" &&
	environment.tools.builtin === "full-coding-agent" &&
	environment.tools.search === "from-config" &&
	environment.tools.mcp === "from-config" &&
	environment.tools.host === "disabled" &&
	environment.persistence.mode === "runtime" &&
	environment.events.live === "json-rpc";

export const isProcessEnabled = (
	environment: EffectiveRuntimeEnvironment,
): boolean => environment.workspace.process === "runtime";

export const isFilesystemEnabled = (
	environment: EffectiveRuntimeEnvironment,
): boolean => environment.workspace.filesystem === "enabled";
