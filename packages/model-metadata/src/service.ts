import type { ModelMetadataService } from "@codelia/core";
import { ModelDevSource, type ModelDevSourceOptions } from "./sources/modeldev";
import type { ModelEntry, ModelMetadataSource } from "./types";

export class ModelMetadataServiceImpl implements ModelMetadataService {
	private readonly modelDevSource: ModelDevSource;
	private readonly sources: ModelMetadataSource[];

	constructor(options: ModelDevSourceOptions = {}) {
		this.modelDevSource = new ModelDevSource(options);
		this.sources = [this.modelDevSource];
	}

	async refreshAllModelEntries(): Promise<
		Record<string, Record<string, ModelEntry>>
	> {
		await this.modelDevSource.loadModelMetadata({ forceRefresh: true });
		return this.getAllModelEntries();
	}

	async getModelEntry(
		provider: string,
		model: string,
	): Promise<ModelEntry | null> {
		for (const source of this.sources) {
			const entry = await source.getModelEntry(provider, model);
			if (entry) {
				return entry;
			}
		}
		return null;
	}

	async getModelEntries(provider: string): Promise<ModelEntry[] | null> {
		for (const source of this.sources) {
			const entries = await source.getModelEntries(provider);
			if (entries) {
				return entries;
			}
		}
		return null;
	}

	async getAllModelEntries(): Promise<
		Record<string, Record<string, ModelEntry>>
	> {
		const entries: Record<string, Record<string, ModelEntry>> = {};
		for (const source of this.sources) {
			const sourceEntries = await source.getAllModelEntries();
			Object.assign(entries, sourceEntries);
		}
		return entries;
	}
}
