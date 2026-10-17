import type { ImageArtifactMetadata } from "@codelia/shared-types";

export type ImageModelConfigureParams = {
	mode?: "off" | "builtin" | "custom";
	provider?: "openai" | "openrouter";
	model?: string;
	endpoint?: string;
	api_key_env?: string;
};
export type ImageModelStatus = {
	auth_mode?: "api_key" | "codex_oauth";
	requested_mode: "off" | "builtin" | "custom";
	state: "disabled" | "available" | "unavailable";
	message: string;
	provider?: string;
	requested_model?: string;
	endpoint?: string;
};
export type ImageArtifactGetParams = { artifact_id: string };
export type ImageArtifactGetResult = {
	metadata: ImageArtifactMetadata;
	/** Bounded inline PNG for local/SSH clients; never a runtime-host path. */
	data_url: string;
};
