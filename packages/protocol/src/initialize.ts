import type { ServerCapabilities, UiCapabilities } from "./capabilities";
import type { ProtocolVersion } from "./version";

export type InitializeParams = {
	protocol_version: ProtocolVersion;
	client: { name: string; version: string };
	ui_capabilities?: UiCapabilities;
};

export type InitializeResult = {
	protocol_version: ProtocolVersion;
	server: { name: string; version: string };
	server_capabilities?: ServerCapabilities;
	tui?: {
		theme?: string;
	};
};
