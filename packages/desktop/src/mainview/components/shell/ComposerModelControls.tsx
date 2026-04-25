import { uiIconProps, Zap } from "../../icons";
import {
	type ComposerModelState,
	REASONING_LEVELS,
	type ReasoningLevel,
} from "./composer-types";

export const ComposerModelControls = ({
	model,
	onUpdateModel,
	onUpdateModelReasoning,
	onUpdateModelFast,
}: {
	model?: ComposerModelState;
	onUpdateModel: (value: string) => Promise<void>;
	onUpdateModelReasoning: (value: ReasoningLevel) => Promise<void>;
	onUpdateModelFast: (value: boolean) => Promise<void>;
}) => {
	return (
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
					void onUpdateModelReasoning(event.target.value as ReasoningLevel)
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
	);
};
