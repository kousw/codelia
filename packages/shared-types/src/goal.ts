import { z } from "zod";
import { wireInt } from "./wire";

export const GoalStatusSchema = z
	.enum([
		"active",
		"paused",
		"blocked",
		"usage_limited",
		"budget_limited",
		"complete",
	])
	.meta({ id: "GoalStatus" });
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GoalStopReasonSchema = z
	.enum([
		"user",
		"turn_limit",
		"run_error",
		"checkpoint_failed",
		"interrupted",
		"blocker",
	])
	.meta({ id: "GoalStopReason" });
export type GoalStopReason = z.infer<typeof GoalStopReasonSchema>;

export const GoalRecordSchema = z
	.object({
		session_id: z.string(),
		goal_id: z.string(),
		revision: wireInt(),
		objective: z.string(),
		status: GoalStatusSchema,
		stop_reason: GoalStopReasonSchema.optional(),
		stop_detail: z.string().optional(),
		/** Always sent; `null` means no budget. */
		token_budget: wireInt().nullable(),
		tokens_used: wireInt(),
		usage_known: z.boolean(),
		activation_id: z.string(),
		automatic_runs: wireInt(),
		created_at: z.string(),
		updated_at: z.string(),
	})
	.meta({ id: "GoalRecord" });
export type GoalRecord = z.infer<typeof GoalRecordSchema>;

export const GoalSnapshotSchema = z
	.object({
		session_id: z.string().nullable(),
		goal: GoalRecordSchema.nullable(),
		can_continue: z.boolean(),
		accepted_run_id: z.string().optional(),
		active_run_id: z.string().optional(),
	})
	.meta({ id: "GoalSnapshot" });
export type GoalSnapshot = z.infer<typeof GoalSnapshotSchema>;

export const GoalOfferSchema = z
	.object({
		session_id: z.string(),
		goal_id: z.string(),
		revision: wireInt(),
		continuation_id: z.string(),
		after_run_id: z.string().optional(),
	})
	.meta({ id: "GoalOffer" });
export type GoalOffer = z.infer<typeof GoalOfferSchema>;
