import type { AssistantRenderRow } from "../../controller";
import { GeneratedUiPanel } from "../GeneratedUiPanel";
import { AssistantMarkdown } from "./AssistantMarkdown";

export const AssistantTurn = ({
	rows,
	onOpenLink,
}: {
	rows: AssistantRenderRow[];
	onOpenLink: (href: string) => Promise<void>;
}) => {
	return (
		<article className="assistant-turn">
			<div className="assistant-heading">
				<strong className="bubble-author">Codelia</strong>
			</div>
			<div className="timeline-stack">
				{rows.map((row) =>
					row.kind === "html" ? (
						// biome-ignore lint/security/noDangerouslySetInnerHtml: Timeline rows are generated locally with escaped dynamic content.
						<div key={row.key} dangerouslySetInnerHTML={{ __html: row.html }} />
					) : row.kind === "generated_ui" ? (
						<GeneratedUiPanel key={row.key} payload={row.payload} />
					) : (
						<AssistantMarkdown
							key={row.key}
							content={row.content}
							finalized={row.finalized}
							onOpenLink={onOpenLink}
						/>
					),
				)}
			</div>
		</article>
	);
};
