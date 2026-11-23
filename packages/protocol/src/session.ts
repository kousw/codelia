import {
	SessionStateSummarySchema,
	wireCount,
	wireInt,
} from "@codelia/shared-types";
import { z } from "zod";

export const SessionListScopeSchema = z
	.enum(["current_workspace", "all"])
	.meta({ id: "SessionListScope" });

export const SessionListParamsSchema = z
	.object({
		limit: wireCount().optional(),
		scope: SessionListScopeSchema.optional(),
		workspace_root: z.string().optional(),
		include_archived: z.boolean().optional(),
	})
	.meta({ id: "SessionListParams" });
export type SessionListParams = z.infer<typeof SessionListParamsSchema>;

export const SessionUpdateParamsSchema = z
	.object({
		session_id: z.string(),
		pinned: z.boolean().optional(),
		archived: z.boolean().optional(),
	})
	.meta({ id: "SessionUpdateParams" });
export type SessionUpdateParams = z.infer<typeof SessionUpdateParamsSchema>;

export const SessionUpdateResultSchema = z
	.object({ session: SessionStateSummarySchema })
	.meta({ id: "SessionUpdateResult" });
export type SessionUpdateResult = z.infer<typeof SessionUpdateResultSchema>;

export const SessionListResultSchema = z
	.object({
		sessions: z.array(SessionStateSummarySchema),
		current_workspace_root: z.string().optional(),
	})
	.meta({ id: "SessionListResult" });
export type SessionListResult = z.infer<typeof SessionListResultSchema>;

export const SessionHistoryParamsSchema = z
	.object({
		session_id: z.string(),
		max_runs: wireCount().optional(),
		max_events: wireCount().optional(),
	})
	.meta({ id: "SessionHistoryParams" });
export type SessionHistoryParams = z.infer<typeof SessionHistoryParamsSchema>;

export const SessionHistoryResultSchema = z
	.object({
		runs: wireInt(),
		events_sent: wireInt(),
		truncated: z.boolean().optional(),
		/** Status lines describing a material resume-context change. */
		resume_diff: z.string().optional(),
	})
	.meta({ id: "SessionHistoryResult" });
export type SessionHistoryResult = z.infer<typeof SessionHistoryResultSchema>;

/**
 * Bind the runtime to an existing session before its next run, so
 * session-scope `model.set` writes to that session.
 */
export const SessionOpenParamsSchema = z
	.object({ session_id: z.string() })
	.meta({ id: "SessionOpenParams" });
export type SessionOpenParams = z.infer<typeof SessionOpenParamsSchema>;

export const SessionOpenResultSchema = z
	.object({ session_id: z.string() })
	.meta({ id: "SessionOpenResult" });
export type SessionOpenResult = z.infer<typeof SessionOpenResultSchema>;
