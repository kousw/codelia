import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Electrobun, {
	ApplicationMenu,
	type BrowserWindow,
	Utils,
} from "electrobun/bun";
import { DesktopService } from "../server/service";
import type { UiResponsePayload } from "../shared/rpc";
import type { DesktopSnapshot, StreamEvent } from "../shared/types";

type MenuAction = "new-chat" | "open-workspace" | "refresh" | "toggle-devtools";
type DesktopViewRpc = {
	send: {
		runEvent: (payload: StreamEvent) => void;
		menuAction: (payload: {
			action: "new-chat" | "refresh" | "workspace-opened";
			snapshot?: DesktopSnapshot;
		}) => void;
		toast: (payload: { kind: "info" | "error"; message: string }) => void;
	};
};

export class DesktopController {
	private readonly mainWindow: BrowserWindow;
	private readonly service: DesktopService;
	private currentWorkspacePath: string | null = null;
	private currentSessionId: string | null = null;
	private viewReady = false;

	constructor(options: {
		mainWindow: BrowserWindow;
		runtimeEntryPath: string;
	}) {
		this.mainWindow = options.mainWindow;
		this.service = new DesktopService({
			runtimeEntryPath: options.runtimeEntryPath,
			onStreamEvent: (event) => {
				if (!this.viewReady) return;
				this.viewRpc?.send.runEvent(event);
			},
		});
	}

	private get viewRpc(): DesktopViewRpc | undefined {
		return this.mainWindow.webview.rpc as DesktopViewRpc | undefined;
	}

	private sendMenuAction(payload: {
		action: "new-chat" | "refresh" | "workspace-opened";
		snapshot?: DesktopSnapshot;
	}): void {
		this.viewRpc?.send.menuAction(payload);
	}

	private sendToast(payload: {
		kind: "info" | "error";
		message: string;
	}): void {
		this.viewRpc?.send.toast(payload);
	}

	private updateSelection(snapshot: DesktopSnapshot): DesktopSnapshot {
		this.currentWorkspacePath = snapshot.selected_workspace_path ?? null;
		this.currentSessionId = snapshot.selected_session_id ?? null;
		return snapshot;
	}

	private async launchCursor(
		targetPath: string,
		location?: { line?: number; column?: number },
	): Promise<boolean> {
		const targetWithLocation =
			location?.line !== undefined
				? `${targetPath}:${location.line}${location.column ? `:${location.column}` : ""}`
				: targetPath;
		for (const command of ["cursor", "code"]) {
			try {
				const proc = Bun.spawn({
					cmd: [command, targetWithLocation],
					stdout: "ignore",
					stderr: "ignore",
				});
				const exitCode = await proc.exited;
				if (exitCode === 0) {
					return true;
				}
			} catch {
				// Try the next editor command.
			}
		}
		return false;
	}

