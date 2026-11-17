import type {
	RunEventStoreFactory,
	RunEventStoreInit,
	SessionStore,
} from "@codelia/core";
import type { SessionRunRecorder } from "./session-run-index";
import { SessionStoreWriterImpl } from "./session-store";
import { SessionStateStoreImpl } from "./session-state";

export class RunEventStoreFactoryImpl implements RunEventStoreFactory {
	private runIndex?: SessionRunRecorder;
	private readonly onRunIndexError?: (error: unknown) => void;

	/**
	 * `runIndex` records each run in state.db (`session_runs`). When omitted, a
	 * default-path SessionStateStoreImpl is created on the first run so every
	 * normal run log stays indexed.
	 */
	constructor(
		options: {
			runIndex?: SessionRunRecorder;
			onRunIndexError?: (error: unknown) => void;
		} = {},
	) {
		this.runIndex = options.runIndex;
		this.onRunIndexError = options.onRunIndexError;
	}

	create(init: RunEventStoreInit): SessionStore {
		this.runIndex ??= new SessionStateStoreImpl();
		return new SessionStoreWriterImpl({
			runId: init.runId,
			startedAt: init.startedAt,
			runIndex: this.runIndex,
			onRunIndexError: this.onRunIndexError,
		});
	}
}
