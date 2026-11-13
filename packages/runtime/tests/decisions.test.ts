import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImageArtifactStore } from "@codelia/storage";
import { createDecisionTool } from "../src/decisions/tool";
import { createToolContext } from "../src/rpc/tool";

const png64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=";
const png = Buffer.from(png64, "base64");
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
const store = async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "codelia-decisions-"));
	roots.push(root);
	return new ImageArtifactStore(root);
};
const questions = [
	{ name: "damage", type: "predicate", instructions: "Is the item damaged?" },
	{
		name: "team",
		type: "choice",
		instructions: "Who handles this?",
		choices: [
			{ value: "billing", description: "Payments" },
			{ value: "other" },
		],
	},
	{
		name: "severity",
		type: "score",
		instructions: "How severe?",
		levels: [
			{ label: "low", description: "cosmetic" },
			{ label: "high", description: "blocked" },
		],
	},
] as const;
const openaiAnswer = {
	model: "gpt-6-luna",
	answers: [
		{ name: "damage", type: "predicate", probability: 0.9 },
		{
			name: "team",
			type: "choice",
			choice: "billing",
			confidence: 0.8,
			probabilities: [
				{ value: "billing", probability: 0.8 },
				{ value: "other", probability: 0.2 },
			],
		},
		{
			name: "severity",
			type: "score",
			score: 0.7,
			confidence: 0.7,
			probabilities: [
				{ value: 0, label: "low", probability: 0.3 },
				{ value: 1, label: "high", probability: 0.7 },
			],
		},
	],
	usage: { input_tokens: 30, output_tokens: 0, total_tokens: 30 },
};
const googleAnswer = {
	answers: {
		damage: { type: "noul", noul: 0.9, confidence: 0.9 },
		team: {
			type: "choice",
			choice: "billing",
			confidence: 0.8,
			probabilities: { billing: 0.8, other: 0.2 },
		},
		severity: {
			type: "score",
			score: 0.7,
			confidence: 0.7,
			probabilities: { "0": 0.3, "1": 0.7 },
			legend: { "0": "low: cosmetic", "1": "high: blocked" },
		},
	},
	usage: { total_input_tokens: 30, total_output_tokens: 0, total_tokens: 30 },
};
const auth = {
	storedKey: async (provider: string) => `fixture-${provider}`,
	env: () => undefined,
};
const allow = () => ({ decision: "allow" as const });

