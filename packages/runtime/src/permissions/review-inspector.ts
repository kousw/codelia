import {
	closeSync,
	constants,
	type Dirent,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type ApprovalRequest, parseApprovalReviewDecision } from "./dispatch";
import { fileIdentity } from "./launch-rules";
import { resourceContainsPath } from "./resource-paths";
import { ReviewFailureError } from "./review-failure";
import { reviewUrlReferences } from "./review-privacy";
import { directoryIdentity, isWithin } from "./shell-backend";

export const INSPECT_MAX_ROUNDS = 3;
export const INSPECT_MAX_REQUESTS_PER_ROUND = 4;
export const INSPECT_MAX_TOTAL_REQUESTS = 8;
export const INSPECT_MAX_FILE_READ_BYTES = 256 * 1024;
export const INSPECT_MAX_SNIPPET_BYTES = 4096;
export const INSPECT_MAX_SNIPPET_LINES = 120;
export const INSPECT_MAX_DIR_ENTRIES = 100;
export const INSPECT_MAX_GREP_FILES = 150;
export const INSPECT_MAX_GREP_FILE_BYTES = 128 * 1024;
export const INSPECT_MAX_GREP_MATCHES = 30;
export const INSPECT_MAX_TOTAL_DATA_BYTES = 16 * 1024;
export const INSPECT_MAX_PACKET_BYTES = 24 * 1024;

export const inspectRequestSchema = z.strictObject({
	kind: z.enum(["read_file", "list_dir", "grep"]),
	path: z.string(),
	start_line: z.number().int().nullable(),
	end_line: z.number().int().nullable(),
	pattern: z.string().nullable(),
});
export type InspectRequest = z.infer<typeof inspectRequestSchema>;

export const inspectableReviewDecisionSchema = z.strictObject({
	request_id: z.string(),
	decision: z.enum([
		"allow_once",
		"deny",
		"insufficient_evidence",
		"ask_user",
		"inspect",
	]),
	reason: z.string(),
	inspect_requests: z.array(inspectRequestSchema),
});
export type InspectableReviewDecision = z.infer<
	typeof inspectableReviewDecisionSchema
>;

export type InspectedBinding =
	| Readonly<{
			kind: "file";
			requestedPath: string;
			canonicalPath: string;
			identity: string;
	  }>
	| Readonly<{
			kind: "missing";
			requestedPath: string;
	  }>
	| Readonly<{
			kind: "dir";
			requestedPath: string;
			canonicalPath: string;
			identity: string;
	  }>;

export type ReviewInspectContext = Readonly<{
	workspace: string;
	cwd: string;
	privateResources: readonly string[];
	privatePathPatterns: readonly RegExp[];
	containsCredential: (value: string) => boolean;
	secretTokens?: readonly string[];
}>;

export type InspectResult = Readonly<Record<string, unknown>>;

const hasControlChars = (value: string): boolean =>
	/[\p{Cc}\p{Cf}]/u.test(value.normalize("NFKC").replace(/[\t\r\n]/g, ""));

const isPrivateTarget = (
	candidate: string,
	privateResources: readonly string[],
): boolean =>
	privateResources.some(
		(resource) =>
			resourceContainsPath(resource, candidate) ||
			isWithin(resource, candidate),
	);

const isPrivateFileUrl = (
	url: URL,
	privateResources: readonly string[],
): boolean => {
	if (url.protocol !== "file:") return false;
	try {
		return isPrivateTarget(fileURLToPath(url), privateResources);
	} catch {
		return true;
	}
};

const isSafeForReviewer = (
	value: string,
	ctx: ReviewInspectContext,
): boolean => {
	if (ctx.secretTokens?.some((token) => token && value.includes(token)))
		return false;
	const normalized = value.normalize("NFKC");
	if (ctx.containsCredential(value)) return false;
	if (ctx.privatePathPatterns.some((pattern) => pattern.test(normalized)))
		return false;
	if (
		reviewUrlReferences(normalized).some((url) =>
			isPrivateFileUrl(url, ctx.privateResources),
		)
	)
		return false;
	return true;
};

