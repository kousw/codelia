import type { BaseChatModel, ModelRegistry } from "@codelia/core";
import { applyModelMetadata, DEFAULT_MODEL_REGISTRY } from "@codelia/core";
import { ModelMetadataServiceImpl } from "@codelia/model-metadata";
import { StoragePathServiceImpl } from "@codelia/storage";

export const buildModelRegistry = async (
	llm: BaseChatModel,
): Promise<ModelRegistry> => {
	const metadataService = new ModelMetadataServiceImpl({
		storagePathService: new StoragePathServiceImpl(),
	});
	let entries = await metadataService.getAllModelEntries();
	let providerEntries = entries[llm.provider];
	let directEntry = providerEntries?.[llm.model];
	let fullIdEntry = providerEntries?.[`${llm.provider}/${llm.model}`];
	if (!directEntry && !fullIdEntry) {
		entries = await metadataService.refreshAllModelEntries();
		providerEntries = entries[llm.provider];
		directEntry = providerEntries?.[llm.model];
		fullIdEntry = providerEntries?.[`${llm.provider}/${llm.model}`];
	}
	if (!directEntry && !fullIdEntry) {
		throw new Error(
			`Model metadata not found for ${llm.provider}/${llm.model} after refresh`,
		);
	}
	return applyModelMetadata(DEFAULT_MODEL_REGISTRY, { models: entries });
};
