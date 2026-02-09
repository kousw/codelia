import { useState } from "react";

type Props = {
	content: string;
};

export const ReasoningBlock = ({ content }: Props) => {
	const [expanded, setExpanded] = useState(false);

	return (
		<div className="az-reasoning">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				className="az-reasoning-head"
			>
				<span>Reasoning</span>
				<span className="az-chevron">{expanded ? "^" : "v"}</span>
			</button>
			{expanded ? <pre className="az-reasoning-body">{content}</pre> : null}
		</div>
	);
};