const sanitizeForReviewer = (
	value: string,
	ctx: ReviewInspectContext,
): string | undefined => {
	if (hasControlChars(value) || !isSafeForReviewer(value, ctx))
		return undefined;
	return value;
};

type ResolvedTarget =
	| {
			status: "ok";
			lexical: string;
			canonical: string;
			rel: string;
	  }
	| {
			status: "not_found";
			lexical: string;
			rel: string;
	  }
	| {
			status: "denied";
			code: "invalid_path" | "outside_workspace" | "withheld_privacy";
	  };

const resolveTarget = (
	rawPath: string,
	ctx: ReviewInspectContext,
): ResolvedTarget => {
	if (
		!rawPath ||
		rawPath.includes("\0") ||
		Buffer.byteLength(rawPath, "utf8") > 4096 ||
		hasControlChars(rawPath)
	)
		return { status: "denied", code: "invalid_path" };

	const candidates = [path.resolve(ctx.cwd, rawPath)];
	if (
		ctx.cwd !== ctx.workspace &&
		!path.isAbsolute(rawPath) &&
		!rawPath.startsWith(".")
	) {
		const workspaceCandidate = path.resolve(ctx.workspace, rawPath);
		if (workspaceCandidate !== candidates[0])
			candidates.push(workspaceCandidate);
	}

	let fallbackMissing: { lexical: string; rel: string } | undefined;
	for (const lexical of candidates) {
		if (!isWithin(ctx.workspace, lexical)) continue;
		if (isPrivateTarget(lexical, ctx.privateResources))
			return { status: "denied", code: "withheld_privacy" };
		try {
			const canonical = realpathSync(lexical);
			if (!isWithin(ctx.workspace, canonical))
				return { status: "denied", code: "outside_workspace" };
			if (isPrivateTarget(canonical, ctx.privateResources))
				return { status: "denied", code: "withheld_privacy" };
			return {
				status: "ok",
				lexical,
				canonical,
				rel: path.relative(ctx.workspace, canonical) || ".",
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				// Walk up to verify the nearest existing ancestor stays in workspace and non-private.
				let ancestor = path.dirname(lexical);
				let safeMissing = true;
				for (;;) {
					if (isPrivateTarget(ancestor, ctx.privateResources))
						return { status: "denied", code: "withheld_privacy" };
					try {
						const realAncestor = realpathSync(ancestor);
						if (!isWithin(ctx.workspace, realAncestor)) {
							safeMissing = false;
						} else if (isPrivateTarget(realAncestor, ctx.privateResources)) {
							return { status: "denied", code: "withheld_privacy" };
						}
						break;
					} catch (ancestorError) {
						if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") {
							safeMissing = false;
							break;
						}
						const parent = path.dirname(ancestor);
						if (parent === ancestor) {
							safeMissing = false;
							break;
						}
						ancestor = parent;
					}
				}
				if (safeMissing && !fallbackMissing) {
					fallbackMissing = {
						lexical,
						rel: path.relative(ctx.workspace, lexical) || ".",
					};
				}
				continue;
			}
			return { status: "denied", code: "invalid_path" };
		}
	}
	if (fallbackMissing) return { status: "not_found", ...fallbackMissing };
	return { status: "denied", code: "outside_workspace" };
};