test.each(["openai", "google"] as const)(
	"%s sends text and original image with all three question types",
	async (provider) => {
		let reads = 0;
		let requests = 0;
		const tool = createDecisionTool({
			store: await store(),
			auth,
			authorize: allow,
			readSource: async () => {
				reads++;
				return png;
			},
			fetcher: async (url, init) => {
				requests++;
				expect(reads).toBe(1);
				const body = JSON.parse(String(init?.body));
				const headers = new Headers(init?.headers);
				expect(init?.redirect).toBe("error");
				if (provider === "openai") {
					expect(url).toBe("https://api.openai.com/v1/decisions");
					expect(headers.get("Authorization")).toBe("Bearer fixture-openai");
					expect(body).toMatchObject({
						model: "gpt-6-luna",
						input: [
							{
								role: "user",
								content: [
									{ type: "input_text", text: "Inspect this item" },
									{
										type: "input_image",
										image_url: `data:image/png;base64,${png64}`,
									},
								],
							},
						],
						questions,
					});
					return Response.json(openaiAnswer);
				}
				expect(url).toBe(
					"https://generativelanguage.googleapis.com/v1beta/decisions",
				);
				expect(headers.get("x-goog-api-key")).toBe("fixture-google");
				expect(body).toMatchObject({
					model: "gemini-decision-1",
					input: [
						{ type: "text", text: "Inspect this item" },
						{ type: "image", mime_type: "image/png", data: png64 },
					],
					questions: {
						damage: { type: "noul", instructions: questions[0].instructions },
						team: {
							type: "choice",
							criteria: { billing: "Payments", other: "" },
						},
						severity: {
							type: "score",
							criteria: ["low: cosmetic", "high: blocked"],
						},
					},
				});
				return Response.json(googleAnswer);
			},
		});
		const result = await tool.executeRaw(
			JSON.stringify({
				provider,
				input_text: "Inspect this item",
				images: [{ type: "file", file_path: "item.png" }],
				questions,
			}),
			createToolContext(),
		);
		expect(requests).toBe(1);
		expect(result).toMatchObject({
			type: "json",
			value: {
				provider,
				answers: [
					{ name: "damage", type: "predicate", probability: 0.9 },
					{
						name: "team",
						type: "choice",
						choice: "billing",
						confidence: 0.8,
						probabilities: [
							{ value: "billing", probability: 0.8 },
							{ value: "other", probability: 0.2 },
						],
					},
					{
						name: "severity",
						type: "score",
						score: 0.7,
						probabilities: [
							{ value: 0, label: "low", probability: 0.3 },
							{ value: 1, label: "high", probability: 0.7 },
						],
					},
				],
				usage: { input_tokens: 30, output_tokens: 0, total_tokens: 30 },
			},
		});
		if (result.type !== "json") throw new Error("Expected JSON result");
		const resultValue = result.value as {
			answers: Array<Record<string, unknown>>;
		};
		if (provider === "openai")
			expect(resultValue.answers[0]).not.toHaveProperty("confidence");
		else expect(resultValue.answers[0]?.confidence).toBe(0.9);
	},
);

test("denied direct tool execution reads no credentials or images and sends no request", async () => {
	let effects = 0;
	const tool = createDecisionTool({
		store: await store(),
		authorize: () => ({ decision: "deny", reason: "denied" }),
		auth: {
			storedKey: async () => {
				effects++;
				return "fixture";
			},
			env: () => {
				effects++;
				return "fixture";
			},
		},
		readSource: async () => {
			effects++;
			return png;
		},
		fetcher: async () => {
			effects++;
			return Response.json(openaiAnswer);
		},
	});
	await expect(
		tool.executeRaw(
			JSON.stringify({
				provider: "openai",
				images: [{ type: "file", file_path: "input.png" }],
				questions,
			}),
			createToolContext(),
		),
	).rejects.toThrow("denied");
	expect(effects).toBe(0);
});

test("rejects duplicate questions and malformed answers without a fallback", async () => {
	let requests = 0;
	const tool = createDecisionTool({
		store: await store(),
		auth,
		authorize: allow,
		fetcher: async () => {
			requests++;
			return Response.json({
				...openaiAnswer,
				answers: [openaiAnswer.answers[0]],
			});
		},
	});
	expect(() =>
		tool.executeRaw(
			JSON.stringify({
				provider: "openai",
				input_text: "x",
				questions: [questions[0], questions[0]],
			}),
			createToolContext(),
		),
	).toThrow("Question names must be unique");
	expect(requests).toBe(0);
	await expect(
		tool.executeRaw(
			JSON.stringify({ provider: "openai", input_text: "x", questions }),
			createToolContext(),
		),
	).rejects.toThrow("incomplete or invalid answers");
	expect(requests).toBe(1);
});

test("preserves a per-question refusal and redacts provider errors", async () => {
	let calls = 0;
	const tool = createDecisionTool({
		store: await store(),
		auth,
		authorize: allow,
		fetcher: async () => {
			calls++;
			return calls === 1
				? Response.json({ answers: [{ type: "refusal", name: "damage" }] })
				: Response.json(
						{ error: { message: "private-provider-detail" } },
						{ status: 403 },
					);
		},
	});
	const args = JSON.stringify({
		provider: "openai",
		input_text: "x",
		questions: [questions[0]],
	});
	expect(await tool.executeRaw(args, createToolContext())).toMatchObject({
		type: "json",
		value: { answers: [{ type: "refusal", name: "damage" }] },
	});
	try {
		await tool.executeRaw(args, createToolContext());
		throw new Error("Expected rejection");
	} catch (error) {
		expect(String(error)).toContain("HTTP 403");
		expect(String(error)).not.toContain("private-provider-detail");
		expect(String(error)).not.toContain("fixture-openai");
	}
	expect(calls).toBe(2);
});

