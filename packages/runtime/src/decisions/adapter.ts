import { z } from "zod";
import {
	type ImageReference,
	imageReferenceDataUrl,
} from "../image-generation/references";
import { DecisionError, type DecisionFetch, decisionJson } from "./http";
import type { DecisionInput, DecisionQuestion } from "./schema";

export const DECISION_MODELS = {
	openai: "gpt-6-luna",
	google: "gemini-decision-1",
} as const;
const prob = z.number().finite().min(0).max(1);
const count = z.number().int().nonnegative();
const googleEnvelope = z.object({
	answers: z.record(z.string(), z.unknown()),
	usage: z
		.object({
			total_input_tokens: count.optional(),
			total_output_tokens: count.optional(),
			total_tokens: count.optional(),
		})
		.optional(),
	model: z.string().max(160).optional(),
});
const openaiEnvelope = z.object({
	answers: z.array(z.unknown()),
	usage: z
		.object({
			input_tokens: count.optional(),
			output_tokens: count.optional(),
			total_tokens: count.optional(),
		})
		.optional(),
	model: z.string().max(160).optional(),
});
const malformed = (): never => {
	throw new DecisionError(
		"Decisions API returned incomplete or invalid answers; no retry was attempted.",
	);
};

function openaiQuestions(questions: DecisionQuestion[]) {
	return questions.map((q) => {
		if (q.type === "predicate")
			return { name: q.name, type: q.type, instructions: q.instructions };
		if (q.type === "choice")
			return {
				name: q.name,
				type: q.type,
				instructions: q.instructions,
				choices: q.choices,
			};
		return {
			name: q.name,
			type: q.type,
			instructions: q.instructions,
			levels: q.levels,
		};
	});
}

function googleQuestions(questions: DecisionQuestion[]) {
	return Object.fromEntries(
		questions.map((q) => {
			if (q.type === "predicate")
				return [q.name, { type: "noul", instructions: q.instructions }];
			if (q.type === "choice")
				return [
					q.name,
					{
						type: q.type,
						instructions: q.instructions,
						criteria: Object.fromEntries(
							q.choices.map((c) => [c.value, c.description ?? ""]),
						),
					},
				];
			return [
				q.name,
				{
					type: q.type,
					instructions: q.instructions,
					criteria: q.levels.map((l) =>
						l.description ? `${l.label}: ${l.description}` : l.label,
					),
				},
			];
		}),
	);
}

function normalizeAnswer(
	question: DecisionQuestion,
	raw: unknown,
	provider: DecisionInput["provider"],
) {
	const base = z.object({ type: z.string() }).safeParse(raw);
	if (!base.success) return malformed();
	if (base.data.type === "refusal" && provider === "openai")
		return { name: question.name, type: "refusal" as const };
	if (question.type === "predicate") {
		const schema =
			provider === "openai"
				? z.object({ type: z.literal("predicate"), probability: prob })
				: z.object({ type: z.literal("noul"), noul: prob, confidence: prob });
		const parsed = schema.safeParse(raw);
		if (!parsed.success) return malformed();
		return parsed.data.type === "predicate"
			? {
					name: question.name,
					type: "predicate" as const,
					probability: parsed.data.probability,
				}
			: {
					name: question.name,
					type: "predicate" as const,
					probability: parsed.data.noul,
					confidence: parsed.data.confidence,
				};
	}
	const expected =
		question.type === "choice"
			? question.choices.map((c) => c.value)
			: question.levels.map((_l, i) => String(i));
	let probabilities: Map<string, number>;
	if (provider === "google") {
		const parsed = z
			.object({ probabilities: z.record(z.string(), prob) })
			.safeParse(raw);
		if (!parsed.success) return malformed();
		probabilities = new Map(Object.entries(parsed.data.probabilities));
	} else if (question.type === "choice") {
		const parsed = z
			.object({
				probabilities: z.array(
					z.object({
						value: z.string(),
						probability: prob,
					}),
				),
			})
			.safeParse(raw);
		if (!parsed.success) return malformed();
		probabilities = new Map(
			parsed.data.probabilities.map((p) => [p.value, p.probability]),
		);
		if (probabilities.size !== parsed.data.probabilities.length)
			return malformed();
	} else {
		const parsed = z
			.object({
				probabilities: z.array(
					z.object({
						value: z.number().int().nonnegative(),
						label: z.string(),
						probability: prob,
					}),
				),
			})
			.safeParse(raw);
		if (
			!parsed.success ||
			parsed.data.probabilities.some(
				(p) => question.levels[p.value]?.label !== p.label,
			)
		)
			return malformed();
		probabilities = new Map(
			parsed.data.probabilities.map((p) => [String(p.value), p.probability]),
		);
		if (probabilities.size !== parsed.data.probabilities.length)
			return malformed();
	}
	if (
		probabilities.size !== expected.length ||
		expected.some((key) => !probabilities.has(key))
	)
		return malformed();
	if (question.type === "choice") {
		const parsed = z
			.object({
				type: z.literal("choice"),
				choice: z.string(),
				confidence: prob,
			})
			.safeParse(raw);
		if (!parsed.success || !expected.includes(parsed.data.choice))
			return malformed();
		return {
			name: question.name,
			type: "choice" as const,
			choice: parsed.data.choice,
			confidence: parsed.data.confidence,
			probabilities: expected.map((value) => ({
				value,
				probability: probabilities.get(value) as number,
			})),
		};
	}
	const parsed = z
		.object({
			type: z.literal("score"),
			score: z
				.number()
				.finite()
				.min(0)
				.max(expected.length - 1),
			confidence: prob,
		})
		.safeParse(raw);
	if (!parsed.success) return malformed();
	return {
		name: question.name,
		type: "score" as const,
		score: parsed.data.score,
		confidence: parsed.data.confidence,
		probabilities: question.levels.map((level, i) => ({
			value: i,
			label: level.label,
			probability: probabilities.get(String(i)) as number,
		})),
	};
}

