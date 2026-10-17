/** Named HTTP Responses endpoints. This module is pure config validation. */
export type ResponsesModelConfig = {
	context_window: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	supports_tools?: boolean;
	supports_reasoning?: boolean;
	supports_json_schema?: boolean;
	supports_vision?: boolean;
	reasoning_levels?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
};

export type ResponsesProviderConfig = {
	type: "responses";
	base_url: string;
	api_key_env?: string;
	timeout_ms?: number;
	retry?: "off" | { max_retries: number; base_delay_ms?: number };
	features?: {
		encrypted_reasoning?: boolean;
		reasoning_summary?: "auto" | "concise" | "detailed";
		prompt_cache_key?: boolean;
		session_id_header?: boolean;
		text_verbosity?: boolean;
	};
	models: Record<string, ResponsesModelConfig>;
};

export const BUILTIN_PROVIDER_NAMES = [
	"openai",
	"anthropic",
	"openrouter",
	"google",
	"moonshot",
	"zai",
	"xai",
] as const;

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

export function parseResponsesProviders(
	value: unknown,
	source = "config",
): Record<string, ResponsesProviderConfig> {
	const fail = (field: string): never => {
		throw new Error(`${source}: invalid providers.${field}`);
	};
	if (!record(value)) return fail("(expected object)");
	const keys = (
		entry: Record<string, unknown>,
		allowed: string[],
		field: string,
	) => {
		if (Object.keys(entry).some((key) => !allowed.includes(key))) fail(field);
	};
	const integer = (
		entry: Record<string, unknown>,
		key: string,
		field: string,
		min = 1,
	) => {
		const number = entry[key];
		if (number === undefined) return undefined;
		if (
			typeof number !== "number" ||
			!Number.isSafeInteger(number) ||
			number < min
		)
			fail(`${field}.${key}`);
		return number as number;
	};
	const result: Record<string, ResponsesProviderConfig> = {};
	for (const [name, raw] of Object.entries(value)) {
		if (
			!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) ||
			BUILTIN_PROVIDER_NAMES.some((builtin) => builtin === name) ||
			["__proto__", "constructor", "prototype"].includes(name)
		)
			fail(name);
		if (!record(raw)) return fail(name);
		keys(
			raw,
			[
				"type",
				"base_url",
				"api_key_env",
				"timeout_ms",
				"retry",
				"features",
				"models",
			],
			name,
		);
		if (raw.type !== "responses" || typeof raw.base_url !== "string")
			return fail(name);
		let url: URL;
		try {
			url = new URL(raw.base_url);
		} catch {
			return fail(`${name}.base_url`);
		}
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			fail(`${name}.base_url`);
		if (
			raw.api_key_env !== undefined &&
			(typeof raw.api_key_env !== "string" ||
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.api_key_env))
		)
			fail(`${name}.api_key_env`);
		let retry: ResponsesProviderConfig["retry"];
		if (raw.retry === "off") retry = "off";
		else if (raw.retry !== undefined) {
			if (!record(raw.retry)) return fail(`${name}.retry`);
			keys(raw.retry, ["max_retries", "base_delay_ms"], `${name}.retry`);
			const max = integer(raw.retry, "max_retries", `${name}.retry`, 0);
			if (max === undefined || max > 10)
				return fail(`${name}.retry.max_retries`);
			retry = {
				max_retries: max,
				base_delay_ms: integer(raw.retry, "base_delay_ms", `${name}.retry`, 0),
			};
		}
		let features: ResponsesProviderConfig["features"];
		if (raw.features !== undefined) {
			if (!record(raw.features)) return fail(`${name}.features`);
			keys(
				raw.features,
				[
					"encrypted_reasoning",
					"reasoning_summary",
					"prompt_cache_key",
					"session_id_header",
					"text_verbosity",
				],
				`${name}.features`,
			);
			for (const [key, option] of Object.entries(raw.features)) {
				if (key === "reasoning_summary") {
					if (!["auto", "concise", "detailed"].includes(String(option)))
						fail(`${name}.features.${key}`);
				} else if (typeof option !== "boolean") fail(`${name}.features.${key}`);
			}
			features = { ...raw.features };
		}
		if (!record(raw.models) || !Object.keys(raw.models).length)
			return fail(`${name}.models`);
		const models: ResponsesProviderConfig["models"] = {};
		for (const [id, model] of Object.entries(raw.models)) {
			const field = `${name}.models.${id}`;
			if (
				!id.trim() ||
				id !== id.trim() ||
				id.length > 256 ||
				["__proto__", "constructor", "prototype"].includes(id) ||
				!record(model)
			)
				return fail(field);
			keys(
				model,
				[
					"context_window",
					"max_input_tokens",
					"max_output_tokens",
					"supports_tools",
					"supports_reasoning",
					"supports_json_schema",
					"supports_vision",
					"reasoning_levels",
				],
				field,
			);
			const context = integer(model, "context_window", field);
			if (context === undefined) return fail(`${field}.context_window`);
			const input = integer(model, "max_input_tokens", field);
			const output = integer(model, "max_output_tokens", field);
			if ((input ?? 0) > context || (output ?? 0) > context) fail(field);
			for (const key of [
				"supports_tools",
				"supports_reasoning",
				"supports_json_schema",
				"supports_vision",
			]) {
				if (model[key] !== undefined && typeof model[key] !== "boolean")
					fail(`${field}.${key}`);
			}
			if (
				model.reasoning_levels !== undefined &&
				(!Array.isArray(model.reasoning_levels) ||
					!model.reasoning_levels.length ||
					model.reasoning_levels.some(
						(level) =>
							!["low", "medium", "high", "xhigh", "max"].includes(level),
					) ||
					model.supports_reasoning !== true)
			)
				fail(`${field}.reasoning_levels`);
			models[id] = {
				...model,
				context_window: context,
			} as ResponsesModelConfig;
		}
		result[name] = {
			type: "responses",
			base_url: raw.base_url.replace(/\/+$/, ""),
			models,
			...(raw.api_key_env ? { api_key_env: raw.api_key_env as string } : {}),
			...(raw.timeout_ms !== undefined
				? { timeout_ms: integer(raw, "timeout_ms", name) }
				: {}),
			...(retry !== undefined ? { retry } : {}),
			...(features ? { features } : {}),
		};
	}
	return result;
}
