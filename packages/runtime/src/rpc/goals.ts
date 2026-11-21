import {
	type ChatInvokeUsage,
	defineTool,
	type SessionStateStore,
} from "@codelia/core";
import { RPC_ERROR_CODE } from "@codelia/protocol";
import type {
	GoalOffer,
	GoalRecord,
	GoalSnapshot,
} from "@codelia/shared-types";
import {
	getProcessIdentity,
	type SessionGoalStore,
	type StoredSessionGoal,
} from "@codelia/storage";
import { z } from "zod";
import { mergeSessionModelOverrideIntoMeta } from "../effective-model";
import type { ReviewUserText } from "../permissions/review-evidence";
import type { RuntimeState } from "../runtime-state";
import { send, sendError, sendResult } from "./transport";

const id = z.string().min(1).max(200);
const revision = z.number().int().positive();
const target = z.object({ session_id: id, goal_id: id, revision });
const budget = z.number().int().positive().nullable();
const schemas = {
	"goal.get": z.object({
		session_id: id.optional(),
		continuation_id: id.optional(),
	}),
	"goal.set": target.partial().extend({
		objective: z.string().trim().min(1).max(8_000).optional(),
		token_budget: budget.optional(),
	}),
	"goal.pause": z.object({
		session_id: id,
		goal_id: id,
		activation_id: id,
		run_id: id.optional(),
		continuation_id: id.optional(),
	}),
	"goal.resume": target,
	"goal.clear": target,
};
export type GoalMethod = keyof typeof schemas;
const readySchema = target.extend({
	continuation_id: id,
	after_run_id: id.optional(),
});
type Report = {
	status: "complete" | "blocked";
	evidence: string;
	blocker_key?: string;
};
export type GoalRun = {
	goal: GoalRecord;
	runId: string;
	continuationId?: string;
	compaction: boolean;
	approvalSteers: Exclude<StoredSessionGoal["approvalSteers"], undefined>;
	approvalObjectiveAfterSteers: number;
	report?: Report;
};

class GoalConflict extends Error {
	constructor(
		message: string,
		readonly reason = "conflict",
	) {
		super(message);
	}
}

const stamp = () => new Date().toISOString();
const transition = (
	goal: GoalRecord,
	status: GoalRecord["status"],
	reason?: GoalRecord["stop_reason"],
) => {
	if (goal.status !== status || goal.stop_reason !== reason)
		goal.stop_detail = undefined;
	goal.status = status;
	goal.stop_reason = reason;
	goal.revision += 1;
	goal.updated_at = stamp();
};

function stopForBudget(goal: GoalRecord): boolean {
	if (goal.token_budget === null) return false;
	if (goal.tokens_used >= goal.token_budget) {
		transition(goal, "budget_limited");
		return true;
	}
	if (!goal.usage_known) {
		transition(goal, "usage_limited");
		return true;
	}
	return false;
}

const readTarget = (
	entry: StoredSessionGoal | null,
	expected: z.infer<typeof target>,
) => {
	if (
		!entry ||
		entry.goal.goal_id !== expected.goal_id ||
		entry.goal.revision !== expected.revision
	)
		throw new GoalConflict("Goal changed. Use /goal to refresh.");
	return entry;
};

export class GoalController {
	private activation: { sessionId: string; goalId: string; id: string } | null =
		null;
	private offer: GoalOffer | null = null;
	private activeRun?: GoalRun;
	private identity?: Promise<string | null>;

	constructor(
		private readonly state: RuntimeState,
		private readonly store: SessionGoalStore,
		private readonly sessions: SessionStateStore,
		private readonly workspaceRoot: () => string | undefined,
	) {}

	get enabled(): boolean {
		return this.state.uiCapabilities?.supports_goals === true;
	}

	disarm(): void {
		this.activation = null;
		this.offer = null;
	}

	private owns(goal: GoalRecord): boolean {
		return (
			this.activation?.sessionId === goal.session_id &&
			this.activation.goalId === goal.goal_id &&
			this.activation.id === goal.activation_id
		);
	}

	private arm(goal: GoalRecord): void {
		this.activation = {
			sessionId: goal.session_id,
			goalId: goal.goal_id,
			id: goal.activation_id,
		};
		this.offer = null;
	}

	private snapshot(
		sessionId: string | null,
		goal: GoalRecord | null,
		acceptedRunId?: string,
	): GoalSnapshot {
		return {
			session_id: sessionId,
			goal,
			can_continue: Boolean(goal?.status === "active" && this.owns(goal)),
			...(acceptedRunId
				? {
						accepted_run_id: acceptedRunId,
						...(this.state.activeRunId === acceptedRunId
							? { active_run_id: acceptedRunId }
							: {}),
					}
				: {}),
		};
	}

