import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type SessionRecord = {
	type?: unknown;
	ts?: unknown;
	session_id?: unknown;
	input?: unknown;
	model?: unknown;
	event?: unknown;
	output?: unknown;
};

type AtifToolCall = {
	tool_call_id: string;
	function_name: string;
	arguments: Record<string, unknown>;
};

type AtifObservationResult = {
	source_call_id?: string;
	content?: string;
};

type AtifStep = {
	step_id: number;
	timestamp?: string;
	source: "system" | "user" | "agent";
	model_name?: string;
	message: string;
	reasoning_content?: string;
	tool_calls?: AtifToolCall[];
	observation?: { results: AtifObservationResult[] };
	metrics?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		cached_tokens?: number;
		cost_usd?: number;
	};
	extra?: Record<string, unknown>;
};

export type AtifTrajectory = {
	schema_version: "ATIF-v1.6";
	session_id: string;
	agent: {
		name: "codelia";
		version: string;
		model_name?: string;
		extra?: Record<string, unknown>;
	};
	steps: AtifStep[];
	final_metrics?: {
		total_prompt_tokens?: number;
		total_completion_tokens?: number;
		total_cached_tokens?: number;
		total_cost_usd?: number;
		total_steps: number;
	};
	extra?: Record<string, unknown>;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const stringifyContent = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (value == null) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const normalizeTimestamp = (value: unknown): string | undefined => {
	const raw = asString(value);
	if (!raw) return undefined;
	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) return raw;
	return date.toISOString();
};

const extractInputText = (input: unknown): string | undefined => {
	const direct = asRecord(input);
	if (!direct) return asString(input);
	if (direct.type === "text") return asString(direct.text);
	return stringifyContent(direct);
};

const extractModelName = (
	record: SessionRecord | undefined,
): string | undefined => {
	const model = asRecord(record?.model);
	return asString(model?.name) ?? asString(model?.id);
};

const extractSessionId = (
	header: SessionRecord | undefined,
	runStart: SessionRecord | undefined,
	fallbackRunId: string,
): string =>
	asString(header?.session_id) ??
	asString(runStart?.session_id) ??
	asString(asRecord(runStart?.output)?.session_id) ??
	fallbackRunId;

const createStepIdAllocator = () => {
	let next = 1;
	return () => next++;
};

const pushTextStep = (
	steps: AtifStep[],
	nextStepId: () => number,
	source: AtifStep["source"],
	message: string | undefined,
	timestamp?: string,
	extra?: Record<string, unknown>,
) => {
	if (!message?.trim()) return;
	steps.push({
		step_id: nextStepId(),
		...(timestamp ? { timestamp } : {}),
		source,
		message,
		...(extra ? { extra } : {}),
	});
};

const getOrCreateToolStep = (
	steps: AtifStep[],
	nextStepId: () => number,
	callId: string,
	timestamp?: string,
): AtifStep => {
	const existing = steps.find((step) =>
		step.tool_calls?.some((call) => call.tool_call_id === callId),
	);
	if (existing) return existing;
	const step: AtifStep = {
		step_id: nextStepId(),
		...(timestamp ? { timestamp } : {}),
		source: "agent",
		message: "",
		tool_calls: [],
	};
	steps.push(step);
	return step;
};

const extractUsageMetrics = (records: SessionRecord[]) => {
	return records
		.map((record) => asRecord(asRecord(record.output)?.usage))
		.filter((usage): usage is Record<string, unknown> => !!usage)
		.reduce<{
			total_prompt_tokens: number;
			total_completion_tokens: number;
			total_cached_tokens: number;
		}>(
			(acc, usage) => {
				acc.total_prompt_tokens += Number(usage.input_tokens ?? 0);
				acc.total_completion_tokens += Number(usage.output_tokens ?? 0);
				acc.total_cached_tokens += Number(
					usage.input_cached_tokens ??
						asRecord(usage.input_tokens_details)?.cached_tokens ??
						0,
				);
				return acc;
			},
			{
				total_prompt_tokens: 0,
				total_completion_tokens: 0,
				total_cached_tokens: 0,
			},
		);
};

