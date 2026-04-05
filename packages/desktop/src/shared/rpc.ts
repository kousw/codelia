import type { RPCSchema } from "electrobun/bun";
import type {
	UiConfirmResult,
	UiPickResult,
	UiPromptResult,
} from "../../../protocol/src/index";
import type { DesktopSnapshot, InspectBundle, StreamEvent } from "./types";

export type UiResponsePayload = UiConfirmResult | UiPromptResult | UiPickResult;

export type DesktopRpcSchema = {
	bun: RPCSchema<{
		requests: {
			initialize: {
				params: undefined;
				response: DesktopSnapshot;
			};
			openWorkspaceDialog: {
				params: undefined;
				response: DesktopSnapshot;
			};
			loadWorkspace: {
				params: { workspace_path: string };
				response: DesktopSnapshot;
			};
			loadSession: {
				params: {
					workspace_path: string;
					session_id?: string | null;
				};
				response: DesktopSnapshot;
			};
			updateSession: {
				params: {
					session_id: string;
					workspace_path?: string;
					title?: string;
					archived?: boolean;
				};
				response: DesktopSnapshot;
			};
			startRun: {
				params: {
					workspace_path: string;
					session_id?: string;
					message: string;
				};
				response: { run_id: string; session_id?: string };
			};
			cancelRun: {
				params: { run_id: string };
				response: { ok: true };
			};
			respondUiRequest: {
				params: {
					request_id: string;
					result: UiResponsePayload;
				};
				response: { ok: true };
			};
			setModel: {
				params: {
					workspace_path: string;
					name: string;
					provider?: string;
					reasoning?: "low" | "medium" | "high" | "xhigh";
				};
				response: DesktopSnapshot;
			};
			getInspect: {
				params: { workspace_path: string };
				response: InspectBundle;
			};
			openWorkspaceTarget: {
				params: {
					workspace_path: string;
					target: "cursor" | "finder";
				};
				response: { ok: boolean; message?: string };
			};
			openLink: {
				params: { href: string; workspace_path?: string };
				response: { ok: boolean; message?: string };
			};
		};
		messages: Record<string, never>;
	}>;
	webview: RPCSchema<{
		requests: Record<string, never>;
		messages: {
			runEvent: StreamEvent;
			menuAction: {
				action: "new-chat" | "refresh" | "workspace-opened";
				snapshot?: DesktopSnapshot;
			};
			toast: {
				kind: "info" | "error";
				message: string;
			};
		};
	}>;
};
