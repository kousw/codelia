import type { DesktopWorkspace } from "../../shared/types";
import type { ViewState } from "../controller";

export const LandingView = ({
	state,
	workspace,
	onOpenWorkspace,
	onNewChat,
	onLoadInspect,
	onLoadSession,
}: {
	state: ViewState;
	workspace?: DesktopWorkspace;
	onOpenWorkspace: () => Promise<void>;
	onNewChat: () => Promise<void>;
	onLoadInspect: () => Promise<void>;
	onLoadSession: (sessionId: string | null) => Promise<void>;
}) => {
	const runtimeLabel = state.snapshot.runtime_health?.connected
		? "Connected"
		: "Offline";
	const modelLabel =
		state.snapshot.runtime_health?.model?.current ??
		state.snapshot.runtime_health?.model?.provider ??
		"Model not loaded";
	const recentSessions = state.snapshot.sessions.slice(0, 3);

	if (!workspace) {
		return (
			<div className="landing">
				<section className="landing-stage">
					<div className="landing-main">
						<p className="eyebrow">Desktop Workbench</p>
						<h3 className="landing-title">
							A cleaner workspace shell for coding sessions.
						</h3>
						<p className="landing-body">
							Open a folder and keep chat, model selection, and inspect attached
							to the codebase instead of floating as separate tools.
						</p>
						<div className="landing-meta">
							<span className="hero-tag">{runtimeLabel}</span>
							<span className="hero-tag">{modelLabel}</span>
						</div>
						<div className="hero-actions">
							<button
								type="button"
								className="button primary"
								onClick={() => void onOpenWorkspace()}
							>
								Open Workspace
							</button>
						</div>
					</div>
					<div className="landing-side">
						<p className="panel-kicker">Workflow</p>
						<div className="landing-list">
							<div className="landing-row">
								<strong>Open a project folder</strong>
								<span className="muted">
									Treat the workspace as the anchor for every thread.
								</span>
							</div>
							<div className="landing-row">
								<strong>Start a scoped conversation</strong>
								<span className="muted">
									Keep implementation history attached to the repo.
								</span>
							</div>
							<div className="landing-row">
								<strong>Pull inspect only when needed</strong>
								<span className="muted">
									Context and MCP stay available without dominating the layout.
								</span>
							</div>
						</div>
					</div>
				</section>
			</div>
		);
	}

	return (
		<div className="landing">
			<section className="landing-stage is-workspace">
				<div className="landing-main">
					<p className="eyebrow">Workspace Ready</p>
					<h3 className="landing-title">{workspace.name}</h3>
					<p className="landing-body">{workspace.path}</p>
					<div className="hero-tags">
						<span className="hero-tag">{workspace.branch ?? "no-git"}</span>
						<span
							className={`hero-tag${workspace.is_dirty ? " is-warning" : ""}`}
						>
							{workspace.is_dirty ? "dirty tree" : "clean tree"}
						</span>
						<span
							className={`hero-tag${
								state.snapshot.runtime_health?.connected ? " is-accent" : ""
							}`}
						>
							{runtimeLabel}
						</span>
					</div>
					<div className="hero-actions">
						<button
							type="button"
							className="button primary"
							onClick={() => void onNewChat()}
						>
							New Chat
						</button>
						<button
							type="button"
							className="button"
							onClick={() => void onLoadInspect()}
						>
							Load Inspect
						</button>
					</div>
				</div>
				<div className="landing-side">
					<div className="inline-list">
						<p className="panel-kicker">Recent Sessions</p>
						{recentSessions.length === 0 ? (
							<div className="section-empty">
								<strong>No threads yet</strong>
								<span className="muted">
									Send the first prompt to start a workspace-scoped run.
								</span>
							</div>
						) : (
							recentSessions.map((session) => (
								<button
									key={session.session_id}
									type="button"
									className="inline-row"
									onClick={() => void onLoadSession(session.session_id)}
								>
									<strong>{session.title}</strong>
									<span className="muted">
										{session.last_user_message ?? "No messages yet"}
									</span>
								</button>
							))
						)}
					</div>
				</div>
			</section>
			<section className="landing-grid">
				<article className="landing-note">
					<p className="panel-kicker">Suggested Launch Points</p>
					<div className="landing-list">
						<div className="landing-row">
							<strong>Inspect the current architecture</strong>
							<span className="muted">
								Ask for a codebase overview, entrypoints, or recent protocol
								boundaries.
							</span>
						</div>
						<div className="landing-row">
							<strong>Implement the next scoped task</strong>
							<span className="muted">
								Use the composer to jump straight into fixes, refactors, or MVP
								work.
							</span>
						</div>
						<div className="landing-row">
							<strong>Refresh inspect before a risky change</strong>
							<span className="muted">
								Pull runtime, MCP, and skill visibility only when it helps
								decision making.
							</span>
						</div>
					</div>
				</article>
				<article className="landing-note">
					<p className="panel-kicker">Workspace Snapshot</p>
					<div className="metric-strip">
						<div className="metric-card">
							<span className="hero-metric-label">Model</span>
							<strong>{modelLabel}</strong>
							<span className="muted">Current runtime selection</span>
						</div>
						<div className="metric-card">
							<span className="hero-metric-label">Sessions</span>
							<strong>{state.snapshot.sessions.length}</strong>
							<span className="muted">Tracked in desktop-local metadata</span>
						</div>
					</div>
				</article>
			</section>
		</div>
	);
};
