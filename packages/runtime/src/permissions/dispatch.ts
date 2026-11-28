import { createHash } from "node:crypto";
import {
	type ToolPermissionClarificationField,
	ToolPermissionDenied,
	toolPermissionClarificationFields,
} from "@codelia/core";
import {
	type ApprovalReceiptScope,
	ApprovalRequestReceipts,
} from "./request-receipts";
import {
	isReviewPrivacyFailure,
	type ReviewDiagnostic,
	readReviewFailure,
	reviewDiagnostic,
	reviewDiagnosticText,
} from "./review-failure";
import { containsReviewCredential } from "./review-privacy";
import {
	type ApprovalFacts,
	type ApprovalOrigin,
	type ApprovalRoute,
	isUnsandboxedShellResource,
	routeApproval,
} from "./route";
import { awaitAbortable, selectShellAllowance } from "./shell-confirmation";

export type ApprovalRequest = Readonly<{
	id: string;
	owner: string;
	origin: ApprovalOrigin;
	subject: string;
	registration: string;
	/** Serialized validated input. Used for binding and the selected prompt only. */
	input: string;
	authorityVersion: string;
	intentVersion: string;
	connectionGeneration: string;
	/** Owning run, when the request is associated with one. */
	runId?: string;
}>;

export type ApprovalChoice =
	| "allow_once"
	| "deny_continue"
	| "deny_stop"
	| "save_session"
	| "save_project"
	| "grant_session"
	| "setup_allowance";
export type ProposedShellAllowance = {
	description: string;
	commit: (scope: "session" | "project") => void;
};
export type InteractiveShellConfirmation = {
	propose?: (
		request: ApprovalRequest,
		signal: AbortSignal,
	) => Promise<ProposedShellAllowance | undefined>;
};

export type SessionGrant = {
	description: string;
	commit: () => void;
};
type ReviewFallback =
	| "review_not_delegated"
	| "review_evidence_unavailable"
	| "review_unavailable"
	| "review_inconclusive"
	| "ask_user";
export const approvalReviewDecisions = [
	"allow_once",
	"deny",
	"insufficient_evidence",
	"ask_user",
] as const;
type ReviewDecision = (typeof approvalReviewDecisions)[number];
type Clarification = ToolPermissionClarificationField | "unspecified";
type ReviewFailure =
	| Readonly<{
			fallback: Exclude<ReviewFallback, "ask_user">;
			diagnostic?: ReviewDiagnostic;
			oneTimeConfirmation?: "private_evidence" | "inconclusive";
	  }>
	| Readonly<{ fallback: "ask_user"; missing: Clarification }>;
const failure = (
	fallback: Exclude<ReviewFallback, "ask_user">,
	diagnostic?: ReviewDiagnostic,
	oneTimeConfirmation?: "private_evidence" | "inconclusive",
): ReviewFailure => ({
	fallback,
	...(diagnostic ? { diagnostic } : {}),
	...(oneTimeConfirmation ? { oneTimeConfirmation } : {}),
});
type ReviewOutcome = "allow_once" | "deny" | ReviewFailure;
export type Confirmation = Readonly<{
	requestId: string;
	subject: string;
	origin: ApprovalOrigin;
	preview: string;
	route: ApprovalRoute;
	expiresAt: number;
	choices: readonly ApprovalChoice[];
	saveDescription?: string;
	grantDescription?: string;
	reviewFallback?: ReviewFallback | "review_denied";
	/** Transient, validated reviewer explanation for the local human prompt. */
	reviewReason?: string;
	shellStage?: "initial" | "rule" | "unavailable";
	reviewDiagnostic?: ReviewDiagnostic;
	reviewWithheldForPrivacy?: boolean;
	/** Set by the shell authorizer for a one-command unsandboxed launch. */
	escalation?: "unsandboxed";
	/** False when configured protected paths do not apply to an unsandboxed launch. */
	protectedPathsEnforced?: false;
}>;

export type ApprovalService = {
	available?: () => boolean;
	confirm?: (request: Confirmation, signal: AbortSignal) => Promise<unknown>;
};

