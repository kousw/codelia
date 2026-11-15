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
	ConversationMessage,
	ConversationSearchResult,
} from "@codelia/core";
import { stringifyContent } from "@codelia/core";

export function appendOriginalMessages(
	file: string,
	messages: BaseMessage[],
): void {
	const data = Buffer.from(
		messages.map((message) => JSON.stringify(message)).join("\n") +
			(messages.length ? "\n" : ""),
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
		stringifyContent(message.content, { mode: "display" }),
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
): AsyncGenerator<{ id: string; next: string; message: BaseMessage }> {
	const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let stream: ReturnType<typeof createReadStream> | undefined;
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("Invalid conversation archive");
		if (start > stat.size)
			throw new Error("Conversation cursor is beyond the archive");
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
					) as BaseMessage;
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
