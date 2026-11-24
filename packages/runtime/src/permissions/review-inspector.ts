import { createHash } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	type Dirent,
	fstatSync,
	lstatSync,
	opendirSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type ApprovalRequest, parseApprovalReviewDecision } from "./dispatch";
import { fileIdentity } from "./launch-rules";
import { isProtectedAlias } from "./protected-aliases";
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
export const INSPECT_MAX_RAW_DIR_ENTRIES = 500;
export const INSPECT_MAX_GREP_FILES = 150;
export const INSPECT_MAX_GREP_DIRS = 100;
export const INSPECT_MAX_GREP_ENTRIES = 1000;
export const INSPECT_MAX_GREP_FILE_BYTES = 128 * 1024;
export const INSPECT_MAX_GREP_MATCHES = 30;
export const INSPECT_MAX_TOTAL_DATA_BYTES = 14 * 1024;
export const INSPECT_MAX_PACKET_BYTES = 24 * 1024;
const YIELD_BATCH = 25;

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
			fullyRead?: boolean;
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
			entriesDigest: string;
			maxEntries: number;
	  }>;

export type ReviewInspectContext = Readonly<{
	workspace: string;
	workspaceIdentity: string;
	cwd: string;
	privateResources: readonly string[];
	privatePathPatterns: readonly RegExp[];
	containsCredential: (value: string) => boolean;
	secretTokens?: readonly string[];
	/** Canonical paths of directly invoked workspace-local executables that must be fully inspected before allow_once. */
	requiredInspectPaths?: readonly string[];
}>;

export type InspectResult = Readonly<Record<string, unknown>>;

