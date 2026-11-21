import {
	defineTool,
	type Tool,
	type ToolContext,
	ToolPermissionDenied,
	type ToolPermissionHook,
} from "@codelia/core";
import type { ImageArtifactStore } from "@codelia/storage";
import {
	type ImageSourceReader,
	resolveImageSources,
} from "../image-generation/references";
import type { ImageAuthSource } from "../image-generation/route";
import { DECISION_MODELS, runDecision } from "./adapter";
import { DecisionError, type DecisionFetch } from "./http";
import { decisionInputSchema } from "./schema";

export const createDecisionTool = (options: {
	authorize: ToolPermissionHook;
	auth: ImageAuthSource;
	store: ImageArtifactStore;
	readSource?: ImageSourceReader;
	readSourceForContext?: (ctx: ToolContext) => Promise<ImageSourceReader>;
	fetcher?: DecisionFetch;
}): Tool =>
	defineTool({
		name: "decision",
		description:
			"Use the selected OpenAI or Google Decisions API for independent predicate, choice or ordered-score questions over shared text and explicit images; returns estimated probabilities and available confidence/usage for classification, routing or scoring, with API-key billing and no automatic retry or fallback.",
		input: decisionInputSchema,
		execute: async (args, ctx) => {
			const raw = JSON.stringify(args);
			const permission = await options.authorize(
				{
					id: `codelia-decision-${crypto.randomUUID()}`,
					type: "function",
					function: { name: "decision", arguments: raw },
				},
				raw,
				ctx,
			);
			if (permission.decision !== "allow")
				throw new ToolPermissionDenied(permission);
			ctx.signal?.throwIfAborted();
			let key: string | undefined;
			try {
				key =
					(await options.auth.storedKey(args.provider)) ||
					options.auth.env(
						args.provider === "openai" ? "OPENAI_API_KEY" : "GOOGLE_API_KEY",
					) ||
					(args.provider === "google"
						? options.auth.env("GEMINI_API_KEY")
						: undefined);
			} catch {
				throw new DecisionError(
					"Decision API-key lookup failed; no request was attempted.",
				);
			}
			if (!key?.trim())
				throw new DecisionError(
					`${args.provider} Decisions requires an API key; set ${args.provider === "openai" ? "OPENAI_API_KEY" : "GOOGLE_API_KEY or GEMINI_API_KEY"}. No OAuth fallback or request was attempted.`,
				);
			let images: Awaited<ReturnType<typeof resolveImageSources>>;
			try {
				images = await resolveImageSources(
					args.images ?? [],
					options.store,
					(await options.readSourceForContext?.(ctx)) ?? options.readSource,
					ctx.signal,
				);
			} catch {
				if (ctx.signal?.aborted)
					throw new DecisionError(
						"Decision image acquisition was cancelled; no API request was attempted.",
					);
				throw new DecisionError(
					"A decision image could not be read or validated; no API request was attempted.",
				);
			}
			if (
				images.reduce((total, image) => total + image.bytes.length, 0) >
				16 * 1024 * 1024
			)
				throw new DecisionError(
					"Decision images exceed the 16 MiB combined limit; no API request was attempted.",
				);
			ctx.signal?.throwIfAborted();
			return {
				type: "json" as const,
				value: await runDecision(
					args,
					images,
					key,
					ctx.signal,
					options.fetcher,
				),
			};
		},
	});

export { DECISION_MODELS };