	private publish(goal: GoalRecord): void {
		if (this.enabled && this.state.sessionId === goal.session_id)
			send({
				jsonrpc: "2.0",
				method: "goal.updated",
				params: this.snapshot(goal.session_id, goal),
			});
	}

	ready(goal: GoalRecord, afterRunId?: string): void {
		if (
			!this.enabled ||
			this.state.activeRunId ||
			this.state.sessionId !== goal.session_id ||
			goal.status !== "active" ||
			!this.owns(goal) ||
			this.offer
		)
			return;
		this.offer = {
			session_id: goal.session_id,
			goal_id: goal.goal_id,
			revision: goal.revision,
			continuation_id: crypto.randomUUID(),
			...(afterRunId ? { after_run_id: afterRunId } : {}),
		};
		send({ jsonrpc: "2.0", method: "goal.ready", params: this.offer });
	}

	private bound(requested?: string): string | null {
		if (requested !== undefined && requested !== this.state.sessionId)
			throw new GoalConflict("Goal request belongs to a different session.");
		return this.state.sessionId;
	}

	private requireIdle(): void {
		if (this.state.activeRunId)
			throw new GoalConflict("Wait for the active run to finish.", "busy");
	}

	private async recoverable(
		claim: NonNullable<StoredSessionGoal["claim"]>,
	): Promise<boolean> {
		try {
			process.kill(claim.owner_pid, 0);
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH";
		}
		if (!claim.owner_identity) return false;
		const current = await getProcessIdentity(claim.owner_pid, {
			canonicalEnvironment: true,
		});
		return current !== null && current !== claim.owner_identity;
	}

	/** Pause intent is latched before joining the admission queue. */
	handle(
		requestId: string,
		method: GoalMethod,
		raw: unknown,
		serialize: (action: () => Promise<void>) => Promise<void>,
		interrupt: (runId: string) => void,
		onError: (error: unknown) => void,
	): Promise<void> {
		if (!this.enabled) {
			sendError(requestId, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "Goals are unavailable on this connection.",
			});
			return Promise.resolve();
		}
		const pause =
			method === "goal.pause" ? schemas[method].safeParse(raw) : undefined;
		const revoked =
			pause?.success &&
			this.activation?.sessionId === pause.data.session_id &&
			this.activation.goalId === pause.data.goal_id &&
			this.activation.id === pause.data.activation_id;
		if (revoked) this.disarm();
		if (pause?.success && this.state.sessionId === pause.data.session_id) {
			const { goal_id, activation_id, run_id, continuation_id } = pause.data;
			const run = this.activeRun;
			if (
				run?.goal.goal_id === goal_id &&
				run.goal.activation_id === activation_id &&
				(run_id === run.runId ||
					(continuation_id !== undefined &&
						continuation_id === run.continuationId))
			)
				interrupt(run.runId);
		}

