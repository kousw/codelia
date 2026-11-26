import { nullish } from "@codelia/shared-types";
import { z } from "zod";

export const UiConfirmRequestParamsSchema = z
	.object({
		run_id: z.string().optional(),
		title: z.string(),
		message: z.string(),
		confirm_label: z.string().optional(),
		cancel_label: z.string().optional(),
		danger_level: z.enum(["normal", "danger"]).optional(),
		allow_remember: z.boolean().optional(),
		allow_reason: z.boolean().optional(),
	})
	.meta({ id: "UiConfirmRequestParams" });
export type UiConfirmRequestParams = z.infer<
	typeof UiConfirmRequestParamsSchema
>;

export const UiConfirmResultSchema = z
	.object({
		ok: z.boolean(),
		// Older TUIs send `null` for both when unset.
		remember: nullish(z.boolean()),
		reason: nullish(z.string()),
	})
	.meta({ id: "UiConfirmResult" });
export type UiConfirmResult = z.infer<typeof UiConfirmResultSchema>;

export const UiPromptRequestParamsSchema = z
	.object({
		run_id: z.string().optional(),
		title: z.string(),
		message: z.string(),
		default_value: z.string().optional(),
		multiline: z.boolean().optional(),
		secret: z.boolean().optional(),
	})
	.meta({ id: "UiPromptRequestParams" });
export type UiPromptRequestParams = z.infer<typeof UiPromptRequestParamsSchema>;

export const UiPromptResultSchema = z
	.object({
		/** `null` when the user cancelled. */
		value: z.string().nullable(),
	})
	.meta({ id: "UiPromptResult" });
export type UiPromptResult = z.infer<typeof UiPromptResultSchema>;

export const UiPickItemSchema = z
	.object({
		id: z.string(),
		label: z.string(),
		detail: z.string().optional(),
	})
	.meta({ id: "UiPickItem" });

export const UiPickRequestParamsSchema = z
	.object({
		/** Only set by a runtime that selects the structured approval path. */
		approval: z.boolean().optional(),
		/**
		 * Set only with `approval: true` when allowing runs one parent shell
		 * command outside the sandbox as the login user. Clients may require a
		 * deliberate choice instead of a default action; older clients ignore it.
		 */
		escalation: z.enum(["unsandboxed"]).optional(),
		/**
		 * Set to `false` only with `escalation` when configured protected paths
		 * are not enforced for that command. Omitted when none are configured.
		 */
		protected_paths_enforced: z.boolean().optional(),
		message: z.string().optional(),
		run_id: z.string().optional(),
		title: z.string(),
		items: z.array(UiPickItemSchema),
		multi: z.boolean().optional(),
	})
	.meta({ id: "UiPickRequestParams" });
export type UiPickRequestParams = z.infer<typeof UiPickRequestParamsSchema>;

export const UiPickResultSchema = z
	.object({
		/** Chosen item ids; empty when the user cancelled. */
		ids: z.array(z.string()),
	})
	.meta({ id: "UiPickResult" });
export type UiPickResult = z.infer<typeof UiPickResultSchema>;

/** The runtime withdrew a pending `ui.pick.request` (e.g. its run ended). */
export const UiPickCancelledParamsSchema = z
	.object({
		/** Id of the withdrawn `ui.pick.request`. */
		id: z.string(),
	})
	.meta({ id: "UiPickCancelledParams" });
export type UiPickCancelledParams = z.infer<typeof UiPickCancelledParamsSchema>;