const readBoundedUtf8File = (
	canonicalPath: string,
	maxBytes: number,
):
	| { status: "ok"; text: string; truncatedBySize: boolean; identity: string }
	| { status: "not_regular" | "binary" | "unreadable" } => {
	let fd: number;
	try {
		fd = openSync(
			canonicalPath,
			constants.O_RDONLY |
				(constants.O_NOFOLLOW ?? 0) |
				(constants.O_NONBLOCK ?? 0),
		);
	} catch {
		return { status: "unreadable" };
	}
	try {
		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile()) return { status: "not_regular" };
		const toRead = Number(
			before.size > BigInt(maxBytes) ? BigInt(maxBytes) : before.size,
		);
		const buffer = Buffer.alloc(toRead);
		let offset = 0;
		while (offset < toRead) {
			const n = readSync(fd, buffer, offset, toRead - offset, offset);
			if (n === 0) break;
			offset += n;
		}
		const slice = buffer.subarray(0, offset);
		if (slice.includes(0)) return { status: "binary" };
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
		} catch {
			return { status: "binary" };
		}
		const after = fstatSync(fd, { bigint: true });
		if (
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			after.size !== before.size ||
			after.mtimeNs !== before.mtimeNs ||
			after.ctimeNs !== before.ctimeNs
		)
			return { status: "unreadable" };
		return {
			status: "ok",
			text,
			truncatedBySize: before.size > BigInt(maxBytes),
			identity: fileIdentity(canonicalPath),
		};
	} catch {
		return { status: "unreadable" };
	} finally {
		closeSync(fd);
	}
};

const clipUtf8 = (
	text: string,
	maxBytes: number,
): { text: string; clipped: boolean } => {
	if (Buffer.byteLength(text, "utf8") <= maxBytes)
		return { text, clipped: false };
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes)
		end -= Math.max(1, Math.floor((end - maxBytes / 2) / 2));
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes)
		end--;
	return { text: text.slice(0, end), clipped: true };
};

const executeReadFile = (
	request: InspectRequest,
	ctx: ReviewInspectContext,
	bindings: Map<string, InspectedBinding>,
): InspectResult => {
	const resolved = resolveTarget(request.path, ctx);
	if (resolved.status === "denied")
		return { kind: "read_file", path: request.path, status: resolved.code };
	if (resolved.status === "not_found") {
		bindings.set(`missing:${resolved.lexical}`, {
			kind: "missing",
			requestedPath: resolved.lexical,
		});
		return { kind: "read_file", path: resolved.rel, status: "not_found" };
	}
	const loaded = readBoundedUtf8File(
		resolved.canonical,
		INSPECT_MAX_FILE_READ_BYTES,
	);
	if (loaded.status !== "ok") {
		return { kind: "read_file", path: resolved.rel, status: loaded.status };
	}
	bindings.set(`file:${resolved.lexical}`, {
		kind: "file",
		requestedPath: resolved.lexical,
		canonicalPath: resolved.canonical,
		identity: loaded.identity,
	});
	const lines = loaded.text.split(/\r?\n/u);
	const start = Math.max(1, request.start_line ?? 1);
	const maxEnd = Math.min(lines.length, start + INSPECT_MAX_SNIPPET_LINES - 1);
	const requestedEnd =
		request.end_line !== null && request.end_line >= start
			? Math.min(request.end_line, maxEnd)
			: maxEnd;
	const selected = lines.slice(start - 1, requestedEnd);
	const numbered = selected
		.map((line, idx) => `${start + idx}: ${line}`)
		.join("\n");
	const { text: clipped, clipped: byteTruncated } = clipUtf8(
		numbered,
		INSPECT_MAX_SNIPPET_BYTES,
	);
	const safe = sanitizeForReviewer(clipped, ctx);
	if (safe === undefined) {
		return {
			kind: "read_file",
			path: resolved.rel,
			status: "withheld_privacy",
			reason: "content_withheld_for_privacy",
		};
	}
	return {
		kind: "read_file",
		path: resolved.rel,
		status: "ok",
		provenance: "workspace_file_untrusted_data",
		start_line: start,
		end_line: Math.min(requestedEnd, lines.length),
		total_lines: lines.length,
		truncated:
			loaded.truncatedBySize || requestedEnd < lines.length || byteTruncated,
		content: safe,
	};
};

