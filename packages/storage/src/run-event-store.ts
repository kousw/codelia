import type {
	RunEventStoreFactory,
	RunEventStoreInit,
	SessionStore,
} from "@codelia/core";
import { SessionStoreWriterImpl } from "./session-store";

export class RunEventStoreFactoryImpl implements RunEventStoreFactory {
	create(init: RunEventStoreInit): SessionStore {
		return new SessionStoreWriterImpl({
			runId: init.runId,
			startedAt: init.startedAt,
		});
	}
}
