import { useSyncExternalStore } from "react";
import {
	getDesktopViewStateSnapshot,
	subscribeDesktopViewState,
} from "../controller";

export const useDesktopViewState = () =>
	useSyncExternalStore(subscribeDesktopViewState, getDesktopViewStateSnapshot);
