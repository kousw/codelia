import { clearable, type GoalOffer, wireInt } from "@codelia/shared-types";
import { z } from "zod";
import type { RunStartParams } from "./run";

export type GoalGetParams = {
	session_id?: string;
	continuation_id?: string;
};

export const GoalTargetSchema = z
	.object({
		session_id: z.string(),
		goal_id: z.string(),
		revision: wireInt(),
	})
	.meta({ id: "GoalTarget" });
export type GoalTarget = z.infer<typeof GoalTargetSchema>;

export const GoalSetParamsSchema = GoalTargetSchema.partial()
	.extend({
		objective: z.string().optional(),
		/** Absent keeps the budget, `null` removes it, a number sets it. */
		token_budget: clearable(wireInt()),
	})
	.meta({ id: "GoalSetParams" });
export type GoalSetParams = z.infer<typeof GoalSetParamsSchema>;

export type GoalPauseParams = {
	session_id: string;
	goal_id: string;
	activation_id: string;
	run_id?: string;
	continuation_id?: string;
};

export type GoalContinueParams = GoalOffer &
	Pick<RunStartParams, "tools" | "ui_context">;
