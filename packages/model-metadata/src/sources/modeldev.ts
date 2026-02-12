import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StoragePathService } from "@codelia/core";
import { resolveStoragePaths } from "@codelia/storage";
import { z } from "zod";
import type { ModelEntry, ModelMetadataSource } from "../types";

const modelResourceUrl = "https://models.dev/api.json";
const CACHE_FILENAME = "models.dev.json";
const CACHE_VERSION = 1;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 modeldev response example
 "id": "privatemode-ai",
"name": "Privatemode AI",
"api": "http://localhost:8080/v1",
"doc": "https://docs.privatemode.ai/api/overview",
"env": ["PRIVATEMODE_API_KEY", "PRIVATEMODE_ENDPOINT"],
"npm": "@ai-sdk/openai-compatible",
"models": {
  "whisper-large-v3": {
    "id": "whisper-large-v3",
    "name": "Whisper large-v3",
    "family": "whisper",
    "modalities": { "input": ["audio"], "output": ["text"] },
    "reasoning": false,
    "tool_call": false,
    "structured_output": false,
    "temperature": true,
    "open_weights": true,
    "limit": { "context": 0, "output": 4096 },
    "cost": { "input": 0, "output": 0 }
  }
} */
export type WireModelDevModel = {
	id: string;
	name: string;
	family?: string;
	attachment?: boolean;
	reasoning?: boolean;
	tool_call?: boolean;
	structured_output?: boolean;
	temperature?: boolean;
	knowledge?: string;
	release_date?: string;
	last_updated?: string;
	open_weights?: boolean;
	cost?: {
		input?: number;
		output?: number;
		reasoning?: number;
		cache_read?: number;
		cache_write?: number;
		input_audio?: number;
		output_audio?: number;
	};
	limit?: {
		context?: number;
		input?: number;
		output?: number;
	};
	modalities?: { input?: string[]; output?: string[] };
	interleaved?: boolean | { field?: string };
};

export type WireModelDevProvider = {
	id?: string;
	name?: string;
	api?: string;
	doc?: string;
	env?: string[];
	npm?: string;
	models?: Record<string, WireModelDevModel>;
};

export type ModelDevSourceOptions = {
	cacheTtlMs?: number;
	cachePath?: string;
	storageRoot?: string;
	storagePathService?: StoragePathService;
};

type ModelMetadataCacheFile = {
	version: typeof CACHE_VERSION;
	cachedAt: string;
	expiresAt: string;
	entries: Record<string, Record<string, ModelEntry>>;
};

export const wireModelDevModelSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		family: z.string().optional(),
		attachment: z.boolean().optional(),
		reasoning: z.boolean().optional(),
		tool_call: z.boolean().optional(),
		structured_output: z.boolean().optional(),
		temperature: z.boolean().optional(),
		knowledge: z.string().optional(),
		release_date: z.string().optional(),
		last_updated: z.string().optional(),
		open_weights: z.boolean().optional(),
		cost: z
			.object({
				input: z.number().optional(),
				output: z.number().optional(),
				reasoning: z.number().optional(),
				cache_read: z.number().optional(),
				cache_write: z.number().optional(),
				input_audio: z.number().optional(),
				output_audio: z.number().optional(),
			})
			.loose()
			.optional(),
		limit: z
			.object({
				context: z.number().optional(),
				input: z.number().optional(),
				output: z.number().optional(),
			})
			.loose()
			.optional(),
		modalities: z
			.object({
				input: z.array(z.string()).optional(),
				output: z.array(z.string()).optional(),
			})
			.loose()
			.optional(),
		interleaved: z
			.union([
				z.boolean(),
				z
					.object({
						field: z.string().optional(),
					})
					.loose(),
			])
			.optional(),
	})
	.loose();

export const wireModelDevModelsSchema = z.union([
	z.array(wireModelDevModelSchema),
	z.record(z.string(), wireModelDevModelSchema),
]);

export const wireModelDevProviderSchema = z
	.object({
		id: z.string().optional(),
		name: z.string().optional(),
		api: z.string().optional(),
		doc: z.string().optional(),
		env: z.array(z.string()).optional(),
		npm: z.string().optional(),
		models: z.record(z.string(), wireModelDevModelSchema).optional(),
	})
	.loose();

export const wireModelDevProvidersSchema = z.record(
	z.string(),
	wireModelDevProviderSchema,
);

export class ModelDevSource implements ModelMetadataSource {
	private loaded = false;
	private models: Record<string, Record<string, ModelEntry>> = {};
	private readonly cacheTtlMs: number;
	private readonly cachePath: string;

	constructor(options: ModelDevSourceOptions = {}) {
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		const storagePaths = options.storagePathService
			? options.storagePathService.resolvePaths({
					rootOverride: options.storageRoot,
				})
			: resolveStoragePaths({ rootOverride: options.storageRoot });
		this.cachePath =
			options.cachePath ?? path.join(storagePaths.cacheDir, CACHE_FILENAME);
	}

