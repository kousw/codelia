import { wireInt } from "@codelia/shared-types";
import { z } from "zod";

export const UiPositionSchema = z
	.object({
		line: wireInt(),
		column: wireInt(),
	})
	.meta({ id: "UiPosition" });
export type UiPosition = z.infer<typeof UiPositionSchema>;

export const UiRangeSchema = z
	.object({
		start: UiPositionSchema,
		end: UiPositionSchema,
	})
	.meta({ id: "UiRange" });
export type UiRange = z.infer<typeof UiRangeSchema>;

export const UiSelectionSchema = z
	.object({
		path: z.string(),
		range: UiRangeSchema,
		selected_text: z.string().optional(),
	})
	.meta({ id: "UiSelection" });
export type UiSelection = z.infer<typeof UiSelectionSchema>;

export const UiActiveFileSchema = z
	.object({
		path: z.string(),
		language_id: z.string().optional(),
	})
	.meta({ id: "UiActiveFile" });

export const UiContextUpdateParamsSchema = z
	.object({
		cwd: z.string().optional(),
		workspace_root: z.string().optional(),
		active_file: UiActiveFileSchema.optional(),
		selection: UiSelectionSchema.optional(),
		/** Open extension object for client-specific context. */
		extensions: z.record(z.string(), z.unknown()).optional(),
	})
	.meta({ id: "UiContextUpdateParams" });
export type UiContextUpdateParams = z.infer<typeof UiContextUpdateParamsSchema>;

/** The same shape, attached to `run.start` as `ui_context`. */
export const UiContextSnapshotSchema = UiContextUpdateParamsSchema;
export type UiContextSnapshot = UiContextUpdateParams;