export type ReviewAdapter = {
	categories: readonly NonNullable<ApprovalFacts["reviewCategory"]>[];
	/** The trusted host supplies and classifies current, user-authored evidence. */
	buildEvidence: (
		request: ApprovalRequest,
		signal: AbortSignal,
	) => Promise<string | Readonly<Record<string, unknown>> | null>;
	/** Optional final local check and preparation before sending evidence. */
	reserve?: (
		packet: string,
		signal: AbortSignal,
		request: ApprovalRequest,
	) => boolean;
	/** The local confirmation can display only a credential-safe version of the command. */
	privacyConfirmationPreview?: (
		preview: string,
		request: ApprovalRequest,
		diagnostic: ReviewDiagnostic,
	) => string | undefined;
	review: (
		packet: string,
		signal: AbortSignal,
		request: ApprovalRequest,
	) => Promise<unknown>;
	/** Cancels this review if the active delegation is revoked. */
	reviewSignal?: () => AbortSignal;
	/** Bind cached denials and unconsumed permits to the current reviewer authority. */
	reviewVersion?: (request: ApprovalRequest) => string | undefined;
	stillApproved?: (request: ApprovalRequest) => boolean;
};

export type ApprovalAudit = Readonly<{
	requestId: string;
	origin: ApprovalOrigin;
	subject: string;
	profile: ApprovalRoute["profile"];
	actor: "rule" | "user" | "review" | "sandbox";
	taskId?: string;
	runId?: string;
	route: ApprovalRoute["kind"];
	reason: string;
	reviewDiagnostic?: ReviewDiagnostic;
	state: "dispatch" | "denied" | "expired" | "save_failed" | "review_failed";
	at: number;
}>;

const freezeRoute = (route: ApprovalRoute): ApprovalRoute =>
	Object.freeze({
		...route,
		resources: Object.freeze(
			route.resources.map((resource) => Object.freeze({ ...resource })),
		),
		additional: Object.freeze(
			route.additional.map((resource) => Object.freeze({ ...resource })),
		),
	});

const reject = (reason: string, stop_turn = false): never => {
	throw new ToolPermissionDenied({ decision: "deny", reason, stop_turn });
};

const agentReviewReasons: Record<ReviewFallback | "deny", string> = {
	deny: "review_denied: Auto approve denied this action. Do not pursue the same effect by another means. Continue only with a materially safer action, or report the blocker.",
	review_not_delegated:
		"review_not_delegated: Auto approve is unavailable for this action.",
	review_evidence_unavailable:
		"review_evidence_unavailable: The runtime could not safely provide enough evidence for this action.",
	review_unavailable:
		"review_unavailable: Auto approve did not return a usable decision.",
	review_inconclusive:
		"review_inconclusive: Auto approve could not establish the effects or authorization of this action.",
	ask_user:
		"review_user_decision_required: Ask the user to clarify the target, scope, or authorization before proposing this action again.",
};

const rejectLocalReview = (
	reason: ReviewFallback | "deny",
	missing: Clarification = "unspecified",
	diagnostic?: ReviewDiagnostic,
): never => {
	const message = agentReviewReasons[reason];
	if (reason === "ask_user") {
		throw new ToolPermissionDenied({
			decision: "deny",
			reason: message,
			clarification: { missing },
			stop_turn: false,
		});
	}
	if (reason === "deny") return reject(message);
	const specificReason = diagnostic && reviewDiagnosticText(diagnostic);
	const explanation =
		reason === "review_evidence_unavailable" && specificReason
			? specificReason
			: [message, specificReason].filter(Boolean).join(" ");
	return reject(
		`${explanation} Do not repeat this request without new evidence or updated instructions. For a read-only task, use the built-in read or read_line if they can do the work. Otherwise report the blocker.`,
	);
};

const digest = (request: Omit<ApprovalRequest, "id">): string =>
	createHash("sha256").update(JSON.stringify(request)).digest("hex");

const responseRecord = (
	result: unknown,
): Record<string, unknown> | undefined =>
	result !== null && typeof result === "object" && !Array.isArray(result)
		? (result as Record<string, unknown>)
		: undefined;

export const parseApprovalReviewDecision = (
	reply: unknown,
	requestId: string,
): ReviewDecision | undefined => {
	const record = responseRecord(reply);
	if (
		!record ||
		Object.keys(record).length !== 3 ||
		record.request_id !== requestId ||
		typeof record.reason !== "string" ||
		!record.reason.trim() ||
		record.reason.length > 512
	)
		return undefined;
	const decision = record.decision;
	return decision === "allow_once" ||
		decision === "deny" ||
		decision === "insufficient_evidence" ||
		decision === "ask_user"
		? decision
		: undefined;
};

