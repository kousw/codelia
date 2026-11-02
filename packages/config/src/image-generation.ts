export const OPENAI_IMAGE_MODELS = [
	"gpt-image-2.5-sunburst",
	"gpt-image-2.5-flare",
] as const;

// The inspected Codex tool defaults to gpt-image-2; public API defaults stay separate.
export const OPENAI_CODEX_IMAGE_MODELS = [
	"gpt-image-2",
	...OPENAI_IMAGE_MODELS,
] as const;
export const GOOGLE_IMAGE_MODELS = [
	"gemini-nano-banana-2.1",
	"gemini-3.1-flash-lite-image",
	"gemini-3-pro-image",
] as const;

export type OpenAiImageOptions = {
	model?: string;
	quality?: "auto" | "low" | "medium" | "high";
	size?: "auto" | "1024x1024" | "1536x1024" | "1024x1536";
};
export type OpenRouterImageOptions = {
	endpoint?: string;
	quality?: "auto" | "low" | "medium" | "high";
	resolution?: "512" | "1K" | "2K" | "4K";
	aspect_ratio?: string;
};
export type GoogleImageOptions = {
	image_size?: "1K" | "2K" | "4K";
	aspect_ratio?:
		| "1:1"
		| "2:3"
		| "3:2"
		| "3:4"
		| "4:3"
		| "4:5"
		| "5:4"
		| "9:16"
		| "16:9"
		| "21:9"
		| "1:8"
		| "8:1"
		| "1:4"
		| "4:1";
	output_format?: "jpeg";
};
export type ImageProviderOptions = {
	openai?: OpenAiImageOptions;
	openrouter?: OpenRouterImageOptions;
	google?: GoogleImageOptions;
};
export type ImageGenerationConfig =
	| { mode: "off" }
	| { mode: "builtin"; provider_options?: ImageProviderOptions }
	| {
			mode: "custom";
			provider: "openai" | "openrouter" | "google";
			model: string;
			api_key_env?: string;
			provider_options?: ImageProviderOptions;
	  };

const object = (v: unknown): Record<string, unknown> => {
	if (!v || typeof v !== "object" || Array.isArray(v)) invalid();
	return v as Record<string, unknown>;
};
const invalid = (): never => {
	throw new Error(
		"Invalid image_generation configuration; check mode, provider, model and allowed options (never put credentials here).",
	);
};
const keys = (v: Record<string, unknown>, allowed: string[]) => {
	if (Object.keys(v).some((key) => !allowed.includes(key))) invalid();
};
const choice = <const T extends string>(
	v: unknown,
	allowed: readonly T[],
): T => {
	if (typeof v !== "string" || !allowed.includes(v as T)) invalid();
	return v as T;
};
const id = (v: unknown): string => {
	if (
		typeof v !== "string" ||
		v.length > 160 ||
		!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(v) ||
		v.includes("://")
	)
		invalid();
	return v as string;
};

/** Strict and atomic: malformed configuration must never silently enable a route. */
export const parseImageGenerationConfig = (
	value: unknown,
): ImageGenerationConfig => {
	const v = object(value);
	const mode = choice(v.mode, ["off", "builtin", "custom"]);
	keys(
		v,
		mode === "off"
			? ["mode"]
			: mode === "builtin"
				? ["mode", "provider_options"]
				: ["mode", "provider", "model", "api_key_env", "provider_options"],
	);
	if (mode === "off") return { mode };
	const options: ImageProviderOptions = {};
	if (v.provider_options !== undefined) {
		const p = object(v.provider_options);
		keys(p, ["openai", "openrouter", "google"]);
		if (p.google !== undefined) {
			const o = object(p.google);
			keys(o, ["image_size", "aspect_ratio", "output_format"]);
			options.google = {
				...(o.image_size !== undefined
					? { image_size: choice(o.image_size, ["1K", "2K", "4K"]) }
					: {}),
				...(o.aspect_ratio !== undefined
					? {
							aspect_ratio: choice(o.aspect_ratio, [
								"1:1",
								"2:3",
								"3:2",
								"3:4",
								"4:3",
								"4:5",
								"5:4",
								"9:16",
								"16:9",
								"21:9",
								"1:8",
								"8:1",
								"1:4",
								"4:1",
							]),
						}
					: {}),
				...(o.output_format !== undefined
					? { output_format: choice(o.output_format, ["jpeg"]) }
					: {}),
			};
		}
		if (p.openai !== undefined) {
			const o = object(p.openai);
			keys(o, ["model", "size", "quality"]);
			options.openai = {
				...(o.model !== undefined
					? { model: choice(o.model, OPENAI_CODEX_IMAGE_MODELS) }
					: {}),
				...(o.size !== undefined
					? {
							size: choice(o.size, [
								"auto",
								"1024x1024",
								"1536x1024",
								"1024x1536",
							]),
						}
					: {}),
				...(o.quality !== undefined
					? { quality: choice(o.quality, ["auto", "low", "medium", "high"]) }
					: {}),
			};
		}
		if (p.openrouter !== undefined) {
			const o = object(p.openrouter);
			keys(o, ["endpoint", "quality", "resolution", "aspect_ratio"]);
			if (
				o.aspect_ratio !== undefined &&
				(typeof o.aspect_ratio !== "string" ||
					!/^(auto|[1-9][0-9]?:[1-9][0-9]?)$/.test(o.aspect_ratio))
			)
				invalid();
			options.openrouter = {
				...(o.endpoint !== undefined ? { endpoint: id(o.endpoint) } : {}),
				...(o.quality !== undefined
					? { quality: choice(o.quality, ["auto", "low", "medium", "high"]) }
					: {}),
				...(o.resolution !== undefined
					? { resolution: choice(o.resolution, ["512", "1K", "2K", "4K"]) }
					: {}),
				...(typeof o.aspect_ratio === "string"
					? { aspect_ratio: o.aspect_ratio }
					: {}),
			};
		}
	}
	const common =
		v.provider_options !== undefined ? { provider_options: options } : {};
	if (mode === "builtin") return { mode, ...common };
	const provider = choice(v.provider, ["openai", "openrouter", "google"]);
	const model =
		provider === "openai"
			? choice(v.model, OPENAI_IMAGE_MODELS)
			: provider === "google"
				? choice(v.model, GOOGLE_IMAGE_MODELS)
				: id(v.model);
	if (provider === "openai" && options.openai?.model !== undefined) invalid();
	if (
		(provider !== "google" && options.google !== undefined) ||
		(provider === "google" &&
			(options.openai !== undefined || options.openrouter !== undefined))
	)
		invalid();
	if (
		provider === "google" &&
		model === "gemini-3.1-flash-lite-image" &&
		options.google?.image_size &&
		options.google.image_size !== "1K"
	)
		invalid();
	if (
		provider === "google" &&
		model !== "gemini-nano-banana-2.1" &&
		["1:8", "8:1", "1:4", "4:1"].includes(options.google?.aspect_ratio ?? "")
	)
		invalid();
	if (
		v.api_key_env !== undefined &&
		(typeof v.api_key_env !== "string" ||
			!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(v.api_key_env))
	)
		invalid();
	return {
		mode,
		provider,
		model,
		...common,
		...(typeof v.api_key_env === "string"
			? { api_key_env: v.api_key_env }
			: {}),
	};
};
