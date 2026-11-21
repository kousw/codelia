import {
	closeSync,
	constants,
	createReadStream,
	fstatSync,
	fsyncSync,
	openSync,
	readSync,
	writeSync,
} from "node:fs";
import type {
	BaseMessage,
	ConversationApprovalContext,
	ConversationApprovalProvenance,
	ConversationApprovalScope,
	ConversationMessage,
	ConversationSearchResult,
} from "@codelia/core";
import { stringifyContent } from "@codelia/core";

export function appendOriginalMessages(
	file: string,
	messages: BaseMessage[],
	provenance?: readonly (ConversationApprovalProvenance | undefined)[],
): void {
	const data = Buffer.from(
		messages
			.map((message, index) =>
				JSON.stringify(
					provenance?.[index]
						? { ...message, approval_provenance: provenance[index] }
						: message,
				),
			)
			.join("\n") + (messages.length ? "\n" : ""),
	);
	const fd = openSync(
		file,
		constants.O_RDWR |
			constants.O_CREAT |
			constants.O_APPEND |
			(constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("Invalid conversation archive");
		if (stat.size) {
			const last = Buffer.alloc(1);
			readSync(fd, last, 0, 1, stat.size - 1);
			if (last[0] !== 10)
				throw new Error(
					"Incomplete conversation archive; original bytes retained",
				);
		}
		let written = 0;
		while (written < data.length)
			written += writeSync(fd, data, written, data.length - written);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

const parseId = (id: string): number => {
	if (!/^m(?:0|[1-9][0-9]*)$/.test(id))
		throw new Error("Invalid conversation message ID");
	const offset = Number(id.slice(1));
	if (!Number.isSafeInteger(offset))
		throw new Error("Invalid conversation message ID");
	return offset;
};

const textOf = (message: BaseMessage): string => {
	const text = [
		message.role === "tool" && message.display_content
			? message.display_content
			: stringifyContent(message.content, { mode: "display" }),
		message.role === "assistant" ? message.refusal : undefined,
	]
		.filter(Boolean)
		.join("\n");
	return message.role === "assistant" && message.tool_calls?.length
		? `${text}\n${JSON.stringify(message.tool_calls.map((call) => ({ id: call.id, function: call.function })))}`
		: text;
};

async function* entries(
	file: string,
	start: number,
	maxBytes?: number,
): AsyncGenerator<{
	id: string;
	next: string;
	message: BaseMessage & {
		approval_provenance?: ConversationApprovalProvenance;
	};
}> {
	const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let stream: ReturnType<typeof createReadStream> | undefined;
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("Invalid conversation archive");
		if (start > stat.size)
			throw new Error("Conversation cursor is beyond the archive");
		if (maxBytes !== undefined && stat.size - start > maxBytes)
			throw new Error("Approval conversation window is too large");
		if (start === stat.size) return;
		if (start > 0) {
			const previous = Buffer.alloc(1);
			readSync(fd, previous, 0, 1, start - 1);
			if (previous[0] !== 10)
				throw new Error("Conversation cursor is not a message boundary");
		}
		stream = createReadStream(file, {
			fd,
			autoClose: true,
			start,
			end: Math.max(0, stat.size - 1),
		});
		let offset = start;
		let parts: Buffer[] = [];
		let length = 0;
		for await (const raw of stream) {
			const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
			let position = 0;
			while (position < chunk.length) {
				const newline = chunk.indexOf(10, position);
				const end = newline < 0 ? chunk.length : newline + 1;
				const fragment = chunk.subarray(position, end);
				parts.push(fragment);
				length += fragment.length;
				if (newline >= 0) {
					const message = JSON.parse(
						Buffer.concat(parts, length).toString("utf8"),
					) as BaseMessage & {
						approval_provenance?: ConversationApprovalProvenance;
					};
					if (!message || typeof message.role !== "string")
						throw new Error("Invalid original conversation message");
					yield { id: `m${offset}`, next: `m${offset + length}`, message };
					offset += length;
					parts = [];
					length = 0;
				}
				position = end;
			}
		}
		// Keep torn trailing records untouched, but never expose them as originals.
		if (maxBytes !== undefined && length > 0)
			throw new Error("Incomplete approval conversation window");
	} finally {
		if (!stream) closeSync(fd);
		else if (!stream.closed) {
			const closed = new Promise<void>((resolve) =>
				stream?.once("close", resolve),
			);
			stream.destroy();
			await closed;
		}
	}
}

export async function readOriginalApprovalContext(
	file: string,
	{
		userMessageId,
		proposalMessageId,
		workspace,
		cwd,
		workspaceIdentity,
		cwdIdentity,
	}: ConversationApprovalScope & {
		userMessageId: string;
		proposalMessageId?: string;
	},
	isAppliedSteer: (runId: string, steerId: string) => boolean,
): Promise<ConversationApprovalContext | null> {
	const first = parseId(proposalMessageId ?? userMessageId);
	if (proposalMessageId && first >= parseId(userMessageId)) return null;
	const matchesScope = (scope: ConversationApprovalScope): boolean =>
		scope.workspace === workspace &&
		scope.cwd === cwd &&
		scope.workspaceIdentity === workspaceIdentity &&
		scope.cwdIdentity === cwdIdentity;
	let proposal: ConversationMessage | undefined;
	const userMessages: ConversationMessage[] = [];
	for await (const { id, message } of entries(file, first, 2 * 1024 * 1024)) {
		const source = message.approval_provenance;
		if (message.role === "assistant") {
			if (!proposalMessageId || userMessages.length > 0) continue;
			const text = stringifyContent(message.content, { mode: "display" });
			if (!text.trim() && !message.refusal) continue;
			if (
				id !== proposalMessageId ||
				message.tool_calls?.length ||
				message.refusal ||
				source?.source !== "assistant" ||
				!matchesScope(source) ||
				text.length > 1800
			)
				return null;
			proposal = { id, role: "assistant", text, truncated: false };
			continue;
		}
		if (message.role !== "user" || source?.source === "internal_input")
			continue;
		if (
			(source?.source !== "user_input" && source?.source !== "user_steer") ||
			!matchesScope(source) ||
			!source.text.trim() ||
			source.text.includes("<shell_result>") ||
			source.text.length > 1800
		)
			return null;
		if (userMessages.length === 0 && id !== userMessageId) return null;
		if (
			source.source === "user_steer" &&
			!isAppliedSteer(source.runId, source.steerId)
		)
			return null;
		userMessages.push({
			id,
			role: "user",
			text: source.text,
			truncated: false,
		});
		if (userMessages.length > 8) return null;
	}
	return userMessages.length && (!proposalMessageId || proposal)
		? { userMessages, proposal }
		: null;
}

export async function searchOriginalMessages(
	file: string,
	options: { query: string; cursor?: string; limit?: number },
): Promise<ConversationSearchResult> {
	const query = options.query.trim().toLowerCase();
	if (!query || query.length > 200)
		throw new Error("Expected a query of 1–200 characters");
	const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 10)));
	const matches: ConversationMessage[] = [];
	let scanned = 0;
	for await (const entry of entries(
		file,
		options.cursor ? parseId(options.cursor) : 0,
	)) {
		const text = textOf(entry.message);
		const index = text.toLowerCase().indexOf(query);
		if (index >= 0) {
			const start = Math.max(0, index - 80);
			matches.push({
				id: entry.id,
				role: entry.message.role,
				text: text.slice(start, start + 240),
				truncated: start > 0 || text.length > start + 240,
			});
		}
		if (++scanned >= 1000 || matches.length >= limit)
			return { matches, next_cursor: entry.next };
	}
	return { matches };
}

export async function readOriginalMessage(
	file: string,
	options: { id: string; offset?: number; limit?: number },
): Promise<ConversationMessage | null> {
	for await (const entry of entries(file, parseId(options.id))) {
		const text = textOf(entry.message);
		const offset = Math.max(0, Math.trunc(options.offset ?? 0));
		const limit = Math.max(
			1,
			Math.min(8000, Math.trunc(options.limit ?? 4000)),
		);
		const next = offset + limit;
		return {
			id: entry.id,
			role: entry.message.role,
			text: text.slice(offset, next),
			truncated: next < text.length,
			...(next < text.length ? { next_offset: next } : {}),
		};
	}
	return null;
}
