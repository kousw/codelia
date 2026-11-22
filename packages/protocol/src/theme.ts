import { z } from "zod";

export const ThemeSetParamsSchema = z
	.object({
		name: z.string(),
	})
	.meta({ id: "ThemeSetParams" });
export type ThemeSetParams = z.infer<typeof ThemeSetParamsSchema>;

export const ThemeSetResultSchema = z
	.object({
		name: z.string(),
		scope: z.enum(["global", "project"]).optional(),
		path: z.string().optional(),
	})
	.meta({ id: "ThemeSetResult" });
export type ThemeSetResult = z.infer<typeof ThemeSetResultSchema>;
