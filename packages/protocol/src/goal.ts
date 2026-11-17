import type { GoalOffer } from "@codelia/shared-types";
import type { RunStartParams } from "./run";

export type GoalGetParams = {
	session_id?: string;
	continuation_id?: string;
};

export type GoalTarget = {
	session_id: string;
	goal_id: string;
	revision: number;
};

export type GoalSetParams = Partial<GoalTarget> & {
	objective?: string;
	token_budget?: number | null;
};

export type GoalPauseParams = {
	session_id: string;
	goal_id: string;
	activation_id: string;
	run_id?: string;
	continuation_id?: string;
};

export type GoalContinueParams = GoalOffer &
	Pick<RunStartParams, "tools" | "ui_context">;
