import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
	SessionState,
	SessionStateStore,
	SessionStateSummary,
	StoragePaths,
} from "@codelia/core";
import { stringifyContent } from "@codelia/core";
import { resolveStoragePaths } from "./paths";

const STATE_DIRNAME = "state";

const resolveStateDir = (paths: StoragePaths): string =>
	path.join(paths.sessionsDir, STATE_DIRNAME);

type SessionMessage = SessionState["messages"][number];

const extractLastUserMessage = (
	messages: SessionState["messages"],
): string | undefined => {
	for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
		const message = messages[idx] as SessionMessage | undefined;
		if (!message || typeof message !== "object") continue;
		if ("role" in message && message.role === "user" && "content" in message) {
			return stringifyContent(message.content as SessionMessage["content"], {
				mode: "display",
			});
		}
	}
	return undefined;
};

const toSummary = (state: SessionState): SessionStateSummary => ({
	session_id: state.session_id,
	updated_at: state.updated_at,
	run_id: state.run_id,
	message_count: Array.isArray(state.messages)
		? state.messages.length
		: undefined,
	last_user_message: Array.isArray(state.messages)
		? extractLastUserMessage(state.messages)
		: undefined,
});

type SessionStateStoreOptions = {
	paths?: StoragePaths;
	onError?: (
		error: unknown,
		context: { action: string; detail?: string },
	) => void;
};

export class SessionStateStoreImpl implements SessionStateStore {
	private readonly stateDir: string;
	private readonly ensureDir: Promise<void>;
	private readonly onError?: SessionStateStoreOptions["onError"];

	constructor(options: SessionStateStoreOptions = {}) {
		const paths = options.paths ?? resolveStoragePaths();
		this.stateDir = resolveStateDir(paths);
		this.ensureDir = fs
			.mkdir(this.stateDir, { recursive: true })
			.then(() => {});
		this.onError = options.onError;
	}

	private resolvePath(sessionId: string): string {
		return path.join(this.stateDir, `${sessionId}.json`);
	}

	async load(sessionId: string): Promise<SessionState | null> {
		try {
			const file = await fs.readFile(this.resolvePath(sessionId), "utf8");
			const parsed = JSON.parse(file) as SessionState;
			if (!parsed || typeof parsed !== "object") return null;
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return null;
			}
			this.onError?.(error, { action: "load", detail: sessionId });
			throw error;
		}
	}

	async save(state: SessionState): Promise<void> {
		await this.ensureDir;
		const payload = `${JSON.stringify(state)}\n`;
		await fs.writeFile(this.resolvePath(state.session_id), payload, "utf8");
	}

	async list(): Promise<SessionStateSummary[]> {
		await this.ensureDir;
		let entries: Dirent[];
		try {
			entries = (await fs.readdir(this.stateDir, {
				withFileTypes: true,
				encoding: "utf8",
			})) as Dirent[];
		} catch (error) {
			this.onError?.(error, { action: "list" });
			throw error;
		}
		const summaries: SessionStateSummary[] = [];
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith(".json")) continue;
			const filePath = path.join(this.stateDir, entry.name);
			try {
				const contents = await fs.readFile(filePath, "utf8");
				const parsed = JSON.parse(contents) as SessionState;
				if (!parsed || typeof parsed !== "object") continue;
				if (!parsed.session_id || !parsed.updated_at) continue;
				summaries.push(toSummary(parsed));
			} catch (error) {
				this.onError?.(error, { action: "parse", detail: filePath });
			}
		}
		return summaries;
	}
}
