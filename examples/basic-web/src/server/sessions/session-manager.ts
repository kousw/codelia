import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionState, SessionStateSummary } from "@codelia/core";
import {
	SessionStateStoreImpl,
	StoragePathServiceImpl,
} from "@codelia/storage";

export type SessionManagerLike = {
	list(): Promise<SessionStateSummary[]>;
	load(sessionId: string): Promise<SessionState | null>;
	save(state: SessionState): Promise<void>;
	delete(sessionId: string): Promise<boolean>;
	dispose?(): Promise<void> | void;
};

export class SessionManager implements SessionManagerLike {
	private readonly store: SessionStateStoreImpl;
	private readonly stateDir: string;

	constructor() {
		this.store = new SessionStateStoreImpl({
			onError: (error, context) => {
				console.error(`[session-manager] ${context.action}: ${String(error)}`);
			},
		});
		const storage = new StoragePathServiceImpl();
		const paths = storage.resolvePaths();
		this.stateDir = path.join(paths.sessionsDir, "state");
	}

	async list(): Promise<SessionStateSummary[]> {
		return this.store.list();
	}

	async load(sessionId: string): Promise<SessionState | null> {
		return this.store.load(sessionId);
	}

	async save(state: SessionState): Promise<void> {
		return this.store.save(state);
	}

	async delete(sessionId: string): Promise<boolean> {
		try {
			await fs.unlink(path.join(this.stateDir, `${sessionId}.json`));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return false;
			}
			return false;
		}
	}

	dispose(): void {}
}