const clarificationFromReply = (reply: unknown): Clarification => {
	const reason = responseRecord(reply)?.reason;
	return (
		toolPermissionClarificationFields.find((item) => item === reason) ??
		"unspecified"
	);
};

export class ApprovalDispatcher {
	// Shell and task RPCs enter here before spawning. Direct tool.call owns
	// its transport receipt independently of any nested approval.
	private readonly requests = new ApprovalRequestReceipts<unknown>();
	private readonly reviewDenials = new Set<string>();
	private readonly localReviewFailures = new Map<
		string,
		{ outcome: ReviewFailure; expiresAt?: number }
	>();

	constructor(
		private readonly options: {
			confirmation?: ApprovalService;
			review?: ReviewAdapter;
			audit?: (entry: ApprovalAudit) => void;
			deadline?: (ms: number) => AbortSignal;
			monotonicNow?: () => number;
		} = {},
	) {}

	private reviewFailure(key: string, now: number): ReviewFailure | undefined {
		const failure = this.localReviewFailures.get(key);
		if (failure?.expiresAt !== undefined && now >= failure.expiresAt) {
			this.localReviewFailures.delete(key);
			return undefined;
		}
		return failure?.outcome;
	}

	dispatch<T>(options: {
		request: ApprovalRequest;
		/** Synchronous admission facts, recomputed after any wait. */
		evaluate: () => ApprovalFacts;
		stillCurrent: () => boolean;
		preview: () => string;
		signal?: AbortSignal;
		deduplicate?: boolean;
		receiptScope?: ApprovalReceiptScope;
		/** Same confined invocation, independent of labels, IDs, and requested timeouts. */
		reviewRetryKey?: string;
		/** Advisory source references may resolve previously incomplete evidence. */
		reviewRetryEvidenceKey?: string;
		/** Safe explanation for an enabled Auto approve request outside review coverage. */
		reviewCoverageDiagnostic?: ReviewDiagnostic;
		grantSession?: SessionGrant;
		/** Set by the shell authorizer for a one-command unsandboxed launch. */
		escalation?: "unsandboxed";
		/** False when configured protected paths do not apply to an unsandboxed launch. */
		protectedPathsEnforced?: false;
		interactiveShell?: InteractiveShellConfirmation;
		save?:
			| {
					description: string;
					commit: (scope: "session" | "project") => void;
			  }
			| {
					description: string;
					rememberProject: () => Promise<void>;
			  };
		/** Commits to execution synchronously, before awaiting its result. */
		execute: (
			consume: (details?: { taskId?: string }) => void,
			saveScope?: "session" | "project",
		) => T | Promise<T>;
		deferConsumption?: boolean;
		/** Optional callback invoked once with elapsed approval/review wait before execute (or on deny/abort). */
		onApprovalWaitMs?: (durationMs: number) => void;
	}): Promise<T> {
		const nowMs = this.options.monotonicNow ?? (() => performance.now());
		const approvalStartedAt = options.onApprovalWaitMs ? nowMs() : 0;
		let approvalRecorded = false;
		const recordApprovalWait = () => {
			if (approvalRecorded || !options.onApprovalWaitMs) return;
			approvalRecorded = true;
			options.onApprovalWaitMs(Math.max(0, nowMs() - approvalStartedAt));
		};
		const request = Object.freeze({ ...options.request });
		const { id, ...binding } = request;
		const receiptBinding = options.deduplicate ? digest(binding) : undefined;
		const scope = options.receiptScope;
		const requestSignal =
			scope && options.deduplicate
				? AbortSignal.any([
						scope.connectionSignal,
						scope.ownerSignal,
						...(options.signal ? [options.signal] : []),
					])
				: options.signal;
		const dispatch = async (): Promise<T> => {
			const facts = options.evaluate();
			const route = freezeRoute(routeApproval(facts));
			let actor: ApprovalAudit["actor"] =
				facts.confinedAutoLaunch && route.kind === "immediate"
					? "sandbox"
					: "rule";
			const audit = (
				state: ApprovalAudit["state"],
				reason: string,
				taskId?: string,
				diagnostic?: ReviewDiagnostic,
			) =>
				this.options.audit?.({
					requestId: id,
					origin: request.origin,
					subject: request.subject,
					route: route.kind,
					profile: route.profile,
					actor,
					state,
					reason,
					...(diagnostic ? { reviewDiagnostic: diagnostic } : {}),
					at: Date.now(),
					...(taskId ? { taskId } : {}),
					...(request.runId ? { runId: request.runId } : {}),
				});

			if (route.kind === "deny") {
				audit("denied", route.reason);
				return reject(route.reason);
			}
			const expire = (reason: string, diagnostic?: ReviewDiagnostic): never => {
				audit("expired", reason, undefined, diagnostic);
				return reject(
					diagnostic
						? `${reason}: ${reviewDiagnosticText(diagnostic)}`
						: reason,
				);
			};
			const checkCurrent = (reviewing = false) => {
				if (requestSignal?.aborted || !options.stillCurrent()) {
					expire(
						"approval_expired",
						reviewing
							? reviewDiagnostic(
									requestSignal?.aborted
										? "review_cancelled"
										: "review_authority_changed",
								)
							: undefined,
					);
				}
			};
			checkCurrent();
			// One-command unsandboxed escalation uses the interactive shell prompt
			// without rule-save choices.
			const unsandboxedEscalation =
				route.profile === "full-access" &&
				route.additional.length === 1 &&
				isUnsandboxedShellResource(route.additional[0]);
			const interactive =
				options.interactiveShell &&
				request.subject === "shell" &&
				(request.origin === "parent_agent" || request.origin === "operator") &&
				(((route.profile === "development" ||
					route.profile === "investigation") &&
					!route.additional.length) ||
					unsandboxedEscalation) &&
				this.options.confirmation?.confirm &&
				this.options.confirmation.available?.() !== false
					? options.interactiveShell
					: undefined;
			if (route.kind === "defer" && !interactive) {
				const diagnostic =
					options.reviewCoverageDiagnostic ??
					reviewDiagnostic("review_evidence_unavailable");
				audit("denied", "review_evidence_unavailable", undefined, diagnostic);
				return rejectLocalReview(
					"review_evidence_unavailable",
					undefined,
					diagnostic,
				);
			}
			let save = options.save;
			let saveScope: "session" | "project" | undefined;
			let sessionGrant: SessionGrant | undefined;
			const version =
				route.kind === "review"
					? this.options.review?.reviewVersion?.(request)
					: undefined;
			if (route.kind !== "immediate") {
				const retryKey =
					facts.autoReview && route.kind === "review"
						? createHash("sha256")
								.update(
									JSON.stringify([
										request.owner,
										request.intentVersion,
										request.authorityVersion,
										version,
										options.reviewRetryKey ?? digest(binding),
									]),
								)
								.digest("hex")
						: undefined;
				const evidenceKey =
					retryKey === undefined
						? undefined
						: `${retryKey}/${options.reviewRetryEvidenceKey ?? ""}`;
				const now = this.options.monotonicNow ?? (() => performance.now());
				const cachedFailure =
					retryKey === undefined || evidenceKey === undefined
						? undefined
						: (this.reviewFailure(retryKey, now()) ??
							this.reviewFailure(evidenceKey, now()));
				let reviewReason: string | undefined;
				const reviewResult: ReviewOutcome =
					cachedFailure ??
					(route.kind === "review"
						? await this.review(
								request,
								retryKey ?? receiptBinding ?? digest(binding),
								facts.reviewCategory,
								version,
								requestSignal,
								interactive
									? (reason) => {
											reviewReason = reason;
										}
									: undefined,
							)
						: route.kind === "defer"
							? failure(
									"review_evidence_unavailable",
									options.reviewCoverageDiagnostic ??
										reviewDiagnostic("review_evidence_unavailable"),
								)
							: { fallback: "ask_user", missing: "unspecified" });
				const outcome =
					facts.autoReview &&
					route.kind === "review" &&
					typeof reviewResult === "object" &&
					reviewResult.fallback === "ask_user" &&
					reviewResult.missing === "unspecified"
						? failure("review_inconclusive")
						: reviewResult;
				const decision =
					typeof outcome === "object" ? outcome.fallback : outcome;
				const failureDetails =
					typeof outcome === "object" && outcome.fallback !== "ask_user"
						? outcome
						: undefined;
				const diagnostic = failureDetails?.diagnostic;
				const confirmationCause = failureDetails?.oneTimeConfirmation;
				const manualPrivacyFallback = confirmationCause === "private_evidence";
				const manualInconclusiveFallback =
					facts.autoReview === true && confirmationCause === "inconclusive";
				const oneTimeConfirmation =
					manualPrivacyFallback || manualInconclusiveFallback;
				if (
					confirmationCause === "inconclusive" ||
					decision === "allow_once" ||
					decision === "deny" ||
					(diagnostic &&
						decision !== "review_evidence_unavailable" &&
						diagnostic.code !== "review_preparation_failed")
				)
					actor = "review";
				checkCurrent(route.kind === "review");
				if (
					interactive &&
					diagnostic &&
					(diagnostic.code === "review_cancelled" ||
						diagnostic.code === "review_authority_changed")
				) {
					return expire("approval_expired", diagnostic);
				}
				if (decision === "deny" && !interactive) {
					audit("denied", "review_denied");
					return facts.autoReview
						? rejectLocalReview("deny")
						: reject("review_denied");
				}
				if (
					retryKey !== undefined &&
					evidenceKey !== undefined &&
					outcome !== "allow_once" &&
					outcome !== "deny" &&
					!manualPrivacyFallback
				) {
					if (!cachedFailure) {
						if (this.localReviewFailures.size >= 256) {
							const oldest = this.localReviewFailures.keys().next().value;
							if (oldest !== undefined) this.localReviewFailures.delete(oldest);
						}
						const failureKey =
							decision === "review_unavailable" ||
							decision === "review_not_delegated"
								? retryKey
								: evidenceKey;
						this.localReviewFailures.set(failureKey, {
							outcome,
							...(decision === "review_unavailable"
								? { expiresAt: now() + 15_000 }
								: {}),
						});
					}
					if (!manualInconclusiveFallback && !interactive) {
						audit(
							"denied",
							decision === "ask_user"
								? "review_user_decision_required"
								: decision,
							undefined,
							diagnostic,
						);
						return outcome.fallback === "ask_user"
							? rejectLocalReview("ask_user", outcome.missing)
							: rejectLocalReview(outcome.fallback, undefined, diagnostic);
					}
				}
				if (decision !== "allow_once") {
					if (decision === "deny") audit("review_failed", "review_denied");
					else if (diagnostic)
						audit("review_failed", decision, undefined, diagnostic);
					const confirm = this.options.confirmation?.confirm;
					if (!confirm || this.options.confirmation?.available?.() === false) {
						if (manualInconclusiveFallback) {
							audit("denied", "review_inconclusive");
							return reject(
								`${agentReviewReasons.review_inconclusive} Interactive confirmation is unavailable on this connection.`,
							);
						}
						if (manualPrivacyFallback)
							return rejectLocalReview(
								"review_evidence_unavailable",
								undefined,
								diagnostic,
							);
						return reject(
							diagnostic
								? `confirmation_required: ${reviewDiagnosticText(diagnostic)}`
								: "confirmation_required",
						);
					}
					if (manualInconclusiveFallback) audit("review_failed", decision);
					actor = "user";
					const withheld =
						manualPrivacyFallback ||
						!!(
							interactive &&
							diagnostic &&
							isReviewPrivacyFailure(diagnostic.code)
						);
					const preview =
						withheld && diagnostic
							? (this.options.review?.privacyConfirmationPreview?.(
									options.preview(),
									request,
									diagnostic,
								) ??
								"Command details are hidden here. Inspect the original shell proposal before choosing Run once.")
							: options.preview();
					const checkRouteCurrent = () => {
						checkCurrent();
						if (
							JSON.stringify(routeApproval(options.evaluate())) !==
							JSON.stringify(route)
						)
							return expire("authority_changed");
					};
					const ask = async (
						requestId: string,
						choices: ApprovalChoice[],
						details: Pick<
							Confirmation,
							"shellStage" | "saveDescription" | "grantDescription"
						> = {},
					): Promise<ApprovalChoice> => {
						checkRouteCurrent();
						const deadline = (this.options.deadline ?? AbortSignal.timeout)(
							120_000,
						);
						const signal = requestSignal
							? AbortSignal.any([deadline, requestSignal])
							: deadline;
						const reply = responseRecord(
							await awaitAbortable(signal, () =>
								confirm(
									{
										requestId,
										subject: request.subject,
										origin: request.origin,
										preview,
										route,
										...(route.kind === "review" || route.kind === "defer"
											? {
													reviewFallback:
														decision === "deny" ? "review_denied" : decision,
													...(reviewReason ? { reviewReason } : {}),
													...(diagnostic
														? { reviewDiagnostic: diagnostic }
														: {}),
													...(manualPrivacyFallback
														? { reviewWithheldForPrivacy: true }
														: {}),
												}
											: {}),
										expiresAt: Date.now() + 120_000,
										choices,
										...(options.escalation === "unsandboxed"
											? {
													escalation: "unsandboxed" as const,
													...(options.protectedPathsEnforced === false
														? { protectedPathsEnforced: false as const }
														: {}),
												}
											: {}),
										...details,
									},
									signal,
								),
							),
						);
						if (signal.aborted) return expire("approval_expired");
						checkCurrent();
						if (
							reply?.requestId !== requestId ||
							!choices.includes(reply.choice as ApprovalChoice)
						)
							return reject("confirmation_required");
						return reply.choice as ApprovalChoice;
					};
					let choice: ApprovalChoice;
					if (interactive) {
						const propose =
							!withheld && !facts.opaque && !facts.humanOnly
								? interactive.propose
								: undefined;
						const selected = await selectShellAllowance({
							request,
							propose,
							ask,
							checkCurrent: checkRouteCurrent,
							signal: requestSignal,
						});
						choice = selected.choice;
						save = selected.proposal;
					} else {
						const choices: ApprovalChoice[] = [
							"allow_once",
							"deny_continue",
							"deny_stop",
						];
						if (
							!oneTimeConfirmation &&
							save &&
							!facts.opaque &&
							!facts.humanOnly
						) {
							if ("commit" in save) choices.push("save_session");
							choices.push("save_project");
						}
						if (!oneTimeConfirmation && options.grantSession)
							choices.push("grant_session");
						choice = await ask(
							id,
							choices,
							!oneTimeConfirmation
								? {
										saveDescription: save?.description,
										grantDescription: options.grantSession?.description,
									}
								: {},
						);
					}
					if (choice === "grant_session") sessionGrant = options.grantSession;
					if (choice === "save_session") saveScope = "session";
					if (choice === "save_project") saveScope = "project";
					if (choice === "deny_continue" || choice === "deny_stop") {
						audit("denied", "user_denied");
						return reject("user_denied", choice === "deny_stop");
					}
				}
				checkCurrent(actor === "review");
				if (
					JSON.stringify(routeApproval(options.evaluate())) !==
					JSON.stringify(route)
				) {
					return expire(
						"authority_changed",
						actor === "review"
							? reviewDiagnostic("review_authority_changed")
							: undefined,
					);
				}
			}
			sessionGrant?.commit();
			if (saveScope === "project" && save && "rememberProject" in save) {
				try {
					await save.rememberProject();
				} catch (error) {
					if (error instanceof Error && error.message === "approval_expired")
						return expire("approval_expired");
					audit("save_failed", "project_tool_rule_save_failed");
					return reject(
						"project_tool_rule_save_failed: Could not save this workspace permission to the personal policy store. The tool did not run.",
					);
				}
			}
			let consumed = false;
			const consume = (details?: { taskId?: string }) => {
				if (consumed) reject("approval_already_consumed");
				checkCurrent(actor === "review");
				if (
					actor === "review" &&
					(this.options.review?.stillApproved?.(request) === false ||
						(this.options.review?.reviewVersion &&
							this.options.review.reviewVersion(request) !== version))
				) {
					const diagnostic = reviewDiagnostic("review_authority_changed");
					audit("expired", "review_authority_changed", undefined, diagnostic);
					return reject(
						`approval_expired: ${reviewDiagnosticText(diagnostic)}`,
					);
				}
				consumed = true;
				if (saveScope && save && "commit" in save) {
					try {
						save.commit(saveScope);
					} catch {
						audit("save_failed", "launch_rule_save_failed");
					}
				}
				audit("dispatch", route.reason, details?.taskId);
			};
			if (!options.deferConsumption) consume();
			recordApprovalWait();
			return options.execute(consume, saveScope);
		};
		const run =
			receiptBinding !== undefined
				? this.requests.run(scope, id, receiptBinding, dispatch)
				: Promise.resolve().then(dispatch);
		return options.onApprovalWaitMs
			? run.finally(recordApprovalWait)
			: run;
	}

