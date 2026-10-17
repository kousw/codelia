import type { ProviderName } from "./base";

export type ImageTokenInput = {
	width?: number;
	height?: number;
	detail?: "auto" | "low" | "high";
};
export type ImageTokenEstimate = {
	tokens: number;
	method: "patch" | "tile" | "fallback";
};

/** Local context estimates, not billing counts. See specs/image-generation.md. */
export function estimateImageTokens(
	provider: ProviderName,
	model: string,
	image: ImageTokenInput,
): ImageTokenEstimate {
	let name = model.toLowerCase();
	if (provider === "openrouter") {
		if (name.startsWith("openai/")) provider = "openai";
		else if (name.startsWith("anthropic/")) provider = "anthropic";
		name = name.slice(name.indexOf("/") + 1);
	}
	const width = image.width;
	const height = image.height;
	const dimensionsKnown =
		width !== undefined &&
		height !== undefined &&
		Number.isFinite(width) &&
		Number.isFinite(height) &&
		width > 0 &&
		height > 0;
	const patches = (
		size: number,
		edge: number,
		budget: number,
		multiplier = 1,
	): ImageTokenEstimate => {
		if (!dimensionsKnown)
			return { tokens: Math.ceil(budget * multiplier), method: "fallback" };
		const scale = Math.min(1, edge / Math.max(width, height));
		// Upper estimate after provider resizing; avoids claiming exact rounding parity.
		return {
			tokens: Math.ceil(
				Math.min(
					budget,
					Math.ceil((width * scale) / size) *
						Math.ceil((height * scale) / size),
				) * multiplier,
			),
			method: "patch",
		};
	};
	if (
		provider === "anthropic" &&
		/^claude-((opus|sonnet|haiku)-(4(-[0-8])?|5)(-|$)|3(-[57])?-(opus|sonnet|haiku)(-|$))/.test(
			name,
		)
	) {
		const highResolution = /^claude-(opus|sonnet|haiku)-(4-[78]|5)(-|$)/.test(
			name,
		);
		return patches(
			28,
			highResolution ? 2576 : 1568,
			highResolution ? 4784 : 1568,
		);
	}
	if (provider === "openai") {
		if (
			image.detail === "low" &&
			/^gpt-(6-astra|5\.6-(sol|terra|luna)|5\.5)(-|$)/.test(name)
		)
			return patches(32, 512, 256, 1.2);
		if (/^gpt-6-astra(-|$)/.test(name))
			return patches(32, 65535, image.detail === "high" ? 2500 : 30000, 1.2);
		if (/^gpt-5\.6-(sol|terra|luna)(-|$)/.test(name))
			return patches(
				32,
				image.detail === "high" ? 2048 : 65535,
				image.detail === "high" ? 2500 : 30000,
				1.2,
			);
		if (/^gpt-5\.5(-|$)/.test(name))
			return patches(
				32,
				image.detail === "high" ? 2048 : 6000,
				image.detail === "high" ? 2500 : 10000,
				1.2,
			);
		if (/^gpt-5\.4(-|$)/.test(name))
			return patches(32, 2048, image.detail === "low" ? 6144 : 2500, 1.2);
		if (/^gpt-5\.2(-|$)/.test(name)) return patches(32, 2048, 6144, 1.2);
		if (/^gpt-4\.1-mini(-|$)/.test(name)) return patches(32, 2048, 6144, 1.62);
		if (
			/^(gpt-4o(-mini)?|gpt-4\.1|gpt-5\.1)(-\d{4}-\d{2}-\d{2})?$/.test(name)
		) {
			const mini = name.startsWith("gpt-4o-mini");
			const base = mini ? 2833 : 85;
			const tile = mini ? 5667 : 170;
			if (image.detail === "low") return { tokens: base, method: "tile" };
			if (!dimensionsKnown)
				return { tokens: base + tile * 8, method: "fallback" };
			const fit = Math.min(1, 2048 / Math.max(width, height));
			const shortFit = 768 / (Math.min(width, height) * fit);
			return {
				tokens:
					base +
					tile *
						Math.ceil((width * fit * shortFit) / 512) *
						Math.ceil((height * fit * shortFit) / 512),
				method: "tile",
			};
		}
	}
	// No formula is assumed for arbitrary OpenRouter endpoints, Kimi, GLM or Grok.
	// Observed provider usage supersedes this heuristic after a successful request.
	return { tokens: 10000, method: "fallback" };
}

/** Direct first-party transport limits, not context budgets or OpenRouter promises. */
export function imagePayloadLimit(provider: ProviderName): number | undefined {
	if (provider === "anthropic") return 32_000_000;
	if (provider === "openai") return 512_000_000;
	return undefined;
}
