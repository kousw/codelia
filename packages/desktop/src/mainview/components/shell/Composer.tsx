import type { DesktopWorkspace } from "../../../shared/types";
import { SendHorizontal, Square, uiIconProps } from "../../icons";

type ReasoningLevel = "low" | "medium" | "high" | "xhigh";

const REASONING_LEVELS: ReasoningLevel[] = ["low", "medium", "high", "xhigh"];

export const Composer = ({
	workspace,
	statusLine,
	errorMessage,
	composer,
	selectedWorkspacePath,
	pendingUiRequest,
	isStreaming,
	model,
	onComposerChange,
	onSend,
	onCancel,
	onUpdateModel,
	onUpdateModelReasoning,
}: {
	workspace?: DesktopWorkspace;
	statusLine: string;
	errorMessage: string | null;
	composer: string;
	selectedWorkspacePath?: string;
	pendingUiRequest: boolean;
	isStreaming: boolean;
	model?: {
		current?: string;
		provider?: string;
		models: string[];
		reasoning?: string;
	};
	onComposerChange: (value: string) => void;
	onSend: () => Promise<void>;
	onCancel: () => Promise<void>;
	onUpdateModel: (value: string) => Promise<void>;
	onUpdateModelReasoning: (value: ReasoningLevel) => Promise<void>;
}) => {
	const composerDisabled = !selectedWorkspacePath || pendingUiRequest;

	return (
		<footer className="composer">
			<div className="statusbar">
				<span>{statusLine}</span>
				{errorMessage ? (
					<span className="error-banner">{errorMessage}</span>
				) : null}
			</div>
			<textarea
				id="composer"
				className="textarea"
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
			<div className="composer-toolbar">
				<div className="composer-actions">
					<button
						type="button"
						className="button primary has-icon"
						onClick={() => void onSend()}
						disabled={!selectedWorkspacePath || isStreaming}
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
			<div className="composer-meta">
				<span className={`pill${workspace?.is_dirty ? " is-warning" : ""}`}>
					{workspace
						? `${workspace.branch ?? "no-git"}${workspace.is_dirty ? " • dirty" : ""}`
						: "workspace idle"}
				</span>
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
						void onUpdateModelReasoning(event.target.value as ReasoningLevel)
					}
				>
					{REASONING_LEVELS.map((reasoning) => (
						<option key={reasoning} value={reasoning}>
							{reasoning}
						</option>
					))}
				</select>
			</div>
		</footer>
	);
};
