import { useEffect } from "react";
import { InspectPane } from "./components/InspectPane";
import { ModalLayer } from "./components/ModalLayer";
import { TranscriptPane } from "./components/TranscriptPane";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import {
	cancelRun,
	commitState,
	initializeView,
	loadInspect,
	loadSession,
	loadWorkspace,
	openWorkspaceDialog,
	refreshInspect,
	renameSession,
	requestHideSession,
	resolveModalDismissPayload,
	selectedWorkspace,
	sendPrompt,
	updateModel,
	submitModal,
} from "./controller";
import { useDesktopViewState } from "./hooks/useDesktopViewState";

export const App = () => {
	const state = useDesktopViewState();
	const workspace = selectedWorkspace(state.snapshot);

	useEffect(() => {
		document.body.dataset.platform = /Mac|iPhone|iPad/.test(navigator.platform)
			? "mac"
			: "other";
		void initializeView();
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") {
				return;
			}
			const request = state.pendingUiRequest;
			if (request) {
				event.preventDefault();
				void submitModal(resolveModalDismissPayload(request));
				return;
			}
			if (state.pendingLocalDialog) {
				event.preventDefault();
				commitState((draft) => {
					draft.pendingLocalDialog = null;
				});
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [state.pendingLocalDialog, state.pendingUiRequest]);

	return (
		<>
			<div className={`shell${state.inspectOpen ? " is-inspect-open" : ""}`}>
				<aside className="panel sidebar">
					<div className="sidebar-header electrobun-webkit-app-region-drag">
						<div className="title-block">
							<p className="eyebrow">Codelia</p>
							<h1>Desktop</h1>
						</div>
						<div className="sidebar-actions electrobun-webkit-app-region-no-drag">
							<button
								type="button"
								className="button"
								onClick={() => void loadSession(null)}
								disabled={!state.snapshot.selected_workspace_path}
							>
								New Chat
							</button>
							<button
								type="button"
								className="button primary"
								onClick={() => void openWorkspaceDialog()}
							>
								Open
							</button>
						</div>
					</div>
					<section className="sidebar-section">
						<div className="section-heading">
							<p className="eyebrow">Workspaces</p>
						</div>
						<div className="workspace-list grouped">
							<WorkspaceSidebar
								workspaces={state.snapshot.workspaces}
								selectedWorkspacePath={state.snapshot.selected_workspace_path}
								sessions={state.snapshot.sessions}
								selectedSessionId={state.snapshot.selected_session_id}
								onLoadWorkspace={loadWorkspace}
								onLoadSession={loadSession}
								onRenameSession={renameSession}
								onHideSession={requestHideSession}
							/>
						</div>
					</section>
				</aside>

				<main className="panel center">
					<header className="topbar electrobun-webkit-app-region-drag">
						<div className="topbar-title topbar-title-inline">
							<h2 className="workspace-heading">
								{workspace?.name ?? "Select a workspace"}
							</h2>
							{workspace?.path ? (
								<span className="workspace-subtitle workspace-subtitle-inline">
									{workspace.path}
								</span>
							) : null}
						</div>
						<div className="topbar-actions electrobun-webkit-app-region-no-drag">
							<span
								className={`pill${
									state.snapshot.runtime_health?.connected ? " is-accent" : ""
								}`}
							>
								{state.snapshot.runtime_health?.connected
									? "runtime connected"
									: "runtime offline"}
							</span>
							<button
								type="button"
								className="button button-subtle"
								onClick={() => void loadInspect()}
							>
								{state.inspectOpen ? "Hide Inspect" : "Inspect"}
							</button>
						</div>
					</header>

					<TranscriptPane
						state={state}
						workspace={workspace}
						onOpenWorkspace={openWorkspaceDialog}
						onNewChat={() => loadSession(null)}
						onLoadInspect={loadInspect}
						onLoadSession={loadSession}
						onCopySection={(text) => {
							void navigator.clipboard.writeText(text).catch((error) => {
								commitState((draft) => {
									draft.errorMessage = String(error);
								});
							});
						}}
					/>

					<footer className="composer">
						<div className="statusbar">
							<span>{state.statusLine}</span>
							{state.errorMessage ? (
								<span className="error-banner">{state.errorMessage}</span>
							) : null}
						</div>
						<textarea
							id="composer"
							className="textarea"
							placeholder="Ask Codelia to inspect, implement, or explain..."
							disabled={
								!state.snapshot.selected_workspace_path ||
								Boolean(state.pendingUiRequest)
							}
							value={state.composer}
							onChange={(event) =>
								commitState((draft) => {
									draft.composer = event.target.value;
								})
							}
							onKeyDown={(event) => {
								if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
									event.preventDefault();
									void sendPrompt();
								}
							}}
						/>
						<div className="composer-toolbar">
							<div className="composer-actions">
								<button
									type="button"
									className="button primary"
									onClick={() => void sendPrompt()}
									disabled={
										!state.snapshot.selected_workspace_path || state.isStreaming
									}
								>
									Send
								</button>
								<button
									type="button"
									className="button"
									onClick={() => void cancelRun()}
									disabled={!state.isStreaming}
								>
									Stop
								</button>
							</div>
						</div>
						<div className="composer-meta">
							<span
								className={`pill${workspace?.is_dirty ? " is-warning" : ""}`}
							>
								{workspace
									? `${workspace.branch ?? "no-git"}${workspace.is_dirty ? " • dirty" : ""}`
									: "workspace idle"}
							</span>
							<select
								id="model-select"
								className="select"
								disabled={!state.snapshot.runtime_health?.model}
								value={state.snapshot.runtime_health?.model?.current ?? ""}
								onChange={(event) => void updateModel(event.target.value)}
							>
								<option value="">
									{state.snapshot.runtime_health?.model?.provider
										? `${state.snapshot.runtime_health.model.provider} model`
										: "model"}
								</option>
								{state.snapshot.runtime_health?.model?.models.map((model) => (
									<option key={model} value={model}>
										{model}
									</option>
								))}
							</select>
						</div>
					</footer>
				</main>

				{state.inspectOpen ? (
					<aside className="panel inspect-rail">
						<div className="inspect-header">
							<h2>Inspect</h2>
							<div className="topbar-actions">
								<button
									type="button"
									className="button"
									onClick={() => void refreshInspect()}
								>
									Refresh
								</button>
								<button
									type="button"
									className="button"
									onClick={() => void loadInspect()}
								>
									Close
								</button>
							</div>
						</div>
						<div className="inspect-body">
							<InspectPane inspect={state.inspect} />
						</div>
					</aside>
				) : null}
			</div>

			<ModalLayer state={state} />
		</>
	);
};
