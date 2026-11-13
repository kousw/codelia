import { z } from "zod";
import { imageSourceSchema } from "../image-generation/references";

const name = z
	.string()
	.regex(/^[A-Za-z0-9_-]{1,64}$/)
	.describe(
		"Unique ASCII identifier: letters, digits, underscore or hyphen, at most 64 characters.",
	);
const instructions = z
	.string()
	.trim()
	.min(1)
	.max(4000)
	.describe(
		"Complete question to evaluate against the shared input; questions are independent.",
	);
const choice = z
	.object({
		value: name.describe("Unique option ID; use a catch-all option if needed."),
		description: z
			.string()
			.max(1000)
			.optional()
			.describe(
				"When this option applies; omit if its ID is self-explanatory.",
			),
	})
	.strict();
const level = z
	.object({
		label: z
			.string()
			.trim()
			.min(1)
			.max(128)
			.describe("Unique label for this ordered level."),
		description: z
			.string()
			.max(1000)
			.optional()
			.describe("Meaning of this level."),
	})
	.strict();

const question = z.discriminatedUnion("type", [
	z.object({ name, type: z.literal("predicate"), instructions }).strict(),
	z
		.object({
			name,
			type: z.literal("choice"),
			instructions,
			choices: z
				.array(choice)
				.min(2)
				.max(20)
				.describe("2–20 unique options. Google sorts IDs before tie-breaking."),
		})
		.strict(),
	z
		.object({
			name,
			type: z.literal("score"),
			instructions,
			levels: z
				.array(level)
				.min(2)
				.max(10)
				.describe(
					"2–10 unique ordered levels, lowest first. The score is the probability-weighted zero-based index.",
				),
		})
		.strict(),
]);

export const decisionInputSchema = z
	.object({
		provider: z
			.enum(["openai", "google"])
			.describe(
				"Required provider: OpenAI gpt-6-luna or Google gemini-decision-1; uses that provider's API key and billing.",
			),
		input_text: z
			.string()
			.max(100_000)
			.optional()
			.describe(
				"Shared text evidence for every question; omit only when images are supplied.",
			),
		images: z
			.array(imageSourceSchema)
			.max(4)
			.optional()
			.describe(
				"Up to 4 explicit PNG/JPEG/WebP images from URL, runtime file or saved artifact. For an attached or generated image, use type=artifact and its displayed artifact_id. Original bytes are acquired after approval; 16 MiB combined maximum. Viewing an image does not select it.",
			),
		questions: z
			.array(question)
			.min(1)
			.max(32)
			.describe(
				"1–32 named independent predicate, choice or score questions evaluated against the same input.",
			),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (!value.input_text?.trim() && !value.images?.length)
			ctx.addIssue({
				code: "custom",
				message: "Provide input_text or at least one image.",
			});
		const names = new Set<string>();
		for (const item of value.questions) {
			if (names.has(item.name))
				ctx.addIssue({
					code: "custom",
					message: "Question names must be unique.",
				});
			names.add(item.name);
			if (
				item.type === "choice" &&
				new Set(item.choices.map((c) => c.value)).size !== item.choices.length
			)
				ctx.addIssue({
					code: "custom",
					message: "Choice values must be unique.",
				});
			if (
				item.type === "score" &&
				new Set(item.levels.map((l) => l.label)).size !== item.levels.length
			)
				ctx.addIssue({
					code: "custom",
					message: "Score labels must be unique.",
				});
		}
	});

export type DecisionInput = z.infer<typeof decisionInputSchema>;
export type DecisionQuestion = DecisionInput["questions"][number];
