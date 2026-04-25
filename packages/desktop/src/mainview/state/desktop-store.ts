import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { createInitialViewState, type ViewState } from "./view-state";

const syncDocumentTitle = (): void => {
	if (typeof document === "undefined") {
		return;
	}
	document.title = " ";
};

const desktopStore = createStore<ViewState>()(() => createInitialViewState());

export const getDesktopViewState = (): ViewState => desktopStore.getState();

export const subscribeDesktopViewState = desktopStore.subscribe;

const createDraft = (state: ViewState): ViewState => ({
	...state,
	snapshot: { ...state.snapshot },
});

export const commitState = (recipe: (draft: ViewState) => void): ViewState => {
	const next = createDraft(getDesktopViewState());
	recipe(next);
	syncDocumentTitle();
	desktopStore.setState(next);
	return next;
};

export const useDesktopStore = <T>(selector: (state: ViewState) => T): T =>
	useStore(desktopStore, selector);