const statIdentity = (stat: BigIntStats): string =>
	`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

const hasDisallowedControls = (value: string): boolean =>
	/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(
		value.normalize("NFKC").replace(/[\t\r\n]/g, ""),
	);

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
	if (hasDisallowedControls(value) || !isSafeForReviewer(value, ctx))
		return undefined;
	return value;
};

const safeEchoPath = (rawPath: string, ctx: ReviewInspectContext): string =>
	sanitizeForReviewer(rawPath, ctx) ?? "[redacted]";

const workspaceStillPinned = (ctx: ReviewInspectContext): boolean => {
	try {
		return (
			realpathSync(ctx.workspace) === ctx.workspace &&
			directoryIdentity(ctx.workspace) === ctx.workspaceIdentity
		);
	} catch {
		return false;
	}
};

const recordBinding = (
	bindings: Map<string, InspectedBinding>,
	key: string,
	next: InspectedBinding,
): boolean => {
	const existing = bindings.get(key);
	if (!existing) {
		bindings.set(key, next);
		return true;
	}
	if (existing.kind !== next.kind) return false;
	if (existing.kind === "file" && next.kind === "file") {
		if (
			existing.canonicalPath !== next.canonicalPath ||
			existing.identity !== next.identity
		)
			return false;
		if (next.fullyRead && !existing.fullyRead) {
			bindings.set(key, { ...existing, fullyRead: true });
		}
		return true;
	}
	if (existing.kind === "dir" && next.kind === "dir") {
		if (
			existing.canonicalPath !== next.canonicalPath ||
			existing.identity !== next.identity ||
			existing.entriesDigest !== next.entriesDigest
		)
			return false;
		return true;
	}
	return existing.requestedPath === next.requestedPath;
};

const readBoundedDirEntries = (
	directory: string,
	maxRaw: number,
): { entries: Dirent[]; truncatedRaw: boolean; digest: string } => {
	const dir = opendirSync(directory);
	const collected: Dirent[] = [];
	let truncatedRaw = false;
	try {
		for (;;) {
			const entry = dir.readSync();
			if (!entry) break;
			if (collected.length >= maxRaw) {
				truncatedRaw = true;
				break;
			}
			collected.push(entry);
		}
	} finally {
		dir.closeSync();
	}
	collected.sort((a, b) => a.name.localeCompare(b.name));
	const hash = createHash("sha256");
	hash.update(truncatedRaw ? "truncated\0" : "full\0");
	for (const entry of collected) {
		const kind = entry.isDirectory()
			? "d"
			: entry.isFile()
				? "f"
				: entry.isSymbolicLink()
					? "l"
					: "o";
		hash.update(`${kind}:${entry.name}\0`);
	}
	return { entries: collected, truncatedRaw, digest: hash.digest("hex") };
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
			code:
				| "invalid_path"
				| "outside_workspace"
				| "withheld_privacy"
				| "dangling_symlink";
	  };

const resolveTarget = (
	rawPath: string,
	ctx: ReviewInspectContext,
): ResolvedTarget => {
	if (
		!rawPath ||
		rawPath.includes("\0") ||
		Buffer.byteLength(rawPath, "utf8") > 4096 ||
		hasDisallowedControls(rawPath) ||
		!workspaceStillPinned(ctx)
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
				// Distinguish a dangling symlink from an ordinary missing path.
				if (lstatSync(lexical, { throwIfNoEntry: false })?.isSymbolicLink())
					return { status: "denied", code: "dangling_symlink" };
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
						if (
							lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()
						)
							return { status: "denied", code: "dangling_symlink" };
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

/** Trim up to 3 trailing incomplete UTF-8 continuation bytes when a read was cut by byte cap. */
const trimIncompleteUtf8Tail = (slice: Buffer): Buffer => {
	let end = slice.length;
	let back = 0;
	while (end > 0 && back < 4 && (slice[end - 1] & 0xc0) === 0x80) {
		end--;
		back++;
	}
	if (end === 0) return slice;
	const lead = slice[end - 1];
	const expectedLen =
		lead < 0x80
			? 1
			: (lead & 0xe0) === 0xc0
				? 2
				: (lead & 0xf0) === 0xe0
					? 3
					: (lead & 0xf8) === 0xf0
						? 4
						: 1;
	const actualLen = slice.length - (end - 1);
	return actualLen < expectedLen ? slice.subarray(0, end - 1) : slice;
};

const readBoundedUtf8File = (
	lexicalPath: string,
	canonicalPath: string,
	maxBytes: number,
	ctx: ReviewInspectContext,
):
	| { status: "ok"; text: string; truncatedBySize: boolean; identity: string }
	| {
			status: "not_regular" | "binary" | "unreadable" | "withheld_privacy";
	  } => {
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
		// Verify no concurrent ancestor swap redirected openSync outside workspace,
		// and verify hard-link aliases cannot expose a protected inode.
		if (!workspaceStillPinned(ctx)) return { status: "unreadable" };
		const recheckedCanonical = realpathSync(lexicalPath);
		if (
			recheckedCanonical !== canonicalPath ||
			!isWithin(ctx.workspace, recheckedCanonical)
		)
			return { status: "unreadable" };
		const pathStat = lstatSync(canonicalPath, { bigint: true });
		if (pathStat.dev !== before.dev || pathStat.ino !== before.ino)
			return { status: "unreadable" };
		if (before.nlink > 1n) {
			try {
				if (isProtectedAlias(before, ctx.privateResources))
					return { status: "withheld_privacy" };
			} catch {
				// Fail closed if the private alias index cannot be built.
				return { status: "withheld_privacy" };
			}
		}
		const truncatedBySize = before.size > BigInt(maxBytes);
		const toRead = Number(truncatedBySize ? BigInt(maxBytes) : before.size);
		const buffer = Buffer.alloc(toRead);
		let offset = 0;
		while (offset < toRead) {
			const n = readSync(fd, buffer, offset, toRead - offset, offset);
			if (n === 0) break;
			offset += n;
		}
		const rawSlice = buffer.subarray(0, offset);
		if (rawSlice.includes(0)) return { status: "binary" };
		const decodable = truncatedBySize
			? trimIncompleteUtf8Tail(rawSlice)
			: rawSlice;
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(decodable);
		} catch {
			return { status: "binary" };
		}
		if (text.startsWith("\uFEFF")) text = text.slice(1);
		const after = fstatSync(fd, { bigint: true });
		if (statIdentity(after) !== statIdentity(before))
			return { status: "unreadable" };
		if (
			!workspaceStillPinned(ctx) ||
			realpathSync(lexicalPath) !== canonicalPath
		)
			return { status: "unreadable" };
		return {
			status: "ok",
			text,
			truncatedBySize,
			identity: statIdentity(before),
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

const yieldEventLoop = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

const executeReadFile = (
	request: InspectRequest,
	ctx: ReviewInspectContext,
	bindings: Map<string, InspectedBinding>,
): { result: InspectResult; conflict: boolean } => {
	const resolved = resolveTarget(request.path, ctx);
	if (resolved.status === "denied")
		return {
			result: {
				kind: "read_file",
				path: safeEchoPath(request.path, ctx),
				status: resolved.code,
			},
			conflict: false,
		};
	if (resolved.status === "not_found") {
		const ok = recordBinding(bindings, `missing:${resolved.lexical}`, {
			kind: "missing",
			requestedPath: resolved.lexical,
		});
		return {
			result: { kind: "read_file", path: resolved.rel, status: "not_found" },
			conflict: !ok,
		};
	}
	const loaded = readBoundedUtf8File(
		resolved.lexical,
		resolved.canonical,
		INSPECT_MAX_FILE_READ_BYTES,
		ctx,
	);
	if (loaded.status !== "ok") {
		return {
			result: {
				kind: "read_file",
				path: resolved.rel,
				status: loaded.status,
			},
			conflict: false,
		};
	}
	const rawLines = loaded.text.split(/\r?\n/u);
	// Drop an incomplete trailing line when the read hit INSPECT_MAX_FILE_READ_BYTES
	// so credential scanning never sees a half-cut token at the boundary.
	const completeLines = loaded.truncatedBySize
		? rawLines.slice(0, -1)
		: rawLines;
	const start = Math.max(1, request.start_line ?? 1);
	const maxEnd = Math.min(
		completeLines.length,
		start + INSPECT_MAX_SNIPPET_LINES - 1,
	);
	const requestedEnd =
		request.end_line !== null && request.end_line >= start
			? Math.min(request.end_line, maxEnd)
			: maxEnd;
	const selected = completeLines.slice(start - 1, requestedEnd);

	// Check raw unclipped lines for credentials/privacy BEFORE formatting/clipping
	// so a credential spanning the clip boundary cannot leak a partial prefix.
	const rawSelectedText = selected.join("\n");
	if (sanitizeForReviewer(rawSelectedText, ctx) === undefined) {
		const ok = recordBinding(bindings, `file:${resolved.lexical}`, {
			kind: "file",
			requestedPath: resolved.lexical,
			canonicalPath: resolved.canonical,
			identity: loaded.identity,
		});
		return {
			result: {
				kind: "read_file",
				path: resolved.rel,
				status: "withheld_privacy",
				reason: "content_withheld_for_privacy",
			},
			conflict: !ok,
		};
	}

	const numbered = selected
		.map((line, idx) => `${start + idx}: ${line}`)
		.join("\n");
	const { text: clipped, clipped: byteTruncated } = clipUtf8(
		numbered,
		INSPECT_MAX_SNIPPET_BYTES,
	);
	const truncated =
		loaded.truncatedBySize ||
		start > 1 ||
		requestedEnd < completeLines.length ||
		byteTruncated;
	const ok = recordBinding(bindings, `file:${resolved.lexical}`, {
		kind: "file",
		requestedPath: resolved.lexical,
		canonicalPath: resolved.canonical,
		identity: loaded.identity,
		fullyRead: !truncated,
	});
	return {
		result: {
			kind: "read_file",
			path: resolved.rel,
			status: "ok",
			provenance: "workspace_file_untrusted_data",
			start_line: start,
			end_line: Math.min(requestedEnd, completeLines.length),
			total_lines: completeLines.length,
			truncated,
			content: clipped,
		},
		conflict: !ok,
	};
};

const executeListDir = (
	request: InspectRequest,
	ctx: ReviewInspectContext,
	bindings: Map<string, InspectedBinding>,
): { result: InspectResult; conflict: boolean } => {
	const resolved = resolveTarget(request.path || ".", ctx);
	if (resolved.status === "denied")
		return {
			result: {
				kind: "list_dir",
				path: safeEchoPath(request.path, ctx),
				status: resolved.code,
			},
			conflict: false,
		};
	if (resolved.status === "not_found") {
		const ok = recordBinding(bindings, `missing:${resolved.lexical}`, {
			kind: "missing",
			requestedPath: resolved.lexical,
		});
		return {
			result: { kind: "list_dir", path: resolved.rel, status: "not_found" },
			conflict: !ok,
		};
	}
	try {
		const stat = lstatSync(resolved.canonical);
		if (!stat.isDirectory())
			return {
				result: {
					kind: "list_dir",
					path: resolved.rel,
					status: "not_directory",
				},
				conflict: false,
			};
		const identity = directoryIdentity(resolved.canonical);
		const { entries, truncatedRaw, digest } = readBoundedDirEntries(
			resolved.canonical,
			INSPECT_MAX_RAW_DIR_ENTRIES,
		);
		if (
			!workspaceStillPinned(ctx) ||
			realpathSync(resolved.lexical) !== resolved.canonical ||
			directoryIdentity(resolved.canonical) !== identity
		) {
			return {
				result: { kind: "list_dir", path: resolved.rel, status: "unreadable" },
				conflict: true,
			};
		}
		const ok = recordBinding(bindings, `dir:${resolved.lexical}`, {
			kind: "dir",
			requestedPath: resolved.lexical,
			canonicalPath: resolved.canonical,
			identity,
			entriesDigest: digest,
			maxEntries: INSPECT_MAX_RAW_DIR_ENTRIES,
		});
		const visible = entries.filter((entry) => {
			const childPath = path.join(resolved.canonical, entry.name);
			if (isPrivateTarget(childPath, ctx.privateResources)) return false;
			return sanitizeForReviewer(entry.name, ctx) !== undefined;
		});
		const limited = visible.slice(0, INSPECT_MAX_DIR_ENTRIES).map((entry) => ({
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
			result: {
				kind: "list_dir",
				path: resolved.rel,
				status: "ok",
				provenance: "workspace_dir_untrusted_data",
				entries: limited,
				truncated: truncatedRaw || visible.length > INSPECT_MAX_DIR_ENTRIES,
			},
			conflict: !ok,
		};
	} catch {
		return {
			result: { kind: "list_dir", path: resolved.rel, status: "unreadable" },
			conflict: false,
		};
	}
};

const SKIPPED_GREP_DIRS = new Set([".git", "node_modules", ".codelia"]);

const executeGrep = async (
	request: InspectRequest,
	ctx: ReviewInspectContext,
	bindings: Map<string, InspectedBinding>,
	signal: AbortSignal,
): Promise<{ result: InspectResult; conflict: boolean }> => {
	const pattern = request.pattern;
	if (
		!pattern ||
		pattern.length > 200 ||
		sanitizeForReviewer(pattern, ctx) === undefined
	)
		return {
			result: {
				kind: "grep",
				path: safeEchoPath(request.path, ctx),
				status: "invalid_pattern",
			},
			conflict: false,
		};
	const resolved = resolveTarget(request.path || ".", ctx);
	if (resolved.status === "denied")
		return {
			result: {
				kind: "grep",
				path: safeEchoPath(request.path, ctx),
				status: resolved.code,
			},
			conflict: false,
		};
	if (resolved.status === "not_found") {
		const ok = recordBinding(bindings, `missing:${resolved.lexical}`, {
			kind: "missing",
			requestedPath: resolved.lexical,
		});
		return {
			result: { kind: "grep", path: resolved.rel, status: "not_found" },
			conflict: !ok,
		};
	}
	const needle = pattern.toLowerCase();
	const matches: Array<{
		path: string;
		line: number;
		text: string;
		line_truncated?: true;
	}> = [];
	let matchBytes = 0;
	let filesScanned = 0;
	let dirsScanned = 0;
	let entriesVisited = 0;
	let withheldFiles = 0;
	let truncated = false;
	let conflict = false;

	const scanFile = (lexicalFile: string, canonicalFile: string) => {
		if (filesScanned >= INSPECT_MAX_GREP_FILES) {
			truncated = true;
			return;
		}
		filesScanned++;
		const loaded = readBoundedUtf8File(
			lexicalFile,
			canonicalFile,
			INSPECT_MAX_GREP_FILE_BYTES,
			ctx,
		);
		if (loaded.status === "withheld_privacy") {
			withheldFiles++;
			return;
		}
		if (loaded.status !== "ok") return;
		// Bind EVERY scanned file (including non-matching files) so adding a match
		// to a previously clean file before launch invalidates approval.
		if (
			!recordBinding(bindings, `file:${lexicalFile}`, {
				kind: "file",
				requestedPath: lexicalFile,
				canonicalPath: canonicalFile,
				identity: loaded.identity,
			})
		) {
			conflict = true;
			return;
		}
		const relFile = path.relative(ctx.workspace, canonicalFile) || ".";
		const rawLines = loaded.text.split(/\r?\n/u);
		const lines = loaded.truncatedBySize ? rawLines.slice(0, -1) : rawLines;
		if (loaded.truncatedBySize) truncated = true;
		const fileMatches: Array<{
			path: string;
			line: number;
			text: string;
			line_truncated?: true;
		}> = [];
		for (let idx = 0; idx < lines.length; idx++) {
			const rawLine = lines[idx];
			if (!rawLine.toLowerCase().includes(needle)) continue;
			// Check the full raw line BEFORE clipping so boundary tokens cannot leak.
			if (sanitizeForReviewer(rawLine, ctx) === undefined) {
				withheldFiles++;
				return;
			}
			const trimmed = rawLine.trim();
			const { text: clipped, clipped: lineTruncated } = clipUtf8(trimmed, 240);
			fileMatches.push({
				path: relFile,
				line: idx + 1,
				text: clipped,
				...(lineTruncated ? { line_truncated: true } : {}),
			});
			if (matches.length + fileMatches.length >= INSPECT_MAX_GREP_MATCHES) {
				truncated = true;
				break;
			}
		}
		for (const item of fileMatches) {
			const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
			if (matchBytes + itemBytes > INSPECT_MAX_SNIPPET_BYTES) {
				truncated = true;
				break;
			}
			matches.push(item);
			matchBytes += itemBytes;
		}
	};

	try {
		const rootStat = lstatSync(resolved.canonical);
		if (rootStat.isFile()) {
			scanFile(resolved.lexical, resolved.canonical);
		} else if (rootStat.isDirectory()) {
			const queue: string[] = [resolved.canonical];
			let opsSinceYield = 0;
			while (
				queue.length > 0 &&
				!signal.aborted &&
				!conflict &&
				dirsScanned < INSPECT_MAX_GREP_DIRS &&
				filesScanned < INSPECT_MAX_GREP_FILES &&
				entriesVisited < INSPECT_MAX_GREP_ENTRIES &&
				matches.length < INSPECT_MAX_GREP_MATCHES
			) {
				const dir = queue.shift() as string;
				dirsScanned++;
				if (++opsSinceYield >= YIELD_BATCH) {
					opsSinceYield = 0;
					await yieldEventLoop();
					if (signal.aborted || !workspaceStillPinned(ctx)) {
						conflict = true;
						break;
					}
				}
				let dirInfo: ReturnType<typeof readBoundedDirEntries>;
				let dirId: string;
				try {
					if (
						realpathSync(dir) !== dir ||
						!isWithin(ctx.workspace, dir) ||
						!lstatSync(dir).isDirectory()
					)
						continue;
					dirId = directoryIdentity(dir);
					dirInfo = readBoundedDirEntries(dir, INSPECT_MAX_RAW_DIR_ENTRIES);
				} catch {
					continue;
				}
				if (dirInfo.truncatedRaw) truncated = true;
				if (
					!recordBinding(bindings, `dir:${dir}`, {
						kind: "dir",
						requestedPath: dir,
						canonicalPath: dir,
						identity: dirId,
						entriesDigest: dirInfo.digest,
						maxEntries: INSPECT_MAX_RAW_DIR_ENTRIES,
					})
				) {
					conflict = true;
					break;
				}
				for (const entry of dirInfo.entries) {
					if (signal.aborted) break;
					entriesVisited++;
					if (entriesVisited > INSPECT_MAX_GREP_ENTRIES) {
						truncated = true;
						break;
					}
					if (entry.isSymbolicLink()) continue;
					const child = path.join(dir, entry.name);
					if (isPrivateTarget(child, ctx.privateResources)) continue;
					if (entry.isDirectory()) {
						if (!SKIPPED_GREP_DIRS.has(entry.name)) queue.push(child);
					} else if (entry.isFile()) {
						scanFile(child, child);
						if (++opsSinceYield >= YIELD_BATCH) {
							opsSinceYield = 0;
							await yieldEventLoop();
						}
						if (
							conflict ||
							filesScanned >= INSPECT_MAX_GREP_FILES ||
							matchBytes >= INSPECT_MAX_SNIPPET_BYTES ||
							matches.length >= INSPECT_MAX_GREP_MATCHES
						) {
							truncated = true;
							break;
						}
					}
				}
			}
			if (queue.length > 0) truncated = true;
		} else {
			return {
				result: { kind: "grep", path: resolved.rel, status: "unreadable" },
				conflict: false,
			};
		}
	} catch {
		return {
			result: { kind: "grep", path: resolved.rel, status: "unreadable" },
			conflict: false,
		};
	}

	return {
		result: {
			kind: "grep",
			path: resolved.rel,
			pattern,
			status: "ok",
			provenance: "workspace_grep_untrusted_data",
			matches,
			...(withheldFiles > 0 ? { withheld_files: withheldFiles } : {}),
			truncated,
		},
		conflict,
	};
};

export const executeReviewInspection = async (
	request: InspectRequest,
	ctx: ReviewInspectContext,
	bindings: Map<string, InspectedBinding>,
	signal: AbortSignal = new AbortController().signal,
): Promise<{ result: InspectResult; conflict: boolean }> => {
	switch (request.kind) {
		case "read_file":
			return executeReadFile(request, ctx, bindings);
		case "list_dir":
			return executeListDir(request, ctx, bindings);
		case "grep":
			return executeGrep(request, ctx, bindings, signal);
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
				const current = readBoundedDirEntries(
					binding.canonicalPath,
					binding.maxEntries,
				);
				if (current.digest !== binding.entriesDigest) return false;
			}
		}
		return true;
	} catch {
		return false;
	}
};

const hasAllRequiredInspections = (
	ctx: ReviewInspectContext,
	bindings: Map<string, InspectedBinding>,
): boolean => {
	const required = ctx.requiredInspectPaths;
	if (!required?.length) return true;
	for (const requiredCanonical of required) {
		const satisfied = [...bindings.values()].some(
			(binding) =>
				binding.kind === "file" &&
				binding.canonicalPath === requiredCanonical &&
				binding.fullyRead === true,
		);
		if (!satisfied) return false;
	}
	return true;
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

	const finalizeTerminalDecision = (decisionObj: {
		request_id: string;
		decision: "allow_once" | "deny" | "insufficient_evidence" | "ask_user";
		reason: string;
	}) => {
		if (
			decisionObj.decision === "allow_once" &&
			!hasAllRequiredInspections(ctx, bindings)
		) {
			return {
				request_id: decisionObj.request_id,
				decision: "insufficient_evidence" as const,
				reason:
					"Local workspace executable must be fully inspected before unsandboxed approval.",
			};
		}
		return decisionObj;
	};

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
			const validated = parseApprovalReviewDecision(reply, request.id)
				? finalizeTerminalDecision(
						reply as {
							request_id: string;
							decision:
								| "allow_once"
								| "deny"
								| "insufficient_evidence"
								| "ask_user";
							reason: string;
						},
					)
				: null;
			return {
				decision: validated,
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
			if (data.inspect_requests.length > 0)
				return { decision: null, bindings: [...bindings.values()] };
			return {
				decision: finalizeTerminalDecision({
					request_id: data.request_id,
					decision: data.decision,
					reason: data.reason,
				}),
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
			const { result, conflict } = await executeReviewInspection(
				inspectReq,
				ctx,
				bindings,
				signal,
			);
			if (conflict) return { decision: null, bindings: [...bindings.values()] };
			const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
			const candidateData = [...inspectedData, result];
			const candidatePacket = JSON.stringify({
				...baseEvidence,
				inspection_round: round + 1,
				inspected_data_untrusted: candidateData,
			});
			if (
				totalDataBytes + resultBytes > INSPECT_MAX_TOTAL_DATA_BYTES ||
				Buffer.byteLength(candidatePacket, "utf8") > INSPECT_MAX_PACKET_BYTES
			) {
				const notice = {
					kind: inspectReq.kind,
					path: safeEchoPath(inspectReq.path, ctx),
					status: "budget_exceeded",
				};
				const withNotice = JSON.stringify({
					...baseEvidence,
					inspection_round: round + 1,
					inspected_data_untrusted: [...inspectedData, notice],
				});
				if (Buffer.byteLength(withNotice, "utf8") <= INSPECT_MAX_PACKET_BYTES) {
					inspectedData.push(notice);
				}
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
		if (Buffer.byteLength(nextPacket, "utf8") > INSPECT_MAX_PACKET_BYTES) {
			throw new ReviewFailureError(
				"review_evidence_too_large",
				undefined,
				"reviewer_packet",
			);
		}
		if (!isSafeForReviewer(nextPacket, ctx)) {
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