const executeListDir = (
	request: InspectRequest,
	ctx: ReviewInspectContext,
	bindings: Map<string, InspectedBinding>,
): InspectResult => {
	const resolved = resolveTarget(request.path || ".", ctx);
	if (resolved.status === "denied")
		return { kind: "list_dir", path: request.path, status: resolved.code };
	if (resolved.status === "not_found") {
		bindings.set(`missing:${resolved.lexical}`, {
			kind: "missing",
			requestedPath: resolved.lexical,
		});
		return { kind: "list_dir", path: resolved.rel, status: "not_found" };
	}
	try {
		const stat = lstatSync(resolved.canonical);
		if (!stat.isDirectory())
			return { kind: "list_dir", path: resolved.rel, status: "not_directory" };
		const identity = directoryIdentity(resolved.canonical);
		bindings.set(`dir:${resolved.lexical}`, {
			kind: "dir",
			requestedPath: resolved.lexical,
			canonicalPath: resolved.canonical,
			identity,
		});
		const entries = readdirSync(resolved.canonical, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name))
			.filter((entry) => {
				const childPath = path.join(resolved.canonical, entry.name);
				if (isPrivateTarget(childPath, ctx.privateResources)) return false;
				return sanitizeForReviewer(entry.name, ctx) !== undefined;
			});
		const limited = entries.slice(0, INSPECT_MAX_DIR_ENTRIES).map((entry) => ({
			name: entry.name,
			type: entry.isDirectory()
				? "dir"
				: entry.isFile()
					? "file"
					: entry.isSymbolicLink()
						? "symlink"
						: "other",
		}));
		return {
			kind: "list_dir",
			path: resolved.rel,
			status: "ok",
			provenance: "workspace_dir_untrusted_data",
			entries: limited,
			truncated: entries.length > INSPECT_MAX_DIR_ENTRIES,
		};
	} catch {
		return { kind: "list_dir", path: resolved.rel, status: "unreadable" };
	}
};

const SKIPPED_GREP_DIRS = new Set([".git", "node_modules", ".codelia"]);

const executeGrep = (
	request: InspectRequest,
	ctx: ReviewInspectContext,
	bindings: Map<string, InspectedBinding>,
): InspectResult => {
	const pattern = request.pattern;
	if (
		!pattern ||
		pattern.length > 200 ||
		sanitizeForReviewer(pattern, ctx) === undefined
	)
		return {
			kind: "grep",
			path: request.path,
			status: "invalid_pattern",
		};
	const resolved = resolveTarget(request.path || ".", ctx);
	if (resolved.status === "denied")
		return { kind: "grep", path: request.path, status: resolved.code };
	if (resolved.status === "not_found") {
		bindings.set(`missing:${resolved.lexical}`, {
			kind: "missing",
			requestedPath: resolved.lexical,
		});
		return { kind: "grep", path: resolved.rel, status: "not_found" };
	}
	const needle = pattern.toLowerCase();
	const matches: Array<{ path: string; line: number; text: string }> = [];
	let matchBytes = 0;
	let filesScanned = 0;
	let withheldFiles = 0;
	let truncated = false;

	const scanFile = (lexicalFile: string, canonicalFile: string) => {
		if (filesScanned >= INSPECT_MAX_GREP_FILES) {
			truncated = true;
			return;
		}
		filesScanned++;
		const loaded = readBoundedUtf8File(
			canonicalFile,
			INSPECT_MAX_GREP_FILE_BYTES,
		);
		if (loaded.status !== "ok") return;
		const relFile = path.relative(ctx.workspace, canonicalFile) || ".";
		const lines = loaded.text.split(/\r?\n/u);
		const fileMatches: Array<{ path: string; line: number; text: string }> = [];
		for (let idx = 0; idx < lines.length; idx++) {
			const line = lines[idx];
			if (!line.toLowerCase().includes(needle)) continue;
			const clipped = clipUtf8(line.trim(), 240).text;
			if (sanitizeForReviewer(clipped, ctx) === undefined) {
				withheldFiles++;
				return;
			}
			fileMatches.push({ path: relFile, line: idx + 1, text: clipped });
			if (matches.length + fileMatches.length >= INSPECT_MAX_GREP_MATCHES) {
				truncated = true;
				break;
			}
		}
		if (fileMatches.length === 0) return;
		for (const item of fileMatches) {
			const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
			if (matchBytes + itemBytes > INSPECT_MAX_SNIPPET_BYTES) {
				truncated = true;
				break;
			}
			matches.push(item);
			matchBytes += itemBytes;
		}
		bindings.set(`file:${lexicalFile}`, {
			kind: "file",
			requestedPath: lexicalFile,
			canonicalPath: canonicalFile,
			identity: loaded.identity,
		});
	};

	try {
		const rootStat = lstatSync(resolved.canonical);
		if (rootStat.isFile()) {
			scanFile(resolved.lexical, resolved.canonical);
		} else if (rootStat.isDirectory()) {
			const queue: string[] = [resolved.canonical];
			while (
				queue.length > 0 &&
				filesScanned < INSPECT_MAX_GREP_FILES &&
				matches.length < INSPECT_MAX_GREP_MATCHES
			) {
				const dir = queue.shift() as string;
				let entries: Dirent[];
				try {
					entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
						a.name.localeCompare(b.name),
					);
				} catch {
					continue;
				}
				for (const entry of entries) {
					if (entry.isSymbolicLink()) continue;
					const child = path.join(dir, entry.name);
					if (isPrivateTarget(child, ctx.privateResources)) continue;
					if (entry.isDirectory()) {
						if (!SKIPPED_GREP_DIRS.has(entry.name)) queue.push(child);
					} else if (entry.isFile()) {
						scanFile(child, child);
						if (
							filesScanned >= INSPECT_MAX_GREP_FILES ||
							matches.length >= INSPECT_MAX_GREP_MATCHES ||
							matchBytes >= INSPECT_MAX_SNIPPET_BYTES
						) {
							truncated = true;
							break;
						}
					}
				}
			}
		} else {
			return { kind: "grep", path: resolved.rel, status: "unreadable" };
		}
	} catch {
		return { kind: "grep", path: resolved.rel, status: "unreadable" };
	}

	return {
		kind: "grep",
		path: resolved.rel,
		pattern,
		status: "ok",
		provenance: "workspace_grep_untrusted_data",
		matches,
		...(withheldFiles > 0 ? { withheld_files: withheldFiles } : {}),
		truncated,
	};
};