	private async review(
		request: ApprovalRequest,
		fingerprint: string,
		category: ApprovalFacts["reviewCategory"],
		version: string | undefined,
		callerSignal?: AbortSignal,
		receiveReason?: (reason: string) => void,
	): Promise<ReviewOutcome> {
		const adapter = this.options.review;
		if (!adapter || !category) return failure("review_not_delegated");
		// A broad shell delegation covers the narrower test class. The reverse would
		// silently widen an existing SDK host's local_test grant.
		const delegated =
			category === "local_test" && adapter.categories.includes("local_shell")
				? "local_shell"
				: category;
		if (!adapter.categories.includes(delegated))
			return failure("review_not_delegated");
		if (adapter.reviewVersion && version === undefined)
			return failure("review_not_delegated");
		const reviewSignal = adapter.reviewSignal?.();
		const signal =
			reviewSignal && callerSignal
				? AbortSignal.any([reviewSignal, callerSignal])
				: (reviewSignal ?? callerSignal ?? new AbortController().signal);
		const interrupted = (): ReviewDiagnostic | undefined => {
			if (callerSignal?.aborted) return reviewDiagnostic("review_cancelled");
			try {
				if (adapter.reviewVersion?.(request) !== version)
					return reviewDiagnostic("review_authority_changed");
			} catch {
				return reviewDiagnostic("review_preparation_failed");
			}
			if (signal.aborted) return reviewDiagnostic("review_cancelled");
		};
		const unavailable = (code: ReviewDiagnostic["code"]) =>
			failure("review_unavailable", reviewDiagnostic(code));
		if (signal.aborted) return unavailable("review_cancelled");
		const denialKey =
			version === undefined
				? fingerprint
				: JSON.stringify([fingerprint, version]);
		if (this.reviewDenials.has(denialKey))
			return adapter.stillApproved?.(request) === false
				? { fallback: "ask_user", missing: "unspecified" }
				: "deny";
		let phase: ReviewDiagnostic["code"] = "review_preparation_failed";
		try {
			const evidence = await awaitAbortable(signal, () =>
				adapter.buildEvidence(request, signal),
			);
			const beforeSend = interrupted();
			if (beforeSend) return failure("review_unavailable", beforeSend);
			if (!evidence)
				return failure(
					"review_evidence_unavailable",
					reviewDiagnostic("review_evidence_unavailable"),
				);
			const packet = JSON.stringify({
				request_id: request.id,
				phase: "pre_launch",
				category: delegated,
				evidence,
			});
			if (Buffer.byteLength(packet, "utf8") > 8192)
				return failure(
					"review_evidence_unavailable",
					reviewDiagnostic("review_evidence_too_large"),
				);
			if (adapter.reserve && !adapter.reserve(packet, signal, request))
				return failure(
					"review_unavailable",
					interrupted() ?? reviewDiagnostic("review_preparation_failed"),
				);
			phase = "review_unexpected_failure";
			const reply = await awaitAbortable(signal, () =>
				adapter.review(packet, signal, request),
			);
			const afterSend = interrupted();
			if (afterSend) return failure("review_unavailable", afterSend);
			const decision = parseApprovalReviewDecision(reply, request.id);
			if (!decision) return unavailable("review_invalid_reply");
			if (
				receiveReason &&
				(decision === "deny" || decision === "insufficient_evidence")
			) {
				const reason = responseRecord(reply)?.reason;
				if (
					typeof reason === "string" &&
					!containsReviewCredential(reason) &&
					!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(reason)
				)
					receiveReason(reason.trim());
			}
			if (decision === "deny") this.reviewDenials.add(denialKey);
			if (decision === "ask_user") {
				const missing = clarificationFromReply(reply);
				if (missing !== "unspecified")
					receiveReason?.(`Please confirm the ${missing}.`);
				return missing === "unspecified"
					? failure(
							"review_inconclusive",
							reviewDiagnostic("review_invalid_reply"),
						)
					: { fallback: "ask_user", missing };
			}
			return decision === "insufficient_evidence"
				? failure("review_inconclusive", undefined, "inconclusive")
				: decision;
		} catch (error) {
			const diagnostic =
				interrupted() ?? readReviewFailure(error) ?? reviewDiagnostic(phase);
			return failure(
				diagnostic.code.startsWith("review_evidence_")
					? "review_evidence_unavailable"
					: "review_unavailable",
				diagnostic,
				phase === "review_preparation_failed" &&
					isReviewPrivacyFailure(diagnostic.code)
					? "private_evidence"
					: undefined,
			);
		}
	}
}
