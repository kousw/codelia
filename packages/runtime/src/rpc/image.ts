import {
	GOOGLE_IMAGE_MODELS,
	type ImageGenerationConfig,
	OPENAI_CODEX_IMAGE_MODELS,
	OPENAI_IMAGE_MODELS,
	parseImageGenerationConfig,
} from "@codelia/config";
import {
	type ImageArtifactGetResult,
	type ImageModelStatus,
	RPC_ERROR_CODE,
} from "@codelia/protocol";
import { AuthStore, getChatProviderAuth } from "../auth/store";
import { resolveImageGenerationConfig, updateImageGeneration } from "../config";
import { resolveEffectiveModelConfig } from "../effective-model";
import { isTuiLocalEnvironment } from "../environment";
import { ImageCatalog } from "../image-generation/catalog";
import { ImageGenerationError } from "../image-generation/http";
import { createLocalImageStore } from "../image-generation/local-store";
import {
	type ImageChatConnection,
	localImageAuth,
	resolveImageRoute,
} from "../image-generation/route";
import type { RuntimeState } from "../runtime-state";
import { parseRequestParams, sendRequestResult } from "./protocol";
import { sendError } from "./transport";
import { requestUiConfirm, requestUiPick } from "./ui-requests";

export function createImageHandlers(state: RuntimeState) {
	const catalog = new ImageCatalog();
	let configuring = false;
	const workspace = () => {
		const env = state.effectiveEnvironment;
		if (!isTuiLocalEnvironment(env))
			throw new ImageGenerationError(
				"Image services are unavailable in this embedding environment.",
			);
		return (
			env.workspace.root ??
			state.runtimeSandboxRoot ??
			state.runtimeWorkingDir ??
			process.cwd()
		);
	};
	const currentChat = async (): Promise<ImageChatConnection | undefined> => {
		const model = await resolveEffectiveModelConfig(state, workspace());
		const provider = model.provider ?? state.currentModelProvider ?? "openai";
		const saved = getChatProviderAuth(await new AuthStore().loadV2(), provider);
		if (saved) return { provider, auth: saved };
		const key =
			provider === "openai" ? localImageAuth.env("OPENAI_API_KEY") : undefined;
		return key
			? { provider, auth: { method: "api_key", api_key: key } }
			: undefined;
	};
	const status = async (
		config: ImageGenerationConfig,
	): Promise<ImageModelStatus> => {
		try {
			const chat = config.mode === "builtin" ? await currentChat() : undefined;
			const route = await resolveImageRoute(config, localImageAuth, chat);
			if (!route)
				return {
					requested_mode: config.mode,
					state: "disabled",
					message: "Image generation is off. Conversation model is unchanged.",
				};
			if (
				route.provider === "openrouter" &&
				!(await catalog.endpoints(route.model)).some(
					(e) => e.provider_tag === route.endpoint,
				)
			)
				throw new ImageGenerationError(
					"Selected image endpoint is unavailable; select another explicitly.",
				);
			return {
				requested_mode: config.mode,
				state: "available",
				provider: route.provider,
				requested_model: route.model,
				endpoint: route.endpoint,
				auth_mode: route.authMode,
				message: `Image generation: ${config.mode} / ${route.provider} / ${route.model}. ${route.authMode === "codex_oauth" ? "Uses the current Codex OAuth login; no API key required. Account image usage/limits apply." : "Chargeable public Image API using an API key."} Account/model access and cost are not proven by selection. ${route.provider === "google" ? "PNG/JPEG returned originals" : "PNG output"} (32 MiB/12288px/20 MP); unsupported outputs are rejected, possibly after usage is consumed. No automatic fallback. Conversation model is unchanged.`,
			};
		} catch (error) {
			return {
				requested_mode: config.mode,
				state: "unavailable",
				message:
					error instanceof ImageGenerationError
						? error.message
						: "Image configuration/auth unavailable; chat is unchanged.",
			};
		}
	};
	const pick = async (
		title: string,
		items: Array<{ id: string; label: string; detail?: string }>,
	) => {
		const result = await requestUiPick(state, { title, items });
		const selected = result?.ids[0];
		return items.some((i) => i.id === selected) ? selected : undefined;
	};
	const choose = async (): Promise<ImageGenerationConfig | null> => {
		if (!state.uiCapabilities?.supports_pick)
			throw new ImageGenerationError(
				"This client cannot open the image picker. Supply explicit mode/provider/model settings.",
			);
		const mode = await pick(
			"Image generation (separate from conversation model)",
			[
				{
					id: "off",
					label: "Off",
					detail: "No image generation or image API spending",
				},
				{
					id: "builtin",
					label: "Builtin: current conversation connection",
					detail:
						"Use current OpenAI login: Codex OAuth or API key; no authentication switch",
				},
				{
					id: "custom",
					label: "Custom: independent image provider/model",
					detail: "API key required; does not change chat authentication",
				},
			],
		);
		if (!mode) return null;
		if (mode === "off") return { mode };
		const provider =
			mode === "builtin"
				? "openai"
				: await pick("Image API provider", [
						{ id: "openai", label: "OpenAI Image API" },
						{ id: "openrouter", label: "OpenRouter Image API" },
						{ id: "google", label: "Google Gemini image API" },
					]);
		if (!provider) return null;
		let model: string | undefined;
		let endpoint: string | undefined;
		let googleOptions: Record<string, string> | undefined;
		if (provider === "openai") {
			const chat = mode === "builtin" ? await currentChat() : undefined;
			if (mode === "builtin" && chat?.provider !== "openai")
				throw new ImageGenerationError(
					"Builtin images require an OpenAI conversation login. Sign in first; no API key is required for Codex OAuth.",
				);
			const codex = chat?.auth.method === "oauth";
			model = await pick(
				codex
					? "Codex OAuth image model (current login; account-specific limits)"
					: "Image model (API billed; availability is account-specific)",
				(codex ? OPENAI_CODEX_IMAGE_MODELS : OPENAI_IMAGE_MODELS).map((id) => ({
					id,
					label: id,
					...(codex
						? {
								detail:
									id === "gpt-image-2"
										? "Inspected Codex tool default"
										: "Explicit request; support/effective model depends on the Codex backend",
							}
						: {}),
				})),
			);
		} else if (provider === "google") {
			model = await pick(
				"Gemini image model",
				GOOGLE_IMAGE_MODELS.map((id) => ({ id, label: id })),
			);
			if (!model) return null;
			const image_size = await pick(
				"Image size",
				(model === "gemini-3.1-flash-lite-image"
					? ["1K"]
					: ["1K", "2K", "4K"]
				).map((id) => ({ id, label: id })),
			);
			if (!image_size) return null;
			const aspect_ratio = await pick(
				"Image aspect ratio",
				[
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
					...(model === "gemini-nano-banana-2.1"
						? ["1:4", "4:1", "1:8", "8:1"]
						: []),
				].map((id) => ({ id, label: id })),
			);
			if (!aspect_ratio) return null;
			const format = await pick("Image output format", [
				{
					id: "default",
					label: "Google default (returned PNG or JPEG is preserved)",
				},
				{ id: "jpeg", label: "Request JPEG" },
			]);
			if (!format) return null;
			googleOptions = {
				image_size,
				aspect_ratio,
				...(format === "jpeg" ? { output_format: "jpeg" } : {}),
			};
		} else {
			const listing = await catalog.list();
			model = await pick(
				`OpenRouter image models (${listing.stale ? "stale" : "fetched"} ${listing.fetched_at})`,
				listing.models.map((m) => ({ id: m.id, label: m.name, detail: m.id })),
			);
			if (!model) return null;
			const endpoints = await catalog.endpoints(model);
			if (!endpoints.length)
				throw new ImageGenerationError(
					"This model has no supported pin-able PNG endpoint. Choose another image model.",
				);
			endpoint = await pick(
				"Pin image endpoint (no fallback)",
				endpoints.flatMap((e) =>
					e.provider_tag ? [{ id: e.provider_tag, label: e.provider_tag }] : [],
				),
			);
			if (!endpoint) return null;
		}
		if (!model) return null;
		return parseImageGenerationConfig(
			mode === "builtin"
				? { mode, provider_options: { openai: { model } } }
				: {
						mode,
						provider,
						model,
						...(endpoint
							? { provider_options: { openrouter: { endpoint } } }
							: googleOptions
								? { provider_options: { google: googleOptions } }
								: {}),
					},
		);
	};
	const handle = async (
		id: string,
		operation: "get" | "configure" | "artifact",
		params: unknown,
	) => {
		let ownsConfiguration = false;
		try {
			const root = workspace();
			if (operation === "artifact") {
				const parsed = parseRequestParams("image.artifact.get", params);
				if (!parsed.ok) return sendError(id, parsed.error);
				const { artifact_id: artifactId } = parsed.params;
				if (!/^codelia-image-[0-9a-f-]{36}$/.test(artifactId))
					throw new ImageGenerationError("Invalid image artifact request.");
				const { metadata, bytes } = await createLocalImageStore(
					root,
					() => state.sessionId,
				).read(artifactId);
				sendRequestResult("image.artifact.get", id, {
					metadata,
					data_url: `data:${metadata.media_type};base64,${bytes.toString("base64")}`,
				} satisfies ImageArtifactGetResult);
				return;
			}
			if (operation === "get") {
				const parsed = parseRequestParams("image.model.get", params);
				if (!parsed.ok) return sendError(id, parsed.error);
				sendRequestResult(
					"image.model.get",
					id,
					await status(await resolveImageGenerationConfig(root)),
				);
				return;
			}
			if (state.activeRunId || configuring)
				throw new ImageGenerationError(
					"Wait for the active run or image settings dialog before changing image settings.",
				);
			configuring = true;
			ownsConfiguration = true;
			const catalogParams = parseRequestParams("image.model.configure", params);
			if (!catalogParams.ok) {
				sendError(id, catalogParams.error);
				return;
			}
			const p = catalogParams.params;
			if (
				(p.model?.length ?? 0) > 160 ||
				(p.endpoint?.length ?? 0) > 160 ||
				(p.api_key_env?.length ?? 0) > 128 ||
				(p.aspect_ratio?.length ?? 0) > 8
			)
				throw new ImageGenerationError("Invalid image model settings.");
			if (
				(p.provider === "google" && p.endpoint) ||
				(p.provider !== "google" &&
					(p.image_size || p.aspect_ratio || p.output_format))
			)
				throw new ImageGenerationError(
					"Image settings do not match the selected provider.",
				);
			let config: ImageGenerationConfig | null;
			if (p.mode) {
				if (
					p.mode !== "custom" &&
					(p.provider ||
						p.endpoint ||
						p.api_key_env ||
						p.image_size ||
						p.aspect_ratio ||
						p.output_format)
				)
					throw new ImageGenerationError(
						"Provider, endpoint and api_key_env are custom-only.",
					);
				config = parseImageGenerationConfig(
					p.mode === "off"
						? { mode: p.mode, ...(p.model ? { model: p.model } : {}) }
						: p.mode === "builtin"
							? {
									mode: p.mode,
									...(p.model
										? { provider_options: { openai: { model: p.model } } }
										: {}),
								}
							: {
									mode: p.mode,
									provider: p.provider,
									model: p.model,
									...(p.api_key_env ? { api_key_env: p.api_key_env } : {}),
									...(p.endpoint
										? {
												provider_options: {
													openrouter: { endpoint: p.endpoint },
												},
											}
										: p.provider === "google" &&
												(p.image_size || p.aspect_ratio || p.output_format)
											? {
													provider_options: {
														google: {
															...(p.image_size
																? { image_size: p.image_size }
																: {}),
															...(p.aspect_ratio
																? { aspect_ratio: p.aspect_ratio }
																: {}),
															...(p.output_format
																? { output_format: p.output_format }
																: {}),
														},
													},
												}
											: {}),
								},
				);
			} else {
				if (Object.keys(p).length)
					throw new ImageGenerationError(
						"mode is required for explicit image settings.",
					);
				config = await choose();
			}
			if (!config) {
				sendRequestResult("image.model.configure", id, {
					message: "Image settings unchanged.",
				});
				return;
			}
			const next = await status(config);
			if (config.mode !== "off") {
				if (!state.uiCapabilities?.supports_confirm)
					throw new ImageGenerationError(
						"Image route changes require a confirmation-capable UI; headless users can explicitly edit image_generation in config.json.",
					);
				const confirm = await requestUiConfirm(state, {
					title: "Save image generation route?",
					message: `${next.message}\nThis saves image settings only; generation requests use the tool permission policy. ${next.auth_mode === "codex_oauth" ? "Uses your existing OpenAI login; no API key setup is needed." : config.mode === "custom" ? "Missing API keys must be supplied in the runtime environment." : "If login is missing, sign in to OpenAI first."}`,
					confirm_label: "Save",
					cancel_label: "Cancel",
				});
				if (!confirm?.ok) {
					sendRequestResult("image.model.configure", id, {
						message: "Image settings unchanged.",
					});
					return;
				}
			}
			if (state.activeRunId)
				throw new ImageGenerationError(
					"A run started; image settings were not changed. Try again after it finishes.",
				);
			const target = await updateImageGeneration(root, config);
			state.agent = null;
			state.tools = null;
			state.toolDefinitions = null;
			const scope = target.scope === "project" ? "project" : "user";
			sendRequestResult("image.model.configure", id, {
				...next,
				message: `${next.message}\nSaved to ${scope} settings.`,
			});
		} catch (error) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message:
					error instanceof ImageGenerationError
						? error.message
						: "Image operation failed; check settings, artifact and runtime storage. No credentials were changed.",
			});
		} finally {
			if (ownsConfiguration) configuring = false;
		}
	};
	return { handle };
}
