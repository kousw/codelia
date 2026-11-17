import path from "node:path";
import { FileAttachmentStore, resolveStoragePaths } from "@codelia/storage";
import { isTuiLocalEnvironment } from "../environment";
import { createLocalImageStore } from "../image-generation/local-store";
import type { RuntimeState } from "../runtime-state";
import { AttachmentTransferService } from "./service";

export function createRuntimeAttachmentService(
	state: RuntimeState,
): AttachmentTransferService | undefined {
	const environment = state.effectiveEnvironment;
	const workspaceRoot = environment.workspace.root;
	const localStore = () =>
		isTuiLocalEnvironment(environment) && workspaceRoot
			? new FileAttachmentStore(
					path.join(resolveStoragePaths().sessionsDir, "attachments"),
					createLocalImageStore(workspaceRoot, () => state.sessionId),
				)
			: undefined;
	const configuredStore = environment.adapters.stores?.attachmentStore;
	const store = configuredStore === undefined ? localStore() : configuredStore;
	return store
		? new AttachmentTransferService(
				store,
				environment.adapters.attachmentUploadLimits,
				undefined,
				() => state.sessionId,
			)
		: undefined;
}
