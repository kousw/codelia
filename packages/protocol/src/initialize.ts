import type { ServerCapabilities, UiCapabilities } from "./capabilities";
import type { SandboxModeInfo } from "./permissions";
import type { ProtocolVersion } from "./version";

export type InitializeParams = {
	protocol_version: ProtocolVersion;
	client: { name: string; version: string };
	ui_capabilities?: UiCapabilities;
};

export type InitializeResult = {
	model_providers?: string[];
	protocol_version: ProtocolVersion;
	server: { name: string; version: string };
	server_capabilities?: ServerCapabilities;
	sandbox_mode?: SandboxModeInfo;
	shell_sandbox_issue?: "windows_native_unqualified";
	tui?: {
		theme?: string;
		auto_review?: "off" | "active" | "unavailable";
		auto_review_confined_launch_enabled?: boolean;
		auto_review_confined_launch_issue?: import("./permissions").AutoReviewStatus["confined_launch_issue"];
		auto_review_issue?: import("./permissions").AutoReviewStatus["issue"];
	};
};
