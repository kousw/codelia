import {
	applyInitializeError,
	applyInitializeSnapshot,
} from "../../state/actions";
import { rpc } from "../runtime";

let initializePromise: Promise<void> | null = null;

export const initializeView = async (): Promise<void> => {
	if (!initializePromise) {
		initializePromise = (async () => {
			const snapshot = await rpc.request.initialize();
			applyInitializeSnapshot(snapshot);
		})().catch((error) => {
			initializePromise = null;
			applyInitializeError(error);
		});
	}
	await initializePromise;
};
