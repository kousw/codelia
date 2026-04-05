import type { InspectBundle } from "../../../shared/types";
import { commitState } from "../desktop-store";

export const setInspectOpen = (open: boolean): void => {
	commitState((draft) => {
		draft.inspectOpen = open;
	});
};

export const applyInspectBundle = (inspect: InspectBundle): void => {
	commitState((draft) => {
		draft.inspect = inspect;
		draft.inspectOpen = true;
	});
};
