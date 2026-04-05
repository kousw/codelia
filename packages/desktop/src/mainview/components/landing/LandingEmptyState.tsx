import {
	FolderOpen,
	MessageSquareMore,
	Search,
	uiIconProps,
} from "../../icons";

export const LandingEmptyState = ({
	runtimeLabel,
	modelLabel,
	onOpenWorkspace,
}: {
	runtimeLabel: string;
	modelLabel: string;
	onOpenWorkspace: () => Promise<void>;
}) => {
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
							className="button primary has-icon"
							onClick={() => void onOpenWorkspace()}
						>
							<FolderOpen {...uiIconProps} className="button-icon" />
							<span>Open Workspace</span>
						</button>
					</div>
				</div>
				<div className="landing-side">
					<p className="panel-kicker">Workflow</p>
					<div className="landing-list">
						<div className="landing-row">
							<div className="landing-row-header">
								<FolderOpen {...uiIconProps} className="landing-row-icon" />
								<strong>Open a project folder</strong>
							</div>
							<span className="muted">
								Treat the workspace as the anchor for every thread.
							</span>
						</div>
						<div className="landing-row">
							<div className="landing-row-header">
								<MessageSquareMore
									{...uiIconProps}
									className="landing-row-icon"
								/>
								<strong>Start a scoped conversation</strong>
							</div>
							<span className="muted">
								Keep implementation history attached to the repo.
							</span>
						</div>
						<div className="landing-row">
							<div className="landing-row-header">
								<Search {...uiIconProps} className="landing-row-icon" />
								<strong>Pull inspect only when needed</strong>
							</div>
							<span className="muted">
								Context and MCP stay available without dominating the layout.
							</span>
						</div>
					</div>
				</div>
			</section>
		</div>
	);
};
