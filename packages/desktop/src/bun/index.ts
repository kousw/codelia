import path from "node:path";
import Electrobun, { BrowserView, BrowserWindow, PATHS } from "electrobun/bun";
import type { DesktopRpcSchema } from "../shared/rpc";
import { DesktopController, installApplicationMenu } from "./controller";

const runtimeEntryPath = path.resolve(
	PATHS.VIEWS_FOLDER,
	"..",
	"runtime",
	"index.js",
);

let controller: DesktopController | null = null;

const requireController = (): DesktopController => {
	if (!controller) {
		throw new Error("desktop controller is not ready");
	}
	return controller;
};

const rpc = BrowserView.defineRPC<DesktopRpcSchema>({
	maxRequestTime: 5 * 60 * 1000,
	handlers: {
		requests: {
			initialize: async () => requireController().initialize(),
			openWorkspaceDialog: async () =>
				requireController().requestOpenWorkspaceDialog(),
			loadWorkspace: async (params) =>
				requireController().loadWorkspace(params.workspace_path),
			loadSession: async (params) =>
				requireController().loadSession(
					params.workspace_path,
					params.session_id,
				),
			updateSession: async (params) =>
				requireController().updateSession(params),
			startRun: async (params) => requireController().startRun(params),
			cancelRun: async (params) => requireController().cancelRun(params.run_id),
			respondUiRequest: async (params) =>
				requireController().respondUiRequest(params.request_id, params.result),
			setModel: async (params) => requireController().setModel(params),
			getInspect: async (params) =>
				requireController().getInspect(params.workspace_path),
			openWorkspaceTarget: async (params) =>
				requireController().openWorkspaceTarget(
					params.workspace_path,
					params.target,
				),
			openLink: async (params) =>
				requireController().openLink(params.href, params.workspace_path),
		},
	},
});

type DesktopBunRpc = typeof rpc;

const mainWindow = new BrowserWindow<DesktopBunRpc>({
	title: "Codelia Desktop",
	url: "views://mainview/index.html",
	frame: {
		width: 1560,
		height: 980,
		x: 80,
		y: 60,
	},
	titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
	rpc,
});

controller = new DesktopController({
	mainWindow,
	runtimeEntryPath,
});

installApplicationMenu();

Electrobun.events.on("application-menu-clicked", async (event) => {
	if (!controller) return;
	if (
		event.data.action === "open-workspace" ||
		event.data.action === "new-chat" ||
		event.data.action === "refresh" ||
		event.data.action === "toggle-devtools"
	) {
		await controller.handleMenuAction(event.data.action);
	}
});
