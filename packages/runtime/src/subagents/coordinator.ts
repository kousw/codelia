import { createHash, randomUUID } from "node:crypto";
import { SUBAGENT_MAX_CONCURRENT_LIMIT } from "@codelia/config";
import type { ToolOutputCacheStore } from "@codelia/core";
import type { TaskSpawnParams } from "@codelia/protocol";
import type { SubagentLineage } from "@codelia/shared-types";
import type { TaskRecord } from "@codelia/storage";
import { z } from "zod";
import {
	buildSystemPermissions,
	PermissionService,
} from "../permissions/service";
import type { TaskManager } from "../tasks";
import type { SubagentApproval, SubagentChannel } from "./contracts";
import {
	READ_ONLY_TOOLS,
	type SubagentExecutorFactory,
	type SubagentLaunchInput,
	type SubagentParentContext,
	WRITABLE_TOOLS,
} from "./contracts";
import { AgentMailbox } from "./mailbox";
import { subagentModelSelectionSchema } from "./model";
import { subagentNameSchema } from "./names";
import { createParentChannel } from "./parent-channel";

const DEFAULT_MAX_CONCURRENT = 8;

export const subagentSpawnSchema = z
	.object({
		kind: z.literal("subagent").default("subagent"),
		prompt: z
			.string()
			.trim()
			.min(1)
			.max(32_768)
			.describe(
				"Self-contained delegated task; child has no parent conversation. Maximum 32768 characters.",
			),
		name: subagentNameSchema.describe(
			"Choose a short, distinctive agent code name; vary freely using invented words or combinations instead of a fixed roster or numbered sequence. Required, 1-48 characters; start with a letter and use letters, digits, spaces, periods, apostrophes or hyphens. Unique in this parent session, including completed tasks; parent is reserved. On collision choose another name. Use label for the assignment and task_id for addressing.",
		),
		profile: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.optional()
			.describe(
				"Configured purpose-specific model profile from <subagent_model_profiles>. Use when requested by the user or when its described purpose matches the delegated work. Mutually exclusive with model. Unknown profiles fail; no fallback.",
			),
		model: subagentModelSelectionSchema
			.optional()
			.describe(
				"Use the user-requested model for this child. Omit model and profile to use the configured default_profile, or the parent model if unconfigured. Do not combine model with profile. An explicit selection replaces model settings; no credential/model probe or automatic fallback. Authentication and provider errors return through the task result.",
			),
		label: z
			.string()
			.max(80)
			.optional()
			.describe(
				"Work assignment, such as API implementation; separate from the child's agent name.",
			),
		background: z
			.boolean()
			.optional()
			.describe(
				"Default true: return task_id immediately. False attaches a cancellable wait; the child survives parent-turn stop.",
			),
		context_mode: z
			.literal("fresh")
			.optional()
			.describe("Only fresh sessions are supported."),
		workspace_mode: z.literal("live_workspace").optional(),
		workspace_access: z
			.enum(["read-only", "read-write"])
			.optional()
			.describe(
				"Default read-write in the shared workspace. For read-only research choose read-only and omit tool_allowlist: read, read_line, list_files, search_files remain available. Read-only never permits edit, write, or shell (even for read-only commands).",
			),
		tool_allowlist: z
			.array(z.enum(WRITABLE_TOOLS))
			.max(7)
			.optional()
			.describe(
				"Usually omit: workspace_access selects the complete allowed tool set. Supply only to restrict it further. Read-only permits read, read_line, list_files, search_files; read-write additionally permits edit, write, shell. Messages are always available; no recursive delegation.",
			),
		max_steps: z
			.number()
			.int()
			.min(1)
			.max(200)
			.optional()
			.describe(
				"Child iteration limit; default 50. Exhaustion returns failed/max_steps with partial results.",
			),
		timeout_seconds: z
			.number()
			.int()
			.min(1)
			.max(3600)
			.optional()
			.describe(
				"Optional execution deadline in seconds (1–3600), covering bootstrap through final result. Omit for no time limit; separate from the parent's wait timeout.",
			),
	})
	.strict()
	.superRefine((input, ctx) => {
		if (input.workspace_access !== "read-only") return;
		const unsupported = input.tool_allowlist?.filter(
			(tool) => !(READ_ONLY_TOOLS as readonly string[]).includes(tool),
		);
		if (unsupported?.length) {
			ctx.addIssue({
				code: "custom",
				path: ["tool_allowlist"],
				message: `workspace_access=read-only does not allow: ${unsupported.join(", ")}. Omit tool_allowlist to use read, read_line, list_files, search_files, or remove the listed tools. Shell is not read-only, even for search commands. Keep read-only access for read-only work.`,
			});
		}
	});

