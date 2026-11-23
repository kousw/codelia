import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationApprovalContext } from "@codelia/core";
import type { RunInput } from "@codelia/protocol";
import { resolveStoragePaths } from "@codelia/storage";
import { z } from "zod";
import type { ApprovalRequest } from "./dispatch";
import {
	type ReviewEvidenceLocation,
	ReviewFailureError,
	readReviewFailure,
} from "./review-failure";
import {
	createReviewCredentialDetector,
	reviewUrlReferences,
} from "./review-privacy";
import { analyzeShell, singleCommandWords } from "./shell-analysis";
import { isWithin, resolvePolicyPath } from "./shell-backend";
import { confinedAutoLaunchDirectoryName } from "./workspace-config-paths";

export type ReviewUserText =
	| string
	| Readonly<{ text: string; attachmentsOmitted: true }>;
type ReviewIntent = {
	original: ReviewUserText;
	corrections: readonly ReviewUserText[];
	earlierGoalSteers?: readonly ReviewUserText[];
};

const messageId = z
	.string()
	.max(17)
	.regex(/^m(?:0|[1-9][0-9]*)$/u);
export const reviewHistoryReferences = z.strictObject({
	user_message_id: messageId.describe(
		"Original user message ID from conversation_search or conversation_read that supplies earlier consent.",
	),
	proposal_message_id: messageId
		.optional()
		.describe(
			"Original assistant proposal ID, required when the user message only confirms an earlier proposal.",
		),
});
export type ReviewHistoryReferences = z.infer<typeof reviewHistoryReferences>;

const shellResultOpen = "<shell_result>\n";
const shellResultClose = "\n</shell_result>";
const shellResultFrame = z.object({
	id: z.string(),
	command_preview: z.string(),
});

/** Accept only leading frames in the wire format produced by the TUI. */
const stripTuiShellResults = (input: string): string | undefined => {
	let offset = 0;
	while (input.startsWith(shellResultOpen, offset)) {
		const start = offset + shellResultOpen.length;
		const end = input.indexOf("\n", start);
		if (end < 0 || !input.startsWith(shellResultClose, end)) return undefined;
		const payload = input.slice(start, end);
		if (/[<>\r]/u.test(payload)) return undefined;
		try {
			if (!shellResultFrame.safeParse(JSON.parse(payload)).success)
				return undefined;
		} catch {
			return undefined;
		}
		offset = end + shellResultClose.length;
		if (input.startsWith("\n\n", offset)) return input.slice(offset + 2);
		if (!input.startsWith(`\n${shellResultOpen}`, offset)) return undefined;
		offset++;
	}
	return input;
};

/** Keep user-authored text only. Never pass attachment data or embedded shell output to a reviewer. */
export const reviewIntentText = (
	input: RunInput,
	options: { tuiShellPrefix?: boolean } = {},
): ReviewUserText | undefined => {
	const raw =
		input.type === "text"
			? input.text
			: input.parts
					.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("\n");
	const text = options.tuiShellPrefix ? stripTuiShellResults(raw) : raw;
	if (!text?.trim() || /<\/?shell_result>/u.test(text)) return undefined;
	return input.type === "parts" &&
		input.parts.some((part) => part.type !== "text")
		? { text, attachmentsOmitted: true }
		: text;
};

const invocation = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("argv"),
		executable: z.string(),
		args: z.array(z.string()),
	}),
	z.object({
		kind: z.literal("source"),
		dialect: z.enum(["bash", "unsupported"]),
		executable: z.string(),
		options: z.array(z.string()),
		source: z.string(),
	}),
]);

const shellRequest = z.object({
	reviewedDirectory: z.string().optional(),
	reviewPrivatePaths: z.array(z.string()).optional(),
	reviewHistory: reviewHistoryReferences.optional(),
	invocation,
	protection: z.object({
		profile: z.enum(["investigation", "development", "full-access"]),
		root: z.string(),
		cwd: z.string(),
		stdin: z.literal("closed"),
		writeRoots: z.array(z.string()),
		protectedPaths: z.array(z.string()).default([]),
	}),
	analysis: z.object({
		opaque: z.boolean(),
		singleStage: z.literal(true).optional(),
		compound: z.boolean(),
		operations: z.array(z.object({ argv: z.array(z.string()).min(1) })),
	}),
	opaqueReason: z
		.enum([
			"indirect_execution",
			"interactive_stdin",
			"unrestricted_program",
			"unbound_working_directory",
		])
		.optional(),
	/** One-command escalation out of a confined session. */
	escalation: z.literal("unsandboxed").optional(),
});

