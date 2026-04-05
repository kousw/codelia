import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { selectedWorkspaceFromSnapshot } from "./selectors";
import { createInitialViewState, type ViewState } from "./view-state";

const syncDocumentTitle = (state: ViewState): void => {
	const workspace = selectedWorkspaceFromSnapshot(state.snapshot);
	document.title = workspace
		? `Codelia Desktop · ${workspace.name}`
		: "Codelia Desktop";
};

const desktopStore = createStore<ViewState>()(() => createInitialViewState());

export const getDesktopViewState = (): ViewState => desktopStore.getState();

export const subscribeDesktopViewState = desktopStore.subscribe;

export const commitState = (recipe: (draft: ViewState) => void): ViewState => {
	const next = structuredClone(getDesktopViewState()) as ViewState;
	recipe(next);
	syncDocumentTitle(next);
	desktopStore.setState(next);
	return next;
};

export const useDesktopStore = <T>(selector: (state: ViewState) => T): T =>
	useStore(desktopStore, selector);
