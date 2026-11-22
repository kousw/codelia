import { z } from "zod";
import { wireInt } from "./wire";

export const SessionStateSummarySchema = z
	.object({
		session_id: z.string(),
		/** ISO 8601 timestamp. */
		updated_at: z.string(),
		run_id: z.string().optional(),
		message_count: wireInt().optional(),
		last_user_message: z.string().optional(),
		workspace_root: z.string().optional(),
		pinned: z.boolean().optional(),
		/** ISO 8601 timestamp; absent when the session is not archived. */
		archived_at: z.string().optional(),
	})
	.meta({ id: "SessionStateSummary" });
export type SessionStateSummary = z.infer<typeof SessionStateSummarySchema>;