test("image-only requests resolve stored artifact originals", async () => {
	const artifactStore = await store();
	const artifact = await artifactStore.saveAttachment(png, "image/png");
	let requests = 0;
	const tool = createDecisionTool({
		store: artifactStore,
		auth,
		authorize: allow,
		fetcher: async (_url, init) => {
			requests++;
			const body = JSON.parse(String(init?.body));
			expect(body.input).toEqual([
				{ type: "image", mime_type: "image/png", data: png64 },
			]);
			return Response.json({
				answers: { damage: googleAnswer.answers.damage },
			});
		},
	});
	const result = await tool.executeRaw(
		JSON.stringify({
			provider: "google",
			images: [{ type: "artifact", artifact_id: artifact.artifact_id }],
			questions: [questions[0]],
		}),
		createToolContext(),
	);
	expect(result).toMatchObject({
		type: "json",
		value: {
			provider: "google",
			answers: [{ name: "damage", probability: 0.9 }],
		},
	});
	expect(requests).toBe(1);
});

test.each([
	{
		provider: "openai",
		answers: [
			{
				...openaiAnswer.answers[2],
				probabilities: [
					{ value: 0, label: "high", probability: 0.3 },
					{ value: 1, label: "low", probability: 0.7 },
				],
			},
		],
	},
	{
		provider: "google",
		answers: {
			severity: {
				...googleAnswer.answers.severity,
				probabilities: { "0": 0.3, "2": 0.7 },
			},
		},
	},
] as const)(
	"rejects inconsistent $provider score distributions",
	async ({ provider, answers }) => {
		const tool = createDecisionTool({
			store: await store(),
			auth,
			authorize: allow,
			fetcher: async () => Response.json({ answers }),
		});
		await expect(
			tool.executeRaw(
				JSON.stringify({
					provider,
					input_text: "x",
					questions: [questions[2]],
				}),
				createToolContext(),
			),
		).rejects.toThrow("incomplete or invalid answers");
	},
);

test("requires a provider key before image acquisition", async () => {
	let reads = 0;
	const tool = createDecisionTool({
		store: await store(),
		authorize: allow,
		auth: { storedKey: async () => undefined, env: () => undefined },
		readSource: async () => {
			reads++;
			return png;
		},
	});
	await expect(
		tool.executeRaw(
			JSON.stringify({
				provider: "google",
				images: [{ type: "file", file_path: "input.png" }],
				questions: [questions[0]],
			}),
			createToolContext(),
		),
	).rejects.toThrow("requires an API key");
	expect(reads).toBe(0);
});

test("cancels an in-flight request and rejects oversized responses without retries", async () => {
	let requests = 0;
	const controller = new AbortController();
	const tool = createDecisionTool({
		store: await store(),
		auth,
		authorize: allow,
		fetcher: async (_url, init) => {
			requests++;
			if (requests === 1) {
				controller.abort();
				init?.signal?.throwIfAborted();
			}
			return new Response("x", { headers: { "content-length": "2097153" } });
		},
	});
	const args = JSON.stringify({
		provider: "openai",
		input_text: "x",
		questions: [questions[0]],
	});
	await expect(
		tool.executeRaw(args, {
			...createToolContext(),
			signal: controller.signal,
		}),
	).rejects.toThrow("cancelled");
	await expect(tool.executeRaw(args, createToolContext())).rejects.toThrow(
		"exceeded 2 MiB",
	);
	expect(requests).toBe(2);
});
