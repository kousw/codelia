import { useEffect, useRef, useState } from "react";
import type { DesktopSkillSummary } from "../../../shared/types";
import { slashCommandMatches } from "../../command-catalog";
import {
	SendHorizontal,
	Sparkles,
	Square,
	SquareSlash,
	Terminal,
	uiIconProps,
} from "../../icons";
import { ComposerBranchPicker } from "./ComposerBranchPicker";
import { ComposerModelControls } from "./ComposerModelControls";
import type {
	ComposerGitState,
	ComposerModelState,
	ReasoningLevel,
} from "./composer-types";

const COMPOSER_MODE_PREFIXES = new Set(["/", "$", "!"]);

export const switchComposerModeValue = (
	composer: string,
	prefix: "/" | "$" | "!",
): string =>
	COMPOSER_MODE_PREFIXES.has(composer[0] ?? "")
		? `${prefix}${composer.slice(1)}`
		: prefix;

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
	onLoadSkills,
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
	model?: ComposerModelState;
	git?: ComposerGitState;
	onComposerChange: (value: string) => void;
	onLoadSkills: (workspacePath: string) => Promise<DesktopSkillSummary[]>;
	onSend: () => Promise<void>;
	onCancel: () => Promise<void>;
	onSwitchBranch: (branch: string) => Promise<void>;
	onUpdateModel: (value: string) => Promise<void>;
	onUpdateModelReasoning: (value: ReasoningLevel) => Promise<void>;
	onUpdateModelFast: (value: boolean) => Promise<void>;
}) => {
	const skillsLoadingWorkspaceRef = useRef<string | null>(null);
	const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
	const [slashHelperDismissed, setSlashHelperDismissed] = useState(false);
	const [skillSelectedIndex, setSkillSelectedIndex] = useState(0);
	const [skillHelperDismissed, setSkillHelperDismissed] = useState(false);
	const [skills, setSkills] = useState<DesktopSkillSummary[]>([]);
	const [skillsLoadedForWorkspace, setSkillsLoadedForWorkspace] = useState<
		string | null
	>(null);
	const [skillsLoading, setSkillsLoading] = useState(false);
	const isSlashCommandMode = composer.trimStart().startsWith("/");
	const isShellCommandMode = composer.trimStart().startsWith("!");
	const isSkillMentionMode = composer.trimStart().startsWith("$");
	const hasComposerText = composer.trim().length > 0;
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
		!slashHelperDismissed &&
		composer.trimStart().startsWith("/") &&
		composer.length > 0 &&
		slashSuggestions.length > 0;
	const activeSlashSuggestion = showSlashHelper
		? slashSuggestions[slashSelectedIndex]
		: undefined;
	const activeSlashOptionId = activeSlashSuggestion
		? `composer-command-option-${activeSlashSuggestion.command.slice(1)}`
		: undefined;
	const skillQuery = isSkillMentionMode
		? (composer.trimStart().split(/\s+/, 1)[0] ?? "").slice(1).toLowerCase()
		: "";
	const skillSuggestions = isSkillMentionMode
		? skills
				.filter((skill) => skill.title.toLowerCase().startsWith(skillQuery))
				.slice(0, 12)
		: [];
	const showSkillHelper =
		!composerDisabled &&
		!skillHelperDismissed &&
		isSkillMentionMode &&
		composer.length > 0 &&
		(skillSuggestions.length > 0 || skillsLoading);
	const activeSkillSuggestion = showSkillHelper
		? skillSuggestions[skillSelectedIndex]
		: undefined;
	const activeSkillOptionId = activeSkillSuggestion
		? `composer-skill-option-${activeSkillSuggestion.title}`
		: undefined;
	const canSwitchComposerMode =
		composer.trim().length === 0 ||
		COMPOSER_MODE_PREFIXES.has(composer[0] ?? "");
	const resetComposerHelpers = () => {
		setSlashSelectedIndex(0);
		setSlashHelperDismissed(false);
		setSkillSelectedIndex(0);
		setSkillHelperDismissed(false);
	};
	const updateComposerFromInput = (value: string) => {
		resetComposerHelpers();
		onComposerChange(value);
	};
	const switchComposerMode = (prefix: "/" | "$" | "!") => {
		resetComposerHelpers();
		onComposerChange(switchComposerModeValue(composer, prefix));
	};
	const fillSlashSuggestion = (insertText: string) => {
		setSlashHelperDismissed(true);
		onComposerChange(insertText);
	};
	const fillSkillSuggestion = (skillName: string) => {
		setSkillHelperDismissed(true);
		onComposerChange(`$${skillName} `);
	};

	useEffect(() => {
		if (slashSelectedIndex >= slashSuggestions.length) {
			setSlashSelectedIndex(Math.max(0, slashSuggestions.length - 1));
		}
	}, [slashSelectedIndex, slashSuggestions.length]);

	useEffect(() => {
		if (skillSelectedIndex >= skillSuggestions.length) {
			setSkillSelectedIndex(Math.max(0, skillSuggestions.length - 1));
		}
	}, [skillSelectedIndex, skillSuggestions.length]);

	useEffect(() => {
		if (
			!isSkillMentionMode ||
			!selectedWorkspacePath ||
			skillsLoadedForWorkspace === selectedWorkspacePath ||
			skillsLoadingWorkspaceRef.current === selectedWorkspacePath
		) {
			return;
		}
		let cancelled = false;
		skillsLoadingWorkspaceRef.current = selectedWorkspacePath;
		setSkillsLoading(true);
		onLoadSkills(selectedWorkspacePath)
			.then((loadedSkills) => {
				if (cancelled) return;
				setSkills(loadedSkills);
				setSkillsLoadedForWorkspace(selectedWorkspacePath);
			})
			.catch(() => {
				if (cancelled) return;
				setSkills([]);
				setSkillsLoadedForWorkspace(selectedWorkspacePath);
			})
			.finally(() => {
				if (cancelled) return;
				if (skillsLoadingWorkspaceRef.current === selectedWorkspacePath) {
					skillsLoadingWorkspaceRef.current = null;
				}
				setSkillsLoading(false);
			});
		return () => {
			cancelled = true;
			if (skillsLoadingWorkspaceRef.current === selectedWorkspacePath) {
				skillsLoadingWorkspaceRef.current = null;
			}
		};
	}, [
		isSkillMentionMode,
		onLoadSkills,
		selectedWorkspacePath,
		skillsLoadedForWorkspace,
	]);

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
				<div
					className={`composer-input-row${
						isShellCommandMode ? " is-shell-command-mode" : ""
					}`}
				>
					{showSlashHelper ? (
						<div
							className="composer-command-helper"
							id="composer-command-helper"
							role="listbox"
						>
							<div className="composer-command-helper-header">
								<span>Slash commands</span>
								<span>Enter to fill</span>
							</div>
							<div className="composer-command-helper-list">
								{slashSuggestions.map((spec, index) => (
									<button
										type="button"
										key={spec.command}
										id={`composer-command-option-${spec.command.slice(1)}`}
										className={`composer-command-option${
											index === slashSelectedIndex ? " is-selected" : ""
										}`}
										role="option"
										aria-selected={index === slashSelectedIndex}
										onMouseDown={(event) => event.preventDefault()}
										onMouseEnter={() => setSlashSelectedIndex(index)}
										onClick={() => fillSlashSuggestion(spec.insertText)}
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
					{showSkillHelper ? (
						<div
							className="composer-command-helper composer-skill-helper"
							id="composer-skill-helper"
							role="listbox"
						>
							<div className="composer-command-helper-header">
								<span>Skills</span>
								<span>{skillsLoading ? "Loading" : "Enter to fill"}</span>
							</div>
							<div className="composer-command-helper-list">
								{skillsLoading && skillSuggestions.length === 0 ? (
									<div className="composer-command-option is-muted">
										<span className="composer-command-usage">$</span>
										<span className="composer-command-summary">
											Loading installed skills...
										</span>
									</div>
								) : (
									skillSuggestions.map((skill, index) => (
										<button
											type="button"
											key={skill.filePath ?? skill.title}
											id={`composer-skill-option-${skill.title}`}
											className={`composer-command-option${
												index === skillSelectedIndex ? " is-selected" : ""
											}`}
											role="option"
											aria-selected={index === skillSelectedIndex}
											onMouseDown={(event) => event.preventDefault()}
											onMouseEnter={() => setSkillSelectedIndex(index)}
											onClick={() => fillSkillSuggestion(skill.title)}
										>
											<span className="composer-command-usage">
												${skill.title}
											</span>
											<span className="composer-command-summary">
												{skill.description ?? skill.filePath ?? ""}
											</span>
										</button>
									))
								)}
							</div>
						</div>
					) : null}
					<textarea
						id="composer"
						className="textarea composer-textarea"
						placeholder={
							isShellCommandMode
								? "Run a shell command in this workspace..."
								: "Ask Codelia to inspect, implement, or explain..."
						}
						disabled={composerDisabled}
						value={composer}
						aria-controls={
							showSlashHelper
								? "composer-command-helper"
								: showSkillHelper
									? "composer-skill-helper"
									: undefined
						}
						aria-activedescendant={activeSlashOptionId ?? activeSkillOptionId}
						onChange={(event) => updateComposerFromInput(event.target.value)}
						onKeyDown={(event) => {
							if (showSlashHelper) {
								if (event.key === "ArrowDown") {
									event.preventDefault();
									setSlashSelectedIndex(
										(index) => (index + 1) % slashSuggestions.length,
									);
									return;
								}
								if (event.key === "ArrowUp") {
									event.preventDefault();
									setSlashSelectedIndex(
										(index) =>
											(index - 1 + slashSuggestions.length) %
											slashSuggestions.length,
									);
									return;
								}
								if (event.key === "Enter" || event.key === "Tab") {
									if (activeSlashSuggestion) {
										event.preventDefault();
										fillSlashSuggestion(activeSlashSuggestion.insertText);
									}
									return;
								}
								if (event.key === "Escape") {
									event.preventDefault();
									setSlashHelperDismissed(true);
									return;
								}
							}
							if (showSkillHelper && skillSuggestions.length > 0) {
								if (event.key === "ArrowDown") {
									event.preventDefault();
									setSkillSelectedIndex(
										(index) => (index + 1) % skillSuggestions.length,
									);
									return;
								}
								if (event.key === "ArrowUp") {
									event.preventDefault();
									setSkillSelectedIndex(
										(index) =>
											(index - 1 + skillSuggestions.length) %
											skillSuggestions.length,
									);
									return;
								}
								if (event.key === "Enter" || event.key === "Tab") {
									if (activeSkillSuggestion) {
										event.preventDefault();
										fillSkillSuggestion(activeSkillSuggestion.title);
									}
									return;
								}
								if (event.key === "Escape") {
									event.preventDefault();
									setSkillHelperDismissed(true);
									return;
								}
							}
							if (
								isShellCommandMode &&
								event.key === "Enter" &&
								!event.shiftKey
							) {
								event.preventDefault();
								void onSend();
								return;
							}
							if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
								event.preventDefault();
								void onSend();
							}
						}}
					/>
					<div className="composer-left-actions">
						<button
							type="button"
							className={`button button-subtle composer-inline-command${
								isSlashCommandMode ? " is-active" : ""
							}`}
							aria-label="Slash commands"
							aria-pressed={isSlashCommandMode}
							title="Slash commands"
							onClick={() => switchComposerMode("/")}
							disabled={composerDisabled || !canSwitchComposerMode}
						>
							<SquareSlash
								{...uiIconProps}
								size={13}
								className="composer-inline-command-icon"
							/>
							<span>Command</span>
						</button>
						<button
							type="button"
							className={`button button-subtle composer-inline-command${
								isSkillMentionMode ? " is-active" : ""
							}`}
							aria-label="Skill mention"
							aria-pressed={isSkillMentionMode}
							title="Skill mention"
							onClick={() => switchComposerMode("$")}
							disabled={composerDisabled || !canSwitchComposerMode}
						>
							<Sparkles
								{...uiIconProps}
								size={12}
								className="composer-inline-command-icon"
							/>
							<span>Skill</span>
						</button>
						<button
							type="button"
							className={`button button-subtle composer-inline-command${
								isShellCommandMode ? " is-active" : ""
							}`}
							aria-label="Shell command"
							aria-pressed={isShellCommandMode}
							title="Shell command"
							onClick={() => switchComposerMode("!")}
							disabled={composerDisabled || !canSwitchComposerMode}
						>
							<Terminal
								{...uiIconProps}
								size={12}
								className="composer-inline-command-icon"
							/>
							<span>Shell</span>
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
								aria-label={isShellCommandMode ? "Run command" : "Send"}
								title={isShellCommandMode ? "Run command" : "Send"}
								disabled={
									!selectedWorkspacePath || isShellRunning || !hasComposerText
								}
							>
								<SendHorizontal {...uiIconProps} className="button-icon" />
							</button>
						)}
					</div>
				</div>
				<div className="composer-meta">
					<div className="composer-settings">
						<ComposerBranchPicker git={git} onSwitchBranch={onSwitchBranch} />
						<ComposerModelControls
							model={model}
							onUpdateModel={onUpdateModel}
							onUpdateModelReasoning={onUpdateModelReasoning}
							onUpdateModelFast={onUpdateModelFast}
						/>
					</div>
					<div className="composer-context-meter">
						<span>context left</span>
						<strong>
							{contextLeftPercent !== null
								? `${contextLeftPercent}%`
								: "unknown"}
						</strong>
					</div>
				</div>
			</div>
		</footer>
	);
};
