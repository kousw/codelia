import { useEffect, useRef, useState } from "react";
import { slashCommandMatches } from "../../command-catalog";
import {
	GitBranch,
	SendHorizontal,
	Square,
	uiIconProps,
	Zap,
} from "../../icons";

type ReasoningLevel = "low" | "medium" | "high" | "xhigh";

const REASONING_LEVELS: ReasoningLevel[] = ["low", "medium", "high", "xhigh"];

export const Composer = ({
	statusLine,
	composerNotice,
	errorMessage,
	composer,
	pendingShellResultCount,
	selectedWorkspacePath,
	pendingUiRequest,
	isStreaming,
	isShellRunning,
	contextLeftPercent,
	model,
	git,
	onComposerChange,
	onSend,
	onCancel,
	onSwitchBranch,
	onUpdateModel,
	onUpdateModelReasoning,
	onUpdateModelFast,
}: {
	statusLine: string;
	composerNotice: string | null;
	errorMessage: string | null;
	composer: string;
	pendingShellResultCount: number;
	selectedWorkspacePath?: string;
	pendingUiRequest: boolean;
	isStreaming: boolean;
	isShellRunning: boolean;
	contextLeftPercent: number | null;
	model?: {
		current?: string;
		provider?: string;
		models: string[];
		reasoning?: string;
		fast?: boolean;
	};
	git?: {
		branch?: string | null;
		branches: string[];
		isDirty?: boolean;
	};
	onComposerChange: (value: string) => void;
	onSend: () => Promise<void>;
	onCancel: () => Promise<void>;
	onSwitchBranch: (branch: string) => Promise<void>;
	onUpdateModel: (value: string) => Promise<void>;
	onUpdateModelReasoning: (value: ReasoningLevel) => Promise<void>;
	onUpdateModelFast: (value: boolean) => Promise<void>;
}) => {
	const branchMenuRef = useRef<HTMLDivElement | null>(null);
	const [branchMenuOpen, setBranchMenuOpen] = useState(false);
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
	const branchOptions = [
		...new Set([
			...(git?.branch ? [git.branch] : []),
			...(git?.branches ?? []),
		]),
	];
	const branchPickerDisabled = !git?.branch || branchOptions.length === 0;

	useEffect(() => {
		if (!branchMenuOpen) {
			return;
		}
		const closeBranchMenu = (event: MouseEvent) => {
			if (
				branchMenuRef.current &&
				!branchMenuRef.current.contains(event.target as Node)
			) {
				setBranchMenuOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setBranchMenuOpen(false);
			}
		};
		window.addEventListener("mousedown", closeBranchMenu);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", closeBranchMenu);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [branchMenuOpen]);

	useEffect(() => {
		if (branchPickerDisabled && branchMenuOpen) {
			setBranchMenuOpen(false);
		}
	}, [branchMenuOpen, branchPickerDisabled]);

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
					<div className="composer-left-actions">
						<button
							type="button"
							className="button button-subtle composer-inline-command"
							aria-label="Slash commands"
							title="Slash commands"
							onClick={() => onComposerChange("/")}
							disabled={composerDisabled || composer.length > 0}
						>
							<span>/</span>
						</button>
						<button
							type="button"
							className="button button-subtle composer-inline-command"
							aria-label="Shell command"
							title="Shell command"
							onClick={() => onComposerChange("!")}
							disabled={composerDisabled || composer.length > 0}
						>
							<span>!</span>
						</button>
					</div>
					<div className="composer-actions">
						{isStreaming ? (
							<button
								type="button"
								className="button primary icon-button composer-stop-button"
								onClick={() => void onCancel()}
								aria-label="Stop"
								title="Stop"
							>
								<Square {...uiIconProps} className="button-icon" />
							</button>
						) : (
							<button
								type="button"
								className="button primary icon-button composer-send-button"
								onClick={() => void onSend()}
								aria-label="Send"
								title="Send"
								disabled={!selectedWorkspacePath || isShellRunning}
							>
								<SendHorizontal {...uiIconProps} className="button-icon" />
							</button>
						)}
					</div>
				</div>
				<div className="composer-meta">
					<div className="composer-settings">
						<div className="composer-branch-control" ref={branchMenuRef}>
							<GitBranch {...uiIconProps} className="composer-branch-icon" />
							<button
								type="button"
								className="composer-branch-button"
								aria-label="Git branch"
								aria-haspopup="listbox"
								aria-expanded={branchMenuOpen}
								disabled={branchPickerDisabled}
								title={git?.branch ?? "no-git"}
								onClick={() => setBranchMenuOpen((current) => !current)}
							>
								<span>{git?.branch ?? "no-git"}</span>
							</button>
							{branchMenuOpen ? (
								<div className="composer-branch-menu" role="listbox">
									{branchOptions.map((branch) => (
										<button
											type="button"
											key={branch}
											className={`composer-branch-option${
												branch === git?.branch ? " is-selected" : ""
											}`}
											role="option"
											aria-selected={branch === git?.branch}
											title={branch}
											onClick={() => {
												setBranchMenuOpen(false);
												void onSwitchBranch(branch);
											}}
										>
											<span>{branch}</span>
										</button>
									))}
								</div>
							) : null}
							{git?.isDirty ? (
								<span className="composer-branch-dirty">dirty</span>
							) : null}
						</div>
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
					<div className="composer-context-meter">
						<span>context left</span>
						<strong>
							{contextLeftPercent !== null ? `${contextLeftPercent}%` : "unknown"}
						</strong>
					</div>
				</div>
			</div>
		</footer>
	);
};