export const executeReviewInspection = (
	request: InspectRequest,
	ctx: ReviewInspectContext,
	bindings: Map<string, InspectedBinding>,
): InspectResult => {
	switch (request.kind) {
		case "read_file":
			return executeReadFile(request, ctx, bindings);
		case "list_dir":
			return executeListDir(request, ctx, bindings);
		case "grep":
			return executeGrep(request, ctx, bindings);
	}
};

export const verifyInspectedBindings = (
	bindings: readonly InspectedBinding[],
): boolean => {
	try {
		for (const binding of bindings) {
			if (binding.kind === "missing") {
				if (lstatSync(binding.requestedPath, { throwIfNoEntry: false }))
					return false;
			} else if (binding.kind === "file") {
				if (
					realpathSync(binding.requestedPath) !== binding.canonicalPath ||
					fileIdentity(binding.canonicalPath) !== binding.identity
				)
					return false;
			} else if (binding.kind === "dir") {
				if (
					realpathSync(binding.requestedPath) !== binding.canonicalPath ||
					directoryIdentity(binding.canonicalPath) !== binding.identity
				)
					return false;
			}
		}
		return true;
	} catch {
		return false;
	}
};

export type InspectReviewStepRunner = (
	packet: string,
	allowInspect: boolean,
	signal: AbortSignal,
) => Promise<unknown>;

/**
 * Run a bounded read-only inspection loop for Auto Review.
 *
 * Rounds `0..INSPECT_MAX_ROUNDS-2` accept `decision: "inspect"` with up to
 * `INSPECT_MAX_REQUESTS_PER_ROUND` read-only workspace requests. The final
 * round forces a standard terminal decision (`allow_once`, `deny`,
 * `insufficient_evidence`, `ask_user`). Every inspected file/directory is
 * recorded in `bindings` for synchronous TOCTOU re-verification before launch.
 */