	private resolveLinkTarget(
		href: string,
		workspacePath?: string,
	):
		| { kind: "external"; url: string }
		| { kind: "file"; filePath: string; line?: number; column?: number }
		| { kind: "invalid"; message: string } {
		const value = href.trim();
		if (!value || value.startsWith("#")) {
			return { kind: "invalid", message: "Unsupported link target" };
		}
		if (/^(https?:|mailto:|tel:)/i.test(value)) {
			return { kind: "external", url: value };
		}
		if (value.startsWith("file://")) {
			try {
				return {
					kind: "file",
					filePath: path.resolve(fileURLToPath(new URL(value))),
				};
			} catch {
				return { kind: "invalid", message: "Invalid file URL" };
			}
		}
		if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
			return { kind: "external", url: value };
		}
		const match = value.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
		const rawPath = match?.[1]?.trim();
		if (!rawPath) {
			return { kind: "invalid", message: "Missing file path" };
		}
		const line = match?.[2] ? Number.parseInt(match[2], 10) : undefined;
		const column = match?.[3] ? Number.parseInt(match[3], 10) : undefined;
		const resolvedPath = path.isAbsolute(rawPath)
			? path.resolve(rawPath)
			: workspacePath
				? path.resolve(workspacePath, rawPath)
				: null;
		if (!resolvedPath) {
			return {
				kind: "invalid",
				message: "Relative file links need an active workspace",
			};
		}
		return {
			kind: "file",
			filePath: resolvedPath,
			line,
			column,
		};
	}

	private async openWorkspaceDialog(): Promise<DesktopSnapshot> {
		const chosenPaths = await Utils.openFileDialog({
			startingFolder: this.currentWorkspacePath ?? homedir(),
			canChooseFiles: false,
			canChooseDirectory: true,
			allowsMultipleSelection: false,
		});
		const chosenPath = chosenPaths[0]?.trim();
		if (!chosenPath) {
			return this.updateSelection(
				await this.service.createSnapshot(
					this.currentWorkspacePath,
					this.currentSessionId,
				),
			);
		}
		await this.service.openWorkspace(chosenPath);
		return this.updateSelection(await this.service.createSnapshot(chosenPath));
	}

	async requestOpenWorkspaceDialog(): Promise<DesktopSnapshot> {
		return this.openWorkspaceDialog();
	}

	async initialize(): Promise<DesktopSnapshot> {
		this.viewReady = true;
		return this.updateSelection(await this.service.createSnapshot());
	}

	async loadWorkspace(workspacePath: string): Promise<DesktopSnapshot> {
		return this.updateSelection(
			await this.service.createSnapshot(workspacePath),
		);
	}

	async loadSession(
		workspacePath: string,
		sessionId?: string | null,
	): Promise<DesktopSnapshot> {
		return this.updateSelection(
			await this.service.createSnapshot(workspacePath, sessionId),
		);
	}

	async updateSession(input: {
		session_id: string;
		workspace_path?: string;
		title?: string;
		archived?: boolean;
	}): Promise<DesktopSnapshot> {
		await this.service.updateSession(input.session_id, {
			workspace_path: input.workspace_path,
			title: input.title,
			archived: input.archived,
		});
		return this.updateSelection(
			await this.service.createSnapshot(
				input.workspace_path ?? this.currentWorkspacePath,
				input.archived ? null : this.currentSessionId,
			),
		);
	}

	async startRun(input: {
		workspace_path: string;
		session_id?: string;
		message: string;
	}): Promise<{ run_id: string; session_id?: string }> {
		const result = await this.service.startRun({
			workspacePath: input.workspace_path,
			sessionId: input.session_id,
			message: input.message,
		});
		this.currentWorkspacePath = input.workspace_path;
		this.currentSessionId = result.session_id ?? this.currentSessionId;
		return result;
	}

	async cancelRun(runId: string): Promise<{ ok: true }> {
		await this.service.cancelRun(runId);
		return { ok: true };
	}

	async respondUiRequest(
		requestId: string,
		result: UiResponsePayload,
	): Promise<{ ok: true }> {
		await this.service.respondToUiRequest(requestId, result);
		return { ok: true };
	}

	async setModel(input: {
		workspace_path: string;
		name: string;
		provider?: string;
		reasoning?: "low" | "medium" | "high" | "xhigh";
	}): Promise<DesktopSnapshot> {
		await this.service.setModel(input.workspace_path, {
			name: input.name,
			provider: input.provider,
			reasoning: input.reasoning,
		});
		return this.updateSelection(
			await this.service.createSnapshot(
				input.workspace_path,
				this.currentSessionId,
			),
		);
	}

	async getInspect(workspacePath: string) {
		return this.service.getInspectBundle(workspacePath);
	}

	async openWorkspaceTarget(
		workspacePath: string,
		target: "cursor" | "finder",
	): Promise<{ ok: boolean; message?: string }> {
		if (target === "finder") {
			return Utils.openPath(workspacePath)
				? { ok: true }
				: { ok: false, message: "Failed to open workspace in Finder" };
		}
		const opened = await this.launchCursor(workspacePath);
		return opened
			? { ok: true }
			: {
					ok: false,
					message: "Failed to open workspace in Cursor",
				};
	}

	async openLink(
		href: string,
		workspacePath?: string,
	): Promise<{ ok: boolean; message?: string }> {
		const resolved = this.resolveLinkTarget(href, workspacePath);
		if (resolved.kind === "invalid") {
			return { ok: false, message: resolved.message };
		}
		if (resolved.kind === "external") {
			return Utils.openExternal(resolved.url)
				? { ok: true }
				: { ok: false, message: "Failed to open external link" };
		}
		if (resolved.line !== undefined) {
			const openedInEditor = await this.launchCursor(resolved.filePath, {
				line: resolved.line,
				column: resolved.column,
			});
			if (openedInEditor) {
				return { ok: true };
			}
		}
		return Utils.openPath(resolved.filePath)
			? { ok: true }
			: { ok: false, message: "Failed to open file link" };
	}

	async handleMenuAction(action: MenuAction): Promise<void> {
		if (action === "toggle-devtools") {
			this.mainWindow.webview.toggleDevTools();
			return;
		}

		if (action === "open-workspace") {
			try {
				const snapshot = await this.openWorkspaceDialog();
				if (this.viewReady) {
					this.sendMenuAction({
						action: "workspace-opened",
						snapshot,
					});
				}
			} catch (error) {
				if (this.viewReady) {
					this.sendToast({
						kind: "error",
						message: String(error),
					});
				}
			}
			return;
		}

		if (action === "refresh") {
			if (!this.viewReady || !this.currentWorkspacePath) return;
			const snapshot = await this.service.createSnapshot(
				this.currentWorkspacePath,
				this.currentSessionId,
			);
			this.sendMenuAction({
				action: "refresh",
				snapshot: this.updateSelection(snapshot),
			});
			return;
		}

		if (action === "new-chat" && this.viewReady) {
			this.currentSessionId = null;
			this.sendMenuAction({
				action: "new-chat",
			});
		}
	}
}

export const installApplicationMenu = (): void => {
	ApplicationMenu.setApplicationMenu([
		{
			submenu: [{ role: "quit" }],
		},
		{
			label: "File",
			submenu: [
				{
					label: "Open Workspace",
					action: "open-workspace",
					accelerator: "CommandOrControl+O",
				},
				{
					label: "New Chat",
					action: "new-chat",
					accelerator: "CommandOrControl+N",
				},
				{
					label: "Refresh",
					action: "refresh",
					accelerator: "CommandOrControl+R",
				},
				{
					type: "separator",
				},
				{
					role: "quit",
				},
			],
		},
		{
			label: "View",
			submenu: [
				{
					label: "Toggle Developer Tools",
					action: "toggle-devtools",
					accelerator: "Alt+CommandOrControl+I",
				},
				{
					role: "toggleFullScreen",
				},
			],
		},
		{
			label: "Help",
			submenu: [
				{
					label: "Electrobun Docs",
					action: "open-electrobun-docs",
				},
			],
		},
	]);

	Electrobun.events.on("application-menu-clicked", async (event) => {
		switch (event.data.action) {
			case "open-electrobun-docs":
				await Utils.openExternal("https://blackboard.sh/electrobun/");
				return;
			default:
				return;
		}
	});
};