const sharingRestrictions = [
	/\b(?:do not|don't|never)\s+(?:send|share|disclose|transmit)(?:\s+(?:this|the|my|any)\b[^.\n]*?\b(?:request|prompt|intent|conversation|command|evidence|paths?|filenames?|content|text|data)\b|(?:\s+(?:this|it))?\s+(?:to|with)\s+(?:(?:an?|the)\s+)?(?:external|third-party|reviewer)\b|(?:\s+(?:this|it))?(?=\s*[.!?\n]|$))/iu,
	/\b(?:no external (?:review|sharing|disclosure)|do not (?:use|run) (?:external review|auto approve)|keep (?:this|it|(?:this|the) (?:request|prompt|command|content|data)) (?:private|confidential|local))\b/iu,
	/(?:外部(?:へ|に|と)?(?:の)?\s*(?:送信|転送|共有|開示|レビュー)|(?:この|私の)(?:依頼|リクエスト|コマンド|会話|内容).{0,12}(?:送信|共有|開示)).{0,12}(?:禁止|不要|しない|するな|しないで)/u,
	/外部(?:へ|に)\s*送(?:らない|らず|るな)/u,
];
const runtimeReviewPrivatePaths = (): readonly string[] => {
	const storage = resolveStoragePaths();
	return [
		storage.credentialsDir,
		storage.authFile,
		storage.mcpAuthFile,
		storage.legacyAuthFile,
		storage.legacyMcpAuthFile,
		path.join(storage.configDir, "auto-review.json"),
		path.join(storage.configDir, "launch-approvals"),
		path.join(storage.configDir, confinedAutoLaunchDirectoryName),
	];
};

const lexicalAndCanonical = (location: string): string[] => {
	try {
		return [location, resolvePolicyPath(location)];
	} catch {
		return [location];
	}
};

function separateQuotedText(input: string): {
	text: string;
	quotedText?: string;
} {
	const own: string[] = [];
	const quoted: string[] = [];
	let fence: string | undefined;
	for (const line of input.split("\n")) {
		const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
		if (fence) {
			quoted.push(line);
			if (marker?.startsWith(fence) && line.trim() === marker)
				fence = undefined;
		} else if (marker) {
			fence = marker;
			quoted.push(line);
		} else if (/^\s*>/u.test(line)) {
			quoted.push(line);
		} else {
			own.push(line);
		}
	}
	return {
		text: own.join("\n"),
		...(quoted.length ? { quotedText: quoted.join("\n") } : {}),
	};
}

const parseShellRequest = (request: ApprovalRequest) => {
	let input: unknown;
	try {
		input = JSON.parse(request.input);
	} catch {
		throw new ReviewFailureError(
			"review_evidence_invalid",
			undefined,
			"shell_request",
		);
	}
	const parsed = shellRequest.safeParse(input);
	if (!parsed.success)
		throw new ReviewFailureError(
			"review_evidence_invalid",
			undefined,
			"shell_request",
		);
	return parsed.data;
};

const prepareShellOperation = (request: ApprovalRequest, workspace: string) => {
	const input = parseShellRequest(request);
	const { protection, invocation, analysis } = input;
	const { cwd, profile } = protection;
	const escalated = input.escalation === "unsandboxed";
	// An escalated launch is unrestricted by request; its parsed operations are
	// still complete evidence.
	const limitation =
		escalated && input.opaqueReason === "unrestricted_program"
			? undefined
			: input.opaqueReason;
	const incomplete = analysis.opaque || limitation !== undefined;
	if (
		(incomplete && profile === "full-access") ||
		(!incomplete && analysis.operations.length === 0)
	)
		throw new ReviewFailureError(
			"review_evidence_operation_incomplete",
			undefined,
			"shell_analysis",
		);
	const reviewedDirectory = input.reviewedDirectory;
	if (reviewedDirectory && !isWithin(workspace, reviewedDirectory))
		throw new ReviewFailureError(
			"review_evidence_scope",
			undefined,
			"reviewed_directory",
		);
	if (protection.root !== workspace || !isWithin(workspace, cwd))
		throw new ReviewFailureError(
			"review_evidence_scope",
			undefined,
			"working_directory",
		);
	const escapePattern = (value: string) =>
		value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const privateResources = [
		...new Set(
			[
				...runtimeReviewPrivatePaths(),
				...protection.protectedPaths,
				...(input.reviewPrivatePaths ?? []),
			].flatMap(lexicalAndCanonical),
		),
	];
	if (profile !== "full-access") {
		for (const root of protection.writeRoots) {
			if (
				root !== workspace &&
				privateResources.some(
					(resource) => isWithin(resource, root) || isWithin(root, resource),
				)
			) {
				throw new ReviewFailureError(
					"review_evidence_private_path",
					undefined,
					"write_scope",
				);
			}
		}
	}
	const reviewDirectories = [
		workspace,
		cwd,
		...(reviewedDirectory ? [reviewedDirectory] : []),
		// A conditional cd still supplies a possible base for private relative
		// operands, even though it cannot bind a historical authorization.
		...(input.opaqueReason === "unbound_working_directory"
			? analysis.operations.flatMap(({ argv: [name, operand] }) =>
					(name === "cd" || name === "pushd") &&
					operand &&
					!operand.startsWith("-")
						? lexicalAndCanonical(path.resolve(cwd, operand))
						: [],
				)
			: []),
	];
	for (const directory of reviewDirectories) {
		if (privateResources.some((resource) => isWithin(resource, directory)))
			throw new ReviewFailureError(
				"review_evidence_private_path",
				undefined,
				directory === reviewedDirectory
					? "reviewed_directory"
					: "working_directory",
			);
	}
	const home = homedir();
	const privateNames = new Set(
		privateResources
			.flatMap((resource) => [
				resource,
				...(isWithin(home, resource)
					? ["~", "$HOME", `\${HOME}`].map(
							(prefix) => `${prefix}/${path.relative(home, resource)}`,
						)
					: []),
				...reviewDirectories.flatMap((directory) => {
					const relative = path.relative(directory, resource);
					return relative && !relative.startsWith(`..${path.sep}`)
						? [relative, `.${path.sep}${relative}`]
						: [relative];
				}),
			])
			.filter(Boolean),
	);
	const privatePaths = [...privateNames].map(
		(name) =>
			new RegExp(
				`(?<![A-Za-z0-9_./\\\\-])${escapePattern(name.normalize("NFKC"))}(?=$|[^A-Za-z0-9_.-]|\\.(?=\\s|$))`,
				"iu",
			),
	);
	const containsReviewCredential = createReviewCredentialDetector();
	const isPrivatePath = (operand: string): boolean => {
		if (!operand || Buffer.byteLength(operand) > 4096) return false;
		const location = operand.replace(
			/^(?:~|\$HOME|\$\{HOME\})\//u,
			() => `${home}/`,
		);
		return reviewDirectories.some((directory) =>
			lexicalAndCanonical(path.resolve(directory, location)).some((target) =>
				privateResources.some((resource) => isWithin(resource, target)),
			),
		);
	};
	const privateOperand = (word: string): boolean => {
		const operand = word.startsWith("-")
			? (/^(?:--?[^=]+)=(.+)$/su.exec(word)?.[1] ??
				/^-[A-Za-z]((?:\/|~\/|\.\.?\/).+)$/su.exec(word)?.[1])
			: word;
		return operand !== undefined && isPrivatePath(operand);
	};
	const privateFileUrl = (url: URL): boolean => {
		if (url.protocol !== "file:") return false;
		try {
			return isPrivatePath(fileURLToPath(url));
		} catch {
			return false;
		}
	};
	const checkOperands = (
		operands: readonly string[],
		location: ReviewEvidenceLocation,
		credentialOperands = operands,
		position?: number,
	): void => {
		const credentialIndex = credentialOperands.findIndex(
			containsReviewCredential,
		);
		if (
			credentialIndex >= 0 ||
			(credentialOperands.length > 1 &&
				containsReviewCredential(credentialOperands.join(" ")))
		)
			throw new ReviewFailureError(
				"review_evidence_credential",
				undefined,
				location,
				location === "command_arguments" && credentialIndex >= 0
					? credentialIndex + 1
					: position,
			);
		const privateIndex = operands.findIndex(privateOperand);
		if (privateIndex >= 0)
			throw new ReviewFailureError(
				"review_evidence_private_path",
				undefined,
				location,
				location === "command_arguments" ? privateIndex + 1 : position,
			);
	};
	if (invocation.kind === "argv") {
		checkOperands([invocation.executable], "command_executable", []);
		checkOperands(invocation.args, "command_arguments");
	}
	for (const [index, { argv }] of analysis.operations.entries())
		checkOperands(argv, "parsed_operation", argv, index + 1);
	const checkedText = (
		value: string,
		location: ReviewEvidenceLocation,
		position?: number,
	): string => {
		const normalized = value.normalize("NFKC");
		const privateMatch = privatePaths
			.find((pattern) => pattern.test(normalized))
			?.exec(normalized);
		if (privateMatch || reviewUrlReferences(normalized).some(privateFileUrl))
			throw new ReviewFailureError(
				"review_evidence_private_path",
				undefined,
				location,
				location === "command_source" && privateMatch && normalized === value
					? privateMatch.index + 1
					: position,
			);
		if (containsReviewCredential(value))
			throw new ReviewFailureError(
				"review_evidence_credential",
				undefined,
				location,
				position,
			);
		if (/[\p{Cc}\p{Cf}]/u.test(normalized.replace(/[\t\r\n]/g, "")))
			throw new ReviewFailureError(
				"review_evidence_unsupported_characters",
				undefined,
				location,
				position,
			);
		return value;
	};
	const launch =
		invocation.kind === "argv"
			? {
					kind: "argv",
					executable: checkedText(invocation.executable, "command_executable"),
					args: invocation.args.map((arg, index) =>
						checkedText(arg, "command_arguments", index + 1),
					),
				}
			: {
					kind: "source",
					dialect: invocation.dialect,
					executable: checkedText(invocation.executable, "command_executable"),
					options: invocation.options.map((value) =>
						checkedText(value, "shell_options"),
					),
					source: checkedText(invocation.source, "command_source"),
				};
	const operations = analysis.operations.map(({ argv }, operationIndex) =>
		argv.map((arg) => checkedText(arg, "parsed_operation", operationIndex + 1)),
	);
	const relative = (p: string, location: ReviewEvidenceLocation) =>
		checkedText(path.relative(workspace, p) || ".", location);
	const operation = {
		provenance: "runtime.shell_analysis",
		invocation: launch,
		operations,
		coverage: incomplete ? "partial" : "parsed",
		...(limitation ? { limitation } : {}),
		compound: analysis.compound,
		cwd: relative(cwd, "working_directory"),
		profile,
		...(escalated ? { escalation: "unsandboxed_once" } : {}),
		...(reviewedDirectory
			? { reviewedDirectory: relative(reviewedDirectory, "reviewed_directory") }
			: {}),
		stdin: protection.stdin,
		network: profile === "full-access" ? "user_account" : "off",
		writeScope:
			profile === "full-access"
				? "user_account"
				: {
						workspaceRelativeRoots: protection.writeRoots.map((root) =>
							relative(root, "write_scope"),
						),
						privateScratch: true,
					},
		unknown: [
			...(incomplete
				? [
						"The operations list is incomplete. Evaluate the entire original invocation.",
					]
				: []),
			...(input.opaqueReason === "unbound_working_directory"
				? [
						"cwd is the launch directory. Later stages may use another working directory.",
					]
				: []),
			"Effects inside invoked programs are not observed before execution.",
		],
	};
	return {
		operation,
		invocation,
		checkOperands,
		checkedText,
		requiresHistory:
			!!input.reviewHistory && (profile !== "full-access" || escalated),
		profile,
		escalated,
	};
};

function requireSharingAllowed(
	value: string,
	location: ReviewEvidenceLocation,
) {
	if (
		sharingRestrictions.some((pattern) => pattern.test(value.normalize("NFKC")))
	)
		throw new ReviewFailureError(
			"review_evidence_sharing_restricted",
			undefined,
			location,
		);
}

export function validateRuleSuggestionEvidence(
	request: ApprovalRequest,
	workspace: string,
	words: readonly string[],
	intent?: ReviewIntent,
	history?: ConversationApprovalContext,
): boolean {
	const { operation, invocation, checkOperands, checkedText, requiresHistory } =
		prepareShellOperation(request, workspace);
	if (requiresHistory && !history) return false;
	for (const part of [
		...(intent
			? [
					intent.original,
					...intent.corrections,
					...(intent.earlierGoalSteers ?? []),
				]
			: []),
		...(history?.userMessages.map((message) => message.text) ?? []),
	]) {
		requireSharingAllowed(
			separateQuotedText(typeof part === "string" ? part : part.text).text,
			"user_intent",
		);
	}
	if (operation.profile === "full-access" || operation.coverage !== "parsed")
		return false;
	// Use the raw invocation, as exact-launch rules do. Policy analysis can
	// normalize a known executable to its basename for classification.
	const argv = singleCommandWords(invocation, analyzeShell(invocation));
	if (
		!argv ||
		argv.length !== words.length ||
		argv.some((word, index) => word !== words[index])
	)
		return false;
	checkOperands(argv, "parsed_operation", argv, 1);
	for (const word of argv) checkedText(word, "parsed_operation", 1);
	return true;
}

// Send decision-relevant text verbatim after checking credentials and private resources.
export const requireLocalShellEvidence = (
	request: ApprovalRequest,
	workspace: string,
	intent: ReviewIntent,
	history?: ConversationApprovalContext,
) => {
	const { operation, checkedText, requiresHistory, profile, escalated } =
		prepareShellOperation(request, workspace);
	if (requiresHistory && !history)
		throw new ReviewFailureError(
			"review_evidence_history_unavailable",
			undefined,
			"conversation_history",
		);
	const checkSharingRestriction = (
		value: string,
		location: ReviewEvidenceLocation,
	) => {
		requireSharingAllowed(value, location);
		return checkedText(value, location);
	};
	const userText = (
		part: ReviewUserText,
		location: "user_intent" | "user_correction" | "earlier_goal_steer",
	) => {
		const provenance = location === "user_intent" ? "run.start" : "run.steer";
		const original = typeof part === "string" ? part : part.text;
		const rawText = separateQuotedText(original);
		const text = checkSharingRestriction(rawText.text, location);
		if (!text.trim())
			throw new ReviewFailureError(
				"review_evidence_intent_unavailable",
				undefined,
				location,
			);
		return {
			provenance,
			text,
			...(rawText.quotedText
				? { quotedText: checkedText(rawText.quotedText, location) }
				: {}),
			...(typeof part === "object" ? { attachmentsOmitted: true } : {}),
		};
	};
	const userIntent = {
		...(intent.earlierGoalSteers?.length
			? {
					earlierGoalSteers: intent.earlierGoalSteers.map((part) =>
						userText(part, "earlier_goal_steer"),
					),
				}
			: {}),
		original: userText(intent.original, "user_intent"),
		corrections: intent.corrections.map((part) =>
			userText(part, "user_correction"),
		),
		...(history && (profile !== "full-access" || escalated)
			? {
					prior: {
						userMessages: history.userMessages.map((message) => {
							const { text, quotedText } = separateQuotedText(message.text);
							return {
								id: message.id,
								text: checkSharingRestriction(text, "historical_user_message"),
								...(quotedText
									? {
											quotedText: checkedText(
												quotedText,
												"historical_user_message",
											),
										}
									: {}),
							};
						}),
						...(history.proposal
							? {
									proposal: {
										id: history.proposal.id,
										text: checkedText(
											history.proposal.text,
											"historical_proposal",
										),
									},
								}
							: {}),
					},
				}
			: {}),
	};
	return { version: 2, operation, intent: userIntent };
};

export const buildLocalShellEvidence = (
	...args: Parameters<typeof requireLocalShellEvidence>
) => {
	try {
		return requireLocalShellEvidence(...args);
	} catch (error) {
		if (readReviewFailure(error)) return null;
		throw error;
	}
};

export const requestedReviewHistory = (request: ApprovalRequest) => {
	const input = parseShellRequest(request);
	if (
		(input.protection.profile === "full-access" &&
			input.escalation !== "unsandboxed") ||
		!input.reviewHistory
	)
		return undefined;
	if (
		input.opaqueReason === "unbound_working_directory" ||
		(input.analysis.opaque &&
			(!input.analysis.singleStage ||
				input.opaqueReason === "indirect_execution"))
	)
		throw new ReviewFailureError(
			"review_evidence_history_unavailable",
			undefined,
			"reviewed_directory",
		);
	return {
		references: input.reviewHistory,
		cwd: input.reviewedDirectory ?? input.protection.cwd,
	};
};
