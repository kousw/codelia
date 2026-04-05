import type { DesktopSession, DesktopWorkspace } from "../../../shared/types";
import {
	GitBranch,
	MessageSquare,
	Search,
	SquarePen,
	uiIconProps,
} from "../../icons";

export const LandingWorkspaceState = ({
	workspace,
	sessions,
	runtimeLabel,
	modelLabel,
	onNewChat,
	onLoadInspect,
	onLoadSession,
}: {
	workspace: DesktopWorkspace;
	sessions: DesktopSession[];
	runtimeLabel: string;
	modelLabel: string;
	onNewChat: () => Promise<void>;
	onLoadInspect: () => Promise<void>;
	onLoadSession: (sessionId: string | null) => Promise<void>;
}) => {
	const recentSessions = sessions.slice(0, 3);

	return (
		<div className="landing">
			<section className="landing-stage is-workspace">
				<div className="landing-main">
					<p className="eyebrow">Workspace Ready</p>
					<h3 className="landing-title">{workspace.name}</h3>
					<p className="landing-body">{workspace.path}</p>
					<div className="hero-tags">
						<span className="hero-tag">
							<GitBranch {...uiIconProps} className="tag-icon" />
							<span>{workspace.branch ?? "no-git"}</span>
						</span>
						<span
							className={`hero-tag${workspace.is_dirty ? " is-warning" : ""}`}
						>
							{workspace.is_dirty ? "dirty tree" : "clean tree"}
						</span>
						<span
							className={`hero-tag${runtimeLabel === "Connected" ? " is-accent" : ""}`}
						>
							{runtimeLabel}
						</span>
					</div>
					<div className="hero-actions">
						<button
							type="button"
							className="button primary has-icon"
							onClick={() => void onNewChat()}
						>
							<SquarePen {...uiIconProps} className="button-icon" />
							<span>New Chat</span>
						</button>
						<button
							type="button"
							className="button has-icon"
							onClick={() => void onLoadInspect()}
						>
							<Search {...uiIconProps} className="button-icon" />
							<span>Load Inspect</span>
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
									<div className="inline-row-header">
										<MessageSquare
											{...uiIconProps}
											className="inline-row-icon"
										/>
										<strong>{session.title}</strong>
									</div>
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
							<div className="landing-row-header">
								<Search {...uiIconProps} className="landing-row-icon" />
								<strong>Inspect the current architecture</strong>
							</div>
							<span className="muted">
								Ask for a codebase overview, entrypoints, or recent protocol
								boundaries.
							</span>
						</div>
						<div className="landing-row">
							<div className="landing-row-header">
								<SquarePen {...uiIconProps} className="landing-row-icon" />
								<strong>Implement the next scoped task</strong>
							</div>
							<span className="muted">
								Use the composer to jump straight into fixes, refactors, or MVP
								work.
							</span>
						</div>
						<div className="landing-row">
							<div className="landing-row-header">
								<Search {...uiIconProps} className="landing-row-icon" />
								<strong>Refresh inspect before a risky change</strong>
							</div>
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
							<strong>{sessions.length}</strong>
							<span className="muted">Tracked in desktop-local metadata</span>
						</div>
					</div>
				</article>
			</section>
		</div>
	);
};