export class AgentTreeCoordinator {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly active = new Set<string>();
	private readonly stopping = new Set<string>();
	private readonly stopGenerations = new Map<string, number>();
	private parent?: SubagentParentContext;
	readonly mailbox: AgentMailbox;
	private approval?: SubagentApproval;
	private outputCache?: ToolOutputCacheStore;
	setOutputCache(cache: ToolOutputCacheStore | null): void {
		this.outputCache = cache ?? undefined;
	}
	setApproval(approval: SubagentApproval): void {
		this.approval = approval;
	}
	parentChannel(owner: string): SubagentChannel {
		return createParentChannel({
			tasks: this.tasks,
			mailbox: this.mailbox,
			owner,
			sender: "parent",
		});
	}
	constructor(
		readonly tasks: TaskManager,
		readonly factory: SubagentExecutorFactory,
	) {
		this.mailbox = new AgentMailbox(tasks);
	}
	configure(parent: SubagentParentContext): void {
		// Host config providers may bypass the file parser.
		z.number()
			.int()
			.min(1)
			.max(SUBAGENT_MAX_CONCURRENT_LIMIT)
			.parse(parent.subagent?.max_concurrent ?? DEFAULT_MAX_CONCURRENT);
		this.parent = structuredClone(parent);
	}
	isAvailable(): boolean {
		return this.factory.isAvailable();
	}
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
	async spawn(
		raw: TaskSpawnParams,
		owner: {
			session_id: string;
			run_id?: string;
			tool_call_id?: string;
			signal?: AbortSignal;
		},
	): Promise<TaskRecord> {
		const input = subagentSpawnSchema.parse(raw);
		if (input.model && input.profile)
			throw new Error("Specify either model or profile, not both");
		const parent = this.parent && structuredClone(this.parent);
		const approval = this.approval;
		if (!parent || !this.isAvailable())
			throw new Error("subagent executor unavailable");
		if (
			!owner.session_id ||
			owner.signal?.aborted ||
			this.stopping.has(owner.session_id)
		)
			throw new Error("task admission stopped");
		const generation = this.stopGenerations.get(owner.session_id) ?? 0;
		return this.serialize(async () => {
			if (
				owner.signal?.aborted ||
				this.stopping.has(owner.session_id) ||
				generation !== (this.stopGenerations.get(owner.session_id) ?? 0)
			)
				throw new Error("task admission stopped");
			if (
				this.active.size >=
				(parent.subagent?.max_concurrent ?? DEFAULT_MAX_CONCURRENT)
			)
				throw new Error("task_capacity_exceeded");
			const previous = (await this.tasks.list()).filter(
				(t) => t.subagent?.owner_session_id === owner.session_id,
			);
			if (
				previous.some(
					(task) =>
						task.subagent?.name?.toLowerCase() === input.name.toLowerCase(),
				)
			)
				throw new Error("subagent_name_in_use");
			const workspaceAccess = input.workspace_access ?? "read-write";
			const allowed =
				workspaceAccess === "read-only" ? READ_ONLY_TOOLS : WRITABLE_TOOLS;
			const allowlist = [...new Set(input.tool_allowlist ?? allowed)];
			const permissions = new PermissionService({
				approvalMode: parent.approval_mode,
				user: parent.permissions,
				system: buildSystemPermissions(parent.approval_mode),
			});
			for (const tool of allowlist)
				if (permissions.evaluate(tool, "{}").decision === "deny")
					throw new Error("delegated tool denied by parent policy");
			const task_id = randomUUID();
			const permission: SubagentLaunchInput["permission"] = {
				tool_allowlist: allowlist,
				workspace_access: workspaceAccess,
				approval_mode: parent.approval_mode,
				parent_permissions: parent.permissions,
				max_steps: input.max_steps ?? 50,
				...(input.timeout_seconds !== undefined
					? { timeout_seconds: input.timeout_seconds }
					: {}),
			};
			const lineage: SubagentLineage = {
				name: input.name,
				tree_id: `codelia-tree-${owner.session_id}`,
				node_id: task_id,
				parent_node_id: `codelia-root-${owner.session_id}`,
				owner_session_id: owner.session_id,
				depth: 1,
				spawn_index:
					previous.reduce(
						(max, task) => Math.max(max, task.subagent?.spawn_index ?? 0),
						0,
					) + 1,
				context_mode: "fresh",
				effective_policy_id: createHash("sha256")
					.update(JSON.stringify({ permission, root: parent.workspace_root }))
					.digest("hex"),
				workspace_lease_id: task_id,
			};
			const profileName = input.model
				? undefined
				: (input.profile ?? parent.subagent?.default_profile);
			const profiles = parent.subagent?.profiles;
			if (profileName && (!profiles || !Object.hasOwn(profiles, profileName))) {
				throw new Error(`Unknown subagent model profile: ${profileName}`);
			}
			const requestedModel =
				input.model ??
				(profileName ? profiles?.[profileName].model : undefined);
			const selectedModel = requestedModel
				? subagentModelSelectionSchema.parse(requestedModel)
				: undefined;
			const launch: SubagentLaunchInput = {
				version: 1,
				task_id,
				lineage,
				prompt: input.prompt,
				workspace_root: parent.workspace_root,
				model: selectedModel
					? {
							...selectedModel,
							provider: selectedModel.provider ?? parent.model.provider,
						}
					: parent.model,
				permission,
			};
			const channel = createParentChannel({
				tasks: this.tasks,
				mailbox: this.mailbox,
				owner: owner.session_id,
				sender: task_id,
				launch,
				approval,
				outputCache: this.outputCache,
			});
			const handle = this.factory.prepare(launch, channel);
			this.active.add(task_id);
			// A conforming factory settles only after executor exit. Persisted lineage is never removed here.
			void handle.wait.then(
				() => this.active.delete(task_id),
				() => this.active.delete(task_id),
			);
			try {
				return await this.tasks.spawnPrepared(
					{
						task_id,
						kind: "subagent",
						subagent: lineage,
						parent_session_id: owner.session_id,
						parent_run_id: owner.run_id,
						parent_tool_call_id: owner.tool_call_id,
						workspace_mode: "live_workspace",
						working_directory: parent.workspace_root,
						title: input.label ?? input.prompt.slice(0, 120),
						label: input.label,
					},
					handle,
					owner.signal,
				);
			} catch (error) {
				await handle.cancel("admission rejected");
				throw error;
			}
		});
	}
	async list(sessionId: string): Promise<TaskRecord[]> {
		return (await this.tasks.list()).filter(
			(t) => t.subagent?.owner_session_id === sessionId,
		);
	}
	async requireOwned(taskId: string, sessionId: string): Promise<TaskRecord> {
		const task = await this.tasks.status(taskId);
		if (!task || task.subagent?.owner_session_id !== sessionId)
			throw new Error("task_not_found");
		return task;
	}
	async cancelAll(sessionId: string): Promise<TaskRecord[]> {
		this.stopping.add(sessionId);
		const generation = (this.stopGenerations.get(sessionId) ?? 0) + 1;
		this.stopGenerations.set(sessionId, generation);
		try {
			return await this.serialize(async () =>
				Promise.all(
					(await this.list(sessionId)).map((t) => this.tasks.cancel(t.task_id)),
				),
			);
		} finally {
			if (this.stopGenerations.get(sessionId) === generation)
				this.stopping.delete(sessionId);
		}
	}
}
