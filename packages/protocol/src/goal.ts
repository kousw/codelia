import { clearable, GoalOfferSchema, wireInt } from "@codelia/shared-types";
import { z } from "zod";
import { ClientToolDefinitionSchema } from "./client-tools";
import { UiContextSnapshotSchema } from "./ui-context";

export const GoalGetParamsSchema = z
	.object({
		session_id: z.string().optional(),
		continuation_id: z.string().optional(),
	})
	.meta({ id: "GoalGetParams" });
export type GoalGetParams = z.infer<typeof GoalGetParamsSchema>;

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

export const GoalPauseParamsSchema = z
	.object({
		session_id: z.string(),
		goal_id: z.string(),
		activation_id: z.string(),
		run_id: z.string().optional(),
		continuation_id: z.string().optional(),
	})
	.meta({ id: "GoalPauseParams" });
export type GoalPauseParams = z.infer<typeof GoalPauseParamsSchema>;

/** The `goal.ready` offer plus the `run.start` fields a continuation keeps. */
export const GoalContinueParamsSchema = GoalOfferSchema.extend({
	tools: z.array(ClientToolDefinitionSchema).optional(),
	ui_context: UiContextSnapshotSchema.optional(),
}).meta({ id: "GoalContinueParams" });
export type GoalContinueParams = z.infer<typeof GoalContinueParamsSchema>;
