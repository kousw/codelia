import type { DesktopWorkspace } from "../../../shared/types";
import { slashCommandMatches } from "../../command-catalog";
import { SendHorizontal, Square, uiIconProps, Zap } from "../../icons";

type ReasoningLevel = "low" | "medium" | "high" | "xhigh";

const REASONING_LEVELS: ReasoningLevel[] = ["low", "medium", "high", "xhigh"];

export const Composer = ({
	workspace,
	statusLine,
	composerNotice,
	errorMessage,
	composer,
	pendingShellResultCount,
	selectedWorkspacePath,
	pendingUiRequest,
	isStreaming,
	isShellRunning,
	model,
	onComposerChange,
	onSend,
	onCancel,
	onUpdateModel,
	onUpdateModelReasoning,
	onUpdateModelFast,
}: {
	workspace?: DesktopWorkspace;
	statusLine: string;
	composerNotice: string | null;
	errorMessage: string | null;
	composer: string;
	pendingShellResultCount: number;
	selectedWorkspacePath?: string;
	pendingUiRequest: boolean;
	isStreaming: boolean;
	isShellRunning: boolean;
	model?: {
		current?: string;
		provider?: string;
		models: string[];
		reasoning?: string;
		fast?: boolean;
	};
	onComposerChange: (value: string) => void;
	onSend: () => Promise<void>;
	onCancel: () => Promise<void>;
	onUpdateModel: (value: string) => Promise<void>;
	onUpdateModelReasoning: (value: ReasoningLevel) => Promise<void>;
	onUpdateModelFast: (value: boolean) => Promise<void>;
}) => {
	const composerDisabled =
		!selectedWorkspacePath || pendingUiRequest || isShellRunning;
	const shellQueueStatus =
		pendingShellResultCount > 0
			? `${pendingShellResultCount} shell result${pendingShellResultCount === 1 ? "" : "s"} queued for next message`
			: null;
	const visibleStatus =
		errorMessage ??
		(isShellRunning
			? statusLine
			: (composerNotice ??
				shellQueueStatus ??
				(pendingUiRequest || isStreaming
					? statusLine === "Idle"
						? "Running"
						: statusLine
					: null)));
	const statusKind = errorMessage
		? "is-error"
		: isShellRunning || isStreaming
			? "is-running"
			: pendingUiRequest
				? "is-waiting"
				: composerNotice || shellQueueStatus
					? "is-queued"
					: "is-running";
	const slashSuggestions = slashCommandMatches(composer);
	const showSlashHelper =
		!composerDisabled &&
		composer.trimStart().startsWith("/") &&
		composer.length > 0;

	return (
		<footer className="composer">
			<div className="composer-shell">
				{visibleStatus ? (
					<div
						className={`composer-status ${statusKind}`}
						role={errorMessage ? "alert" : "status"}
						aria-live="polite"
					>
						<span className="composer-status-dot" />
						<span>{visibleStatus}</span>
					</div>
				) : null}
				<div className="composer-input-row">
					{showSlashHelper ? (
						<div className="composer-command-helper" role="listbox">
							<div className="composer-command-helper-header">
								<span>Slash commands</span>
								<span>Click to fill</span>
							</div>
							<div className="composer-command-helper-list">
								{slashSuggestions.map((spec) => (
									<button
										type="button"
										key={spec.command}
										className="composer-command-option"
										onMouseDown={(event) => event.preventDefault()}
										onClick={() => onComposerChange(spec.insertText)}
									>
										<span className="composer-command-usage">{spec.usage}</span>
										<span className="composer-command-summary">
											{spec.summary}
										</span>
									</button>
								))}
							</div>
						</div>
					) : null}
					<textarea
						id="composer"
						className="textarea composer-textarea"
						placeholder="Ask Codelia to inspect, implement, or explain..."
						disabled={composerDisabled}
						value={composer}
						onChange={(event) => onComposerChange(event.target.value)}
						onKeyDown={(event) => {
							if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
								event.preventDefault();
								void onSend();
							}
						}}
					/>
				</div>
				<div className="composer-meta">
					<div className="composer-settings">
						<span className={`pill${workspace?.is_dirty ? " is-warning" : ""}`}>
							{workspace
								? `${workspace.branch ?? "no-git"}${workspace.is_dirty ? " • dirty" : ""}`
								: "workspace idle"}
						</span>
						<div className="composer-selects">
							<select
								id="model-select"
								className="select"
								disabled={!model}
								value={model?.current ?? ""}
								onChange={(event) => void onUpdateModel(event.target.value)}
							>
								<option value="">
									{model?.provider ? `${model.provider} model` : "model"}
								</option>
								{model?.models.map((name) => (
									<option key={name} value={name}>
										{name}
									</option>
								))}
							</select>
							<select
								id="reasoning-select"
								className="select select-compact"
								aria-label="Reasoning level"
								disabled={!model?.current}
								value={model?.reasoning ?? "medium"}
								onChange={(event) =>
									void onUpdateModelReasoning(
										event.target.value as ReasoningLevel,
									)
								}
							>
								{REASONING_LEVELS.map((reasoning) => (
									<option key={reasoning} value={reasoning}>
										{reasoning}
									</option>
								))}
							</select>
							<button
								type="button"
								className={`button composer-fast-toggle has-icon${
									model?.fast ? " is-active" : ""
								}`}
								aria-label="Fast mode"
								aria-pressed={model?.fast === true}
								title="Toggle fast mode"
								disabled={!model?.current}
								onClick={() => void onUpdateModelFast(!(model?.fast === true))}
							>
								<Zap
									{...uiIconProps}
									className="button-icon"
									fill={model?.fast ? "currentColor" : "none"}
								/>
							</button>
						</div>
					</div>
					<div className="composer-actions">
						<button
							type="button"
							className="button primary has-icon"
							onClick={() => void onSend()}
							disabled={!selectedWorkspacePath || isStreaming || isShellRunning}
						>
							<SendHorizontal {...uiIconProps} className="button-icon" />
							<span>Send</span>
						</button>
						<button
							type="button"
							className="button has-icon"
							onClick={() => void onCancel()}
							disabled={!isStreaming}
						>
							<Square {...uiIconProps} className="button-icon" />
							<span>Stop</span>
						</button>
					</div>
				</div>
			</div>
		</footer>
	);
};