export const sessionRecordsToAtif = (
	records: SessionRecord[],
	runId: string,
): AtifTrajectory => {
	const header = records.find((record) => record.type === "header");
	const runStart = records.find((record) => record.type === "run.start");
	const modelName = extractModelName(header);
	const nextStepId = createStepIdAllocator();
	const steps: AtifStep[] = [];

	pushTextStep(
		steps,
		nextStepId,
		"user",
		extractInputText(asRecord(runStart?.input)),
		normalizeTimestamp(runStart?.ts),
		{ source_record: "run.start" },
	);

	for (const record of records) {
		if (record.type !== "agent.event") continue;
		const event = asRecord(record.event);
		if (!event) continue;
		const timestamp = normalizeTimestamp(record.ts);
		const eventType = asString(event.type);

		if (eventType === "text") {
			pushTextStep(
				steps,
				nextStepId,
				"agent",
				asString(event.content),
				timestamp,
				{ source_record: "agent.event.text" },
			);
			continue;
		}

		if (eventType === "reasoning") {
			const content = asString(event.content);
			if (!content) continue;
			steps.push({
				step_id: nextStepId(),
				...(timestamp ? { timestamp } : {}),
				source: "agent",
				message: "",
				reasoning_content: content,
				extra: { source_record: "agent.event.reasoning" },
			});
			continue;
		}

		if (eventType === "tool_call") {
			const callId =
				asString(event.tool_call_id) ?? `tool_call_${String(steps.length + 1)}`;
			const step = getOrCreateToolStep(steps, nextStepId, callId, timestamp);
			step.tool_calls ??= [];
			step.tool_calls.push({
				tool_call_id: callId,
				function_name: asString(event.tool) ?? "unknown",
				arguments: asRecord(event.args) ?? {},
			});
			continue;
		}

		if (eventType === "tool_result") {
			const callId = asString(event.tool_call_id);
			const step = callId
				? getOrCreateToolStep(steps, nextStepId, callId, timestamp)
				: {
						step_id: nextStepId(),
						...(timestamp ? { timestamp } : {}),
						source: "agent" as const,
						message: "",
					};
			if (!callId) steps.push(step);
			step.observation ??= { results: [] };
			step.observation.results.push({
				...(callId ? { source_call_id: callId } : {}),
				content: stringifyContent(event.result),
			});
			continue;
		}

		if (eventType === "final") {
			pushTextStep(
				steps,
				nextStepId,
				"agent",
				asString(event.content),
				timestamp,
				{ source_record: "agent.event.final" },
			);
		}
	}

	if (steps.length === 0) {
		steps.push({
			step_id: nextStepId(),
			source: "user",
			message: "(no prompt captured)",
			extra: { source_record: "fallback" },
		});
	}

	const usage = extractUsageMetrics(
		records.filter((record) => record.type === "llm.response"),
	);

	return {
		schema_version: "ATIF-v1.6",
		session_id: extractSessionId(header, runStart, runId),
		agent: {
			name: "codelia",
			version: "unknown",
			...(modelName ? { model_name: modelName } : {}),
		},
		steps,
		final_metrics: {
			...usage,
			total_steps: steps.length,
		},
		extra: {
			run_id: runId,
			source: "codelia-session-jsonl",
			conversion: "session-records-to-atif-v1.6",
		},
	};
};

export const parseSessionJsonl = (raw: string): SessionRecord[] => {
	const out: SessionRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as SessionRecord);
		} catch {
			// Ignore malformed lines in partially written logs.
		}
	}
	return out;
};

export const readSessionJsonl = async (
	filePath: string,
): Promise<SessionRecord[]> =>
	parseSessionJsonl(await readFile(filePath, "utf8"));

export const writeAtifFromSessionJsonl = async ({
	sessionLogPath,
	runId,
	outPath,
}: {
	sessionLogPath: string;
	runId: string;
	outPath: string;
}): Promise<AtifTrajectory> => {
	const records = await readSessionJsonl(sessionLogPath);
	const trajectory = sessionRecordsToAtif(records, runId);
	await mkdir(path.dirname(outPath), { recursive: true });
	await writeFile(outPath, `${JSON.stringify(trajectory, null, 2)}\n`, "utf8");
	return trajectory;
};