		return serialize(async () => {
			let goal: GoalRecord | null;
			let sessionId: string | null;
			let cleared = false;
			switch (method) {
				case "goal.get": {
					const params = schemas[method].parse(raw ?? {});
					sessionId = this.bound(params.session_id);
					const result = sessionId
						? await this.store.read(sessionId, params.continuation_id)
						: null;
					sendResult(
						requestId,
						this.snapshot(
							sessionId,
							result?.entry?.goal ?? null,
							result?.acceptedRunId,
						),
					);
					return;
				}
				case "goal.set": {
					const params = schemas[method].parse(raw);
					this.requireIdle();
					sessionId = this.bound(params.session_id);
					const fresh = sessionId === null;
					if (fresh && !params.objective)
						throw new GoalConflict("Set a goal first.");
					const key = sessionId ?? this.state.nextSessionId();
					if (fresh) {
						const root = this.workspaceRoot();
						const meta = mergeSessionModelOverrideIntoMeta(
							root ? { codelia_workspace_root: root } : undefined,
							this.state.sessionModelOverride,
						);
						await this.sessions.save({
							schema_version: 1,
							session_id: key,
							updated_at: stamp(),
							messages: [],
							...(meta ? { meta } : {}),
						});
					}
					let created = false;
					goal = await this.store.update(key, (tx) => {
						if (!tx.entry) {
							if (
								!params.objective ||
								params.goal_id !== undefined ||
								params.revision !== undefined
							)
								throw new GoalConflict("Set a goal first.");
							const now = stamp();
							created = true;
							tx.entry = {
								approvalSteers: [],
								goal: {
									session_id: key,
									goal_id: crypto.randomUUID(),
									revision: 1,
									objective: params.objective,
									status: "active",
									token_budget: params.token_budget ?? null,
									tokens_used: 0,
									usage_known: true,
									activation_id: crypto.randomUUID(),
									automatic_runs: 0,
									created_at: now,
									updated_at: now,
								},
							};
							return tx.entry.goal;
						}
						const expected = target.parse(params);
						const entry = readTarget(tx.entry, expected);
						if (entry.claim)
							throw new GoalConflict("A goal run is still reserved.", "busy");
						if (entry.goal.status === "complete")
							throw new GoalConflict("Clear the completed goal first.");
						if (params.objective !== undefined) {
							if (params.objective !== entry.goal.objective)
								entry.approvalObjectiveAfterSteers =
									entry.approvalSteers?.length ?? 0;
							entry.goal.objective = params.objective;
							entry.blocker = undefined;
						}
						if (params.token_budget !== undefined)
							entry.goal.token_budget = params.token_budget;
						if (entry.goal.status !== "active" || !stopForBudget(entry.goal))
							transition(entry.goal, entry.goal.status, entry.goal.stop_reason);
						return entry.goal;
					});
					if (fresh) {
						this.state.sessionId = key;
						this.state.attachments?.bindDraft(key);
					}
					sessionId = key;
					if (created) this.arm(goal);
					else this.offer = null;
					break;
				}
				case "goal.pause": {
					const params = schemas[method].parse(raw);
					this.bound(params.session_id);
					sessionId = params.session_id;
					if (!revoked)
						throw new GoalConflict("Goal is not active on this connection.");
					goal = await this.store.update(sessionId, ({ entry }) => {
						if (
							!entry ||
							entry.goal.goal_id !== params.goal_id ||
							entry.goal.activation_id !== params.activation_id
						)
							throw new GoalConflict("Goal changed. Use /goal to refresh.");
						if (entry.goal.status === "active")
							transition(entry.goal, "paused", "user");
						return entry.goal;
					});
					break;
				}
				case "goal.resume": {
					const params = schemas[method].parse(raw);
					this.bound(params.session_id);
					this.requireIdle();
					sessionId = params.session_id;
					const previous = readTarget(
						(await this.store.read(sessionId)).entry,
						params,
					);
					if (previous.goal.status === "complete")
						throw new GoalConflict("Goal is complete.");
					const orphan = previous.claim;
					if (orphan && !(await this.recoverable(orphan)))
						throw new GoalConflict(
							"A goal run is still reserved by a live or unverified runtime.",
							"busy",
						);
					goal = await this.store.update(sessionId, (tx) => {
						const entry = readTarget(tx.entry, params);
						if (entry.claim?.run_id !== orphan?.run_id)
							throw new GoalConflict("Goal run reservation changed.", "busy");
						if (orphan?.pending_seq !== undefined)
							entry.goal.usage_known = false;
						if (orphan) entry.approvalSteers = null;
						entry.claim = undefined;
						if (stopForBudget(entry.goal)) return entry.goal;
						entry.goal.activation_id = crypto.randomUUID();
						entry.goal.automatic_runs = 0;
						entry.blocker = undefined;
						transition(entry.goal, "active");
						return entry.goal;
					});
					if (goal.status === "active") this.arm(goal);
					else this.disarm();
					break;
				}
				case "goal.clear": {
					const params = schemas[method].parse(raw);
					this.bound(params.session_id);
					this.requireIdle();
					sessionId = params.session_id;
					await this.store.update(sessionId, (tx) => {
						if (readTarget(tx.entry, params).claim)
							throw new GoalConflict("A goal run is still reserved.", "busy");
						tx.entry = null;
					});
					this.disarm();
					goal = null;
					cleared = true;
				}
			}
			const snapshot = this.snapshot(sessionId, goal);
			sendResult(requestId, snapshot);
			if (cleared)
				send({ jsonrpc: "2.0", method: "goal.cleared", params: snapshot });
			if (goal) {
				this.publish(goal);
				if (method === "goal.set" || method === "goal.resume") this.ready(goal);
			}
		}).catch((error: unknown) => {
			if (!(error instanceof GoalConflict) && !(error instanceof z.ZodError)) {
				if (method !== "goal.get") this.disarm();
				onError(error);
			}
			this.reject(requestId, error);
		});
	}

	reject(requestId: string, error: unknown): void {
		const conflict = error instanceof GoalConflict ? error : null;
		sendError(requestId, {
			code:
				conflict?.reason === "busy"
					? RPC_ERROR_CODE.RUNTIME_BUSY
					: conflict || error instanceof z.ZodError
						? RPC_ERROR_CODE.INVALID_PARAMS
						: RPC_ERROR_CODE.RUNTIME_INTERNAL,
			message:
				conflict?.message ??
				(error instanceof z.ZodError
					? "Invalid goal parameters."
					: "Goal operation failed."),
		});
	}

	validateOffer(raw: unknown): GoalOffer {
		if (!this.enabled)
			throw new GoalConflict("Goals are unavailable on this connection.");
		const offer = readySchema.parse(raw);
		this.bound(offer.session_id);
		if (
			!this.offer ||
			this.offer.continuation_id !== offer.continuation_id ||
			this.offer.goal_id !== offer.goal_id ||
			this.offer.revision !== offer.revision ||
			this.offer.after_run_id !== offer.after_run_id
		)
			throw new GoalConflict("Continuation is stale or already used.");
		return offer;
	}

	canStart(run: GoalRun): boolean {
		return this.owns(run.goal);
	}

	stopAfterStorageFailure(run: GoalRun): void {
		if (this.owns(run.goal)) this.disarm();
		this.publish(run.goal);
	}

	async reserve(
		sessionId: string,
		runId: string,
		offer: GoalOffer | undefined,
		compaction: boolean,
	): Promise<GoalRun | undefined> {
		const saved = await this.store.read(sessionId).catch((error: unknown) => {
			if (offer || this.activation) throw error;
			return null;
		});
		const initial = saved?.entry;
		if (initial?.claim)
			throw new GoalConflict(
				"A goal run is already reserved for this session.",
				"busy",
			);
		if (initial?.goal.status !== "active" || !this.owns(initial.goal)) {
			if (offer) throw new GoalConflict("Goal is no longer active.");
			return;
		}
		this.identity ??= getProcessIdentity(process.pid, {
			canonicalEnvironment: true,
		});
		const ownerIdentity = await this.identity;
		const run = await this.store.update(sessionId, (tx) => {
			if (offer) this.validateOffer(offer);
			const entry = tx.entry;
			if (entry?.claim)
				throw new GoalConflict(
					"A goal run is already reserved for this session.",
					"busy",
				);
			if (entry?.goal.status !== "active" || !this.owns(entry.goal)) {
				if (offer) throw new GoalConflict("Goal is no longer active.");
				return;
			}
			if (
				offer &&
				(entry.goal.goal_id !== offer.goal_id ||
					entry.goal.revision !== offer.revision ||
					entry.goal.automatic_runs >= 3)
			)
				throw new GoalConflict("Goal no longer accepts this continuation.");
			if (offer) {
				tx.consume(offer.continuation_id, entry.goal.goal_id, runId);
				entry.goal.automatic_runs += 1;
			}
			entry.claim = {
				run_id: runId,
				revision: entry.goal.revision,
				activation_id: entry.goal.activation_id,
				continuation_id: offer?.continuation_id,
				owner_pid: process.pid,
				owner_identity: ownerIdentity,
			};
			return {
				goal: entry.goal,
				runId,
				continuationId: offer?.continuation_id,
				compaction,
				approvalSteers: entry.approvalSteers ?? null,
				approvalObjectiveAfterSteers: entry.approvalObjectiveAfterSteers ?? 0,
			};
		});
		if (run) {
			this.offer = null;
			this.activeRun = run;
		}
		return run;
	}

	recordApprovalSteer(run: GoalRun, text: ReviewUserText | undefined): void {
		if (run.approvalSteers === null) return;
		const steers = [...run.approvalSteers];
		if (text !== undefined) steers.push(text);
		// Keep goal storage bounded and defer review if any correction is unavailable.
		run.approvalSteers =
			text !== undefined &&
			steers.length <= 32 &&
			Buffer.byteLength(JSON.stringify(steers)) <= 24 * 1024
				? steers
				: null;
	}

	tools(run: GoalRun) {
		return [
			defineTool({
				name: "get_goal",
				description:
					"Read this run's session goal, including its objective, status, recorded tokens, and budget, or get {goal: null} if the run no longer holds the goal reservation.",
				input: z.object({}),
				execute: async () => {
					const entry = (await this.store.read(run.goal.session_id)).entry;
					const goal = entry?.claim?.run_id === run.runId ? entry.goal : null;
					return {
						type: "json",
						value: { goal },
						display_content: goal
							? `Goal (${goal.status.replaceAll("_", " ")})\n${goal.objective}`
							: "This run no longer holds the goal reservation.",
					};
				},
			}),
			defineTool({
				name: "update_goal",
				description:
					"Report verified goal completion or a blocker that prevents further work before giving your final answer.",
				input: z.object({
					status: z
						.enum(["complete", "blocked"])
						.describe(
							"Use complete after verifying every goal requirement, or blocked when a concrete obstacle prevents further work. Omit the tool call for ordinary progress.",
						),
					evidence: z
						.string()
						.trim()
						.min(1)
						.max(2_000)
						.describe(
							"For complete, state what you verified and the observed result. For blocked, state the obstacle and why it prevents further work.",
						),
					blocker_key: z
						.string()
						.trim()
						.min(1)
						.max(200)
						.optional()
						.describe(
							"Required for blocked. Reuse the same short key for the same obstacle across runs. Three consecutive goal runs reporting the same key stop the goal.",
						),
				}),
				execute: (report) => {
					if (report.status === "blocked" && !report.blocker_key)
						throw new Error("blocked requires blocker_key");
					if (!this.owns(run.goal)) throw new Error("Goal stopped or changed");
					run.report = report;
					const label = report.status === "complete" ? "Completion" : "Blocker";
					return {
						type: "json",
						value: {
							recorded: true,
							applied_after_successful_finalization: true,
						},
						display_content: `${label} report recorded for evaluation after successful finalization.\n${report.evidence}`,
					};
				},
			}),
		];
	}

	observer(run: GoalRun) {
		return {
			started: async (seq: number) =>
				this.store.update(run.goal.session_id, ({ entry }) => {
					if (entry?.claim?.run_id !== run.runId)
						throw new Error("Goal run reservation missing");
					entry.claim.pending_seq = seq;
				}),
			completed: async (
				seq: number,
				usage: ChatInvokeUsage | null | undefined,
				uncertain: boolean,
			) =>
				this.store.update(run.goal.session_id, ({ entry }) => {
					if (entry?.claim?.run_id !== run.runId)
						throw new Error("Goal run reservation missing");
					const claim = entry.claim;
					if (claim.accounted_seq !== undefined && claim.accounted_seq >= seq)
						return;
					if (claim.pending_seq !== seq)
						throw new Error("Goal invocation is missing its reservation");
					const input = usage?.input_tokens;
					const cached = usage?.input_cached_tokens ?? 0;
					const output = usage?.output_tokens;
					const tokens =
						typeof input === "number" &&
						typeof output === "number" &&
						[input, cached, output].every(
							(value) => Number.isSafeInteger(value) && value >= 0,
						) &&
						cached <= input
							? input - cached + output
							: null;
					if (
						tokens !== null &&
						Number.isSafeInteger(entry.goal.tokens_used + tokens)
					)
						entry.goal.tokens_used += tokens;
					else entry.goal.usage_known = false;
					if (uncertain) entry.goal.usage_known = false;
					entry.goal.updated_at = stamp();
					claim.pending_seq = undefined;
					claim.accounted_seq = seq;
				}),
		};
	}

	async finish(
		run: GoalRun,
		outcome: "completed" | "cancelled" | "error",
		saved: boolean,
	): Promise<GoalRecord | null> {
		if (this.activeRun?.runId === run.runId) this.activeRun = undefined;
		const goal = await this.store.update(run.goal.session_id, ({ entry }) => {
			if (entry?.claim?.run_id !== run.runId) return null;
			entry.approvalSteers = run.approvalSteers;
			if (entry.claim.pending_seq !== undefined) entry.goal.usage_known = false;
			entry.claim = undefined;
			const goal = entry.goal;
			if (
				goal.status !== "active" ||
				goal.revision !== run.goal.revision ||
				!this.owns(goal)
			)
				return goal;
			if (!saved) transition(goal, "paused", "checkpoint_failed");
			else if (outcome !== "completed")
				transition(
					goal,
					"paused",
					outcome === "error" ? "run_error" : "interrupted",
				);
			else if (run.compaction) stopForBudget(goal);
			else if (run.report?.status === "complete") transition(goal, "complete");
			else {
				const key = run.report?.blocker_key;
				entry.blocker =
					key && run.report?.status === "blocked"
						? {
								key,
								runs: entry.blocker?.key === key ? entry.blocker.runs + 1 : 1,
							}
						: undefined;
				if ((entry.blocker?.runs ?? 0) >= 3) {
					transition(goal, "blocked", "blocker");
					goal.stop_detail = run.report?.evidence;
				} else if (!stopForBudget(goal) && goal.automatic_runs >= 3)
					transition(goal, "paused", "turn_limit");
			}
			return goal;
		});
		if (goal) {
			if (goal.status !== "active" && this.owns(goal)) this.disarm();
			this.publish(goal);
		}
		return goal;
	}
}