	async loadModelMetadata(
		options: { forceRefresh?: boolean } = {},
	): Promise<void> {
		this.loaded = false;
		this.models = {};

		if (!options.forceRefresh) {
			const cached = await readCacheFile(this.cachePath);
			if (cached && !isCacheExpired(cached.expiresAt)) {
				this.models = cached.entries;
				this.loaded = true;
				return;
			}
		}

		const response = await fetch(modelResourceUrl);
		const data = await response.json();

		const providersResult = wireModelDevProvidersSchema.safeParse(data);
		if (providersResult.success) {
			this.models = buildEntriesFromProviders(providersResult.data);
		}

		let hasEntries = Object.keys(this.models).length > 0;
		if (!hasEntries) {
			this.models = buildEntriesFromLegacyPayload(data);
		}

		hasEntries = Object.keys(this.models).length > 0;
		if (!hasEntries) {
			throw new Error("ModelDevSource: empty metadata payload");
		}

		await writeCacheFile(this.cachePath, {
			version: CACHE_VERSION,
			cachedAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + this.cacheTtlMs).toISOString(),
			entries: this.models,
		}).catch(() => undefined);

		this.loaded = true;
	}

	async getModelEntry(
		provider: string,
		model: string,
	): Promise<ModelEntry | null> {
		if (!this.loaded) {
			await this.loadModelMetadata();
		}
		return this.models[provider]?.[model] || null;
	}

	async getModelEntries(provider: string): Promise<ModelEntry[] | null> {
		if (!this.loaded) {
			await this.loadModelMetadata();
		}
		return this.models[provider] ? Object.values(this.models[provider]) : null;
	}

	async getAllModelEntries(): Promise<
		Record<string, Record<string, ModelEntry>>
	> {
		if (!this.loaded) {
			await this.loadModelMetadata();
		}
		return this.models;
	}
}

function buildEntriesFromProviders(
	providers: Record<string, WireModelDevProvider>,
): Record<string, Record<string, ModelEntry>> {
	const entries: Record<string, Record<string, ModelEntry>> = {};
	for (const [providerId, provider] of Object.entries(providers)) {
		const models = provider.models ? Object.values(provider.models) : [];
		if (models.length === 0) continue;
		entries[providerId] = buildEntriesForProvider(providerId, models);
	}
	return entries;
}

function buildEntriesFromLegacyPayload(
	data: Record<string, unknown>,
): Record<string, Record<string, ModelEntry>> {
	let provider = "unknown";
	if (data.provider && typeof data.provider === "object") {
		const name = (data.provider as { name?: string }).name;
		if (name) provider = name;
	}
	const modelsResult = wireModelDevModelsSchema.safeParse(
		(data as { models?: unknown }).models,
	);
	if (!modelsResult.success) return {};
	const models = Array.isArray(modelsResult.data)
		? modelsResult.data
		: Object.values(modelsResult.data);
	if (models.length === 0) return {};
	return { [provider]: buildEntriesForProvider(provider, models) };
}

function buildEntriesForProvider(
	provider: string,
	models: WireModelDevModel[],
): Record<string, ModelEntry> {
	const entries: Record<string, ModelEntry> = {};
	for (const model of models) {
		entries[model.id] = {
			provider,
			modelId: model.id,
			releaseDate: model.release_date,
			lastUpdated: model.last_updated,
			cost: {
				input: model.cost?.input,
				output: model.cost?.output,
				reasoning: model.cost?.reasoning,
				cacheRead: model.cost?.cache_read,
				cacheWrite: model.cost?.cache_write,
				inputAudio: model.cost?.input_audio,
				outputAudio: model.cost?.output_audio,
			},
			limits: {
				contextWindow: model.limit?.context,
				inputTokens: model.limit?.input,
				outputTokens: model.limit?.output,
			},
		};
	}
	return entries;
}

async function readCacheFile(
	cachePath: string,
): Promise<ModelMetadataCacheFile | null> {
	const contents = await readFile(cachePath, "utf8").catch(() => null);
	if (!contents) return null;
	const parsed = safeJsonParse(contents);
	if (!parsed || !isCacheFile(parsed)) return null;
	return parsed;
}

async function writeCacheFile(
	cachePath: string,
	cache: ModelMetadataCacheFile,
): Promise<void> {
	await ensureDir(path.dirname(cachePath));
	await writeFile(cachePath, JSON.stringify(cache), "utf8");
}

function isCacheExpired(expiresAt: string): boolean {
	const timestamp = Date.parse(expiresAt);
	if (Number.isNaN(timestamp)) return true;
	return timestamp <= Date.now();
}

function isCacheFile(value: unknown): value is ModelMetadataCacheFile {
	if (!value || typeof value !== "object") return false;
	const file = value as ModelMetadataCacheFile;
	if (file.version !== CACHE_VERSION) return false;
	if (typeof file.cachedAt !== "string") return false;
	if (typeof file.expiresAt !== "string") return false;
	if (!file.entries || typeof file.entries !== "object") return false;
	return true;
}

function safeJsonParse(value: string): unknown | null {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}