export const runInspectableApprovalReview = async ({
	request,
	initialPacket,
	ctx,
	signal,
	stillCurrent,
	runStep,
	maxRounds = INSPECT_MAX_ROUNDS,
}: {
	request: ApprovalRequest;
	initialPacket: string;
	ctx: ReviewInspectContext;
	signal: AbortSignal;
	stillCurrent: () => boolean;
	runStep: InspectReviewStepRunner;
	maxRounds?: number;
}): Promise<{
	decision: unknown;
	bindings: readonly InspectedBinding[];
}> => {
	const bindings = new Map<string, InspectedBinding>();
	const baseEvidence = JSON.parse(initialPacket) as Record<string, unknown>;
	const inspectedData: InspectResult[] = [];
	let totalDataBytes = 0;
	let totalInspections = 0;
	let currentPacket = initialPacket;

	for (let round = 0; round < maxRounds; round++) {
		if (signal.aborted || !stillCurrent())
			return { decision: null, bindings: [...bindings.values()] };
		const allowInspect =
			round < maxRounds - 1 &&
			totalInspections < INSPECT_MAX_TOTAL_REQUESTS &&
			totalDataBytes < INSPECT_MAX_TOTAL_DATA_BYTES;
		const reply = await runStep(currentPacket, allowInspect, signal);
		if (signal.aborted || !stillCurrent())
			return { decision: null, bindings: [...bindings.values()] };
		if (!allowInspect) {
			return {
				decision: parseApprovalReviewDecision(reply, request.id) ? reply : null,
				bindings: [...bindings.values()],
			};
		}
		const parsed = inspectableReviewDecisionSchema.safeParse(reply);
		const data = parsed.success
			? parsed.data
			: parseApprovalReviewDecision(reply, request.id)
				? {
						...(reply as {
							request_id: string;
							decision:
								| "allow_once"
								| "deny"
								| "insufficient_evidence"
								| "ask_user";
							reason: string;
						}),
						inspect_requests: [] as InspectRequest[],
					}
				: null;
		if (!data) return { decision: null, bindings: [...bindings.values()] };
		if (
			data.request_id !== request.id ||
			!data.reason.trim() ||
			data.reason.length > 512
		)
			return { decision: null, bindings: [...bindings.values()] };
		if (data.decision !== "inspect") {
			// Reject contradictory responses that both conclude and request inspection.
			if (data.inspect_requests.length > 0)
				return { decision: null, bindings: [...bindings.values()] };
			return {
				decision: {
					request_id: data.request_id,
					decision: data.decision,
					reason: data.reason,
				},
				bindings: [...bindings.values()],
			};
		}
		if (
			data.inspect_requests.length === 0 ||
			data.inspect_requests.length > INSPECT_MAX_REQUESTS_PER_ROUND ||
			totalInspections + data.inspect_requests.length >
				INSPECT_MAX_TOTAL_REQUESTS
		)
			return { decision: null, bindings: [...bindings.values()] };

		for (const inspectReq of data.inspect_requests) {
			if (signal.aborted || !stillCurrent())
				return { decision: null, bindings: [...bindings.values()] };
			const result = executeReviewInspection(inspectReq, ctx, bindings);
			const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
			if (totalDataBytes + resultBytes > INSPECT_MAX_TOTAL_DATA_BYTES) {
				inspectedData.push({
					kind: inspectReq.kind,
					path: inspectReq.path,
					status: "budget_exceeded",
				});
				break;
			}
			inspectedData.push(result);
			totalDataBytes += resultBytes;
			totalInspections++;
		}
		const nextPacket = JSON.stringify({
			...baseEvidence,
			inspection_round: round + 1,
			inspected_data_untrusted: inspectedData,
		});
		if (
			Buffer.byteLength(nextPacket, "utf8") > INSPECT_MAX_PACKET_BYTES ||
			!isSafeForReviewer(nextPacket, ctx)
		) {
			throw new ReviewFailureError(
				"review_evidence_credential",
				undefined,
				"reviewer_packet",
			);
		}
		currentPacket = nextPacket;
	}
	return { decision: null, bindings: [...bindings.values()] };
};