export async function runDecision(
	input: DecisionInput,
	images: ImageReference[],
	apiKey: string,
	signal?: AbortSignal,
	fetcher: DecisionFetch = fetch,
) {
	const model = DECISION_MODELS[input.provider];
	const text = input.input_text ?? "";
	const contents = images.length
		? [
				...(text
					? [
							input.provider === "openai"
								? { type: "input_text", text }
								: { type: "text", text },
						]
					: []),
				...images.map((image) =>
					input.provider === "openai"
						? { type: "input_image", image_url: imageReferenceDataUrl(image) }
						: {
								type: "image",
								mime_type: image.media_type,
								data: Buffer.from(image.bytes).toString("base64"),
							},
				),
			]
		: undefined;
	const body =
		input.provider === "openai"
			? {
					model,
					input: contents ? [{ role: "user", content: contents }] : text,
					questions: openaiQuestions(input.questions),
				}
			: {
					model,
					input: contents ?? text,
					questions: googleQuestions(input.questions),
				};
	const url =
		input.provider === "openai"
			? "https://api.openai.com/v1/decisions"
			: "https://generativelanguage.googleapis.com/v1beta/decisions";
	const headers: Record<string, string> =
		input.provider === "openai"
			? { Authorization: `Bearer ${apiKey}` }
			: { "x-goog-api-key": apiKey };
	const raw = await decisionJson(
		url,
		{
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		},
		fetcher,
	);
	if (input.provider === "google") {
		const parsed = googleEnvelope.safeParse(raw);
		if (
			!parsed.success ||
			Object.keys(parsed.data.answers).length !== input.questions.length
		)
			return malformed();
		const answers = input.questions.map((q) => {
			if (!Object.hasOwn(parsed.data.answers, q.name)) return malformed();
			return normalizeAnswer(q, parsed.data.answers[q.name], input.provider);
		});
		const usage = parsed.data.usage;
		const normalizedUsage: Record<string, number> = {};
		if (usage?.total_input_tokens !== undefined)
			normalizedUsage.input_tokens = usage.total_input_tokens;
		if (usage?.total_output_tokens !== undefined)
			normalizedUsage.output_tokens = usage.total_output_tokens;
		if (usage?.total_tokens !== undefined)
			normalizedUsage.total_tokens = usage.total_tokens;
		return {
			provider: input.provider,
			requested_model: model,
			...(parsed.data.model ? { reported_model: parsed.data.model } : {}),
			answers,
			...(usage ? { usage: normalizedUsage } : {}),
		};
	}
	const parsed = openaiEnvelope.safeParse(raw);
	if (!parsed.success || parsed.data.answers.length !== input.questions.length)
		return malformed();
	const byName = new Map<string, unknown>();
	for (const answer of parsed.data.answers) {
		const named = z.object({ name: z.string() }).safeParse(answer);
		if (!named.success || byName.has(named.data.name)) return malformed();
		byName.set(named.data.name, answer);
	}
	const answers = input.questions.map((q) => {
		if (!byName.has(q.name)) return malformed();
		return normalizeAnswer(q, byName.get(q.name), input.provider);
	});
	const usage = parsed.data.usage;
	const normalizedUsage: Record<string, number> = {};
	if (usage?.input_tokens !== undefined)
		normalizedUsage.input_tokens = usage.input_tokens;
	if (usage?.output_tokens !== undefined)
		normalizedUsage.output_tokens = usage.output_tokens;
	if (usage?.total_tokens !== undefined)
		normalizedUsage.total_tokens = usage.total_tokens;
	return {
		provider: input.provider,
		requested_model: model,
		...(parsed.data.model ? { reported_model: parsed.data.model } : {}),
		answers,
		...(usage ? { usage: normalizedUsage } : {}),
	};
}
