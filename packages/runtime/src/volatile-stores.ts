import type {
	RunEventStoreFactory,
	RunEventStoreInit,
	SessionRecord,
	SessionState,
	SessionStateStore,
	SessionStateSummary,
	SessionStore,
	ToolOutputCacheRecord,
	ToolOutputCacheReadOptions,
	ToolOutputCacheSearchOptions,
	ToolOutputCacheStore,
	ToolOutputRef,
} from "@codelia/core";

type ToolOutputCacheReadLineOptions = {
	line_number: number;
	char_offset?: number;
	char_limit?: number;
};

const stringifyMessageContent = (value: unknown): string | undefined => {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		const parts = value
			.map((part) => {
				if (!part || typeof part !== "object") return "";
				const record = part as Record<string, unknown>;
				return typeof record.text === "string" ? record.text : "";
			})
			.filter((part) => part.length > 0);
		return parts.length ? parts.join("") : undefined;
	}
	return undefined;
};

const toSummary = (state: SessionState): SessionStateSummary => {
	let lastUserMessage: string | undefined;
	for (let index = state.messages.length - 1; index >= 0; index -= 1) {
		const message = state.messages[index] as
			| Record<string, unknown>
			| undefined;
		if (message?.role !== "user") continue;
		lastUserMessage = stringifyMessageContent(message.content);
		break;
	}
	return {
		session_id: state.session_id,
		updated_at: state.updated_at,
		...(state.run_id ? { run_id: state.run_id } : {}),
		message_count: state.messages.length,
		...(lastUserMessage ? { last_user_message: lastUserMessage } : {}),
	};
};

export class VolatileSessionStateStore implements SessionStateStore {
	private readonly states = new Map<string, SessionState>();

	async load(sessionId: string): Promise<SessionState | null> {
		const state = this.states.get(sessionId);
		return state ? structuredClone(state) : null;
	}

	async save(state: SessionState): Promise<void> {
		this.states.set(state.session_id, structuredClone(state));
	}

	async list(): Promise<SessionStateSummary[]> {
		return Array.from(this.states.values())
			.map(toSummary)
			.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
	}
}

export class VolatileRunEventStoreFactory implements RunEventStoreFactory {
	readonly records = new Map<string, SessionRecord[]>();

	create(init: RunEventStoreInit): SessionStore {
		const records: SessionRecord[] = [];
		this.records.set(init.runId, records);
		return {
			append: (record) => {
				records.push(structuredClone(record));
			},
		};
	}
}

export class VolatileToolOutputCacheStore implements ToolOutputCacheStore {
	private readonly records = new Map<string, ToolOutputCacheRecord>();

	async save(record: ToolOutputCacheRecord): Promise<ToolOutputRef> {
		const id = record.tool_call_id;
		this.records.set(id, structuredClone(record));
		return {
			id,
			byte_size: Buffer.byteLength(record.content, "utf8"),
			line_count: record.content.split(/\r?\n/).length,
		};
	}

	async read(
		refId: string,
		options: ToolOutputCacheReadOptions = {},
	): Promise<string> {
		const record = this.records.get(refId);
		if (!record) throw new Error(`tool output not found: ${refId}`);
		const lines = record.content.split(/\r?\n/);
		const offset = Math.max(0, Math.trunc(options.offset ?? 0));
		const limit = Math.max(1, Math.trunc(options.limit ?? lines.length));
		return lines.slice(offset, offset + limit).join("\n");
	}

	async readLine(
		refId: string,
		options: ToolOutputCacheReadLineOptions,
	): Promise<string> {
		const record = this.records.get(refId);
		if (!record) throw new Error(`tool output not found: ${refId}`);
		const lines = record.content.split(/\r?\n/);
		const line = lines[options.line_number - 1];
		if (line === undefined) {
			return `Line number out of range: ${options.line_number} (total ${lines.length})`;
		}
		const offset = Math.max(0, Math.trunc(options.char_offset ?? 0));
		const limit = Math.max(1, Math.trunc(options.char_limit ?? line.length));
		return line.slice(offset, offset + limit);
	}

	async grep(
		refId: string,
		options: ToolOutputCacheSearchOptions,
	): Promise<string> {
		const record = this.records.get(refId);
		if (!record) throw new Error(`tool output not found: ${refId}`);
		const query = options.pattern.toLowerCase();
		return record.content
			.split(/\r?\n/)
			.map((line, index) => ({ line, index }))
			.filter(({ line }) => line.toLowerCase().includes(query))
			.slice(0, options.max_matches ?? 50)
			.map(
				({ line, index }) => `${String(index + 1).padStart(6, "0")}  ${line}`,
			)
			.join("\n");
	}
}
