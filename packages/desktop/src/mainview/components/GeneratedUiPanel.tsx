import type {
	GeneratedUiDocument,
	GeneratedUiNode,
} from "../../../../protocol/src/index";
import { GeneratedUiBarChart } from "./generated-ui/ChartNodes";
import {
	GeneratedUiFlowDiagram,
	GeneratedUiStructureMap,
} from "./generated-ui/GraphNodes";

const GeneratedUiNodeView = ({ node }: { node: GeneratedUiNode }) => {
	switch (node.type) {
		case "heading": {
			const Tag = node.level === 1 ? "h3" : node.level === 2 ? "h4" : "h5";
			return (
				<Tag className={`generated-ui-heading tone-${node.tone}`}>
					{node.text}
				</Tag>
			);
		}
		case "text":
			return (
				<p className={`generated-ui-text tone-${node.tone}`}>{node.text}</p>
			);
		case "badge_row":
			return (
				<div className="generated-ui-badge-row">
					{node.items.map((item, index) => (
						<span
							key={`${item.label}-${index}`}
							className={`generated-ui-badge tone-${item.tone}`}
						>
							{item.label}
						</span>
					))}
				</div>
			);
		case "key_value":
			return (
				<dl className="generated-ui-key-value">
					{node.items.map((item, index) => (
						<div key={`${item.label}-${index}`} className="generated-ui-kv-row">
							<dt>{item.label}</dt>
							<dd className={`tone-${item.tone}`}>{item.value}</dd>
						</div>
					))}
				</dl>
			);
		case "list":
			return node.ordered ? (
				<ol className="generated-ui-list is-ordered">
					{node.items.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ol>
			) : (
				<ul className="generated-ui-list">
					{node.items.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
			);
		case "table":
			return (
				<div className="generated-ui-table-wrap">
					<table className="generated-ui-table">
						<thead>
							<tr>
								{node.columns.map((column) => (
									<th key={column}>{column}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{node.rows.map((row) => (
								<tr key={row.join("\u001f")}>
									{node.columns.map((column, columnIndex) => (
										<td key={column}>{row[columnIndex] ?? ""}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		case "bar_chart":
			return (
				<GeneratedUiBarChart
					title={node.title}
					max={node.max}
					items={node.items}
				/>
			);
		case "flow_diagram":
			return (
				<GeneratedUiFlowDiagram
					title={node.title}
					direction={node.direction}
					nodes={node.nodes}
					edges={node.edges}
				/>
			);
		case "structure_map":
			return (
				<GeneratedUiStructureMap
					title={node.title}
					entities={node.entities}
					relations={node.relations}
				/>
			);
		case "code":
			return (
				<section className="generated-ui-code-block">
					{node.title ? (
						<div className="generated-ui-code-title">{node.title}</div>
					) : null}
					<pre>
						<code data-language={node.language || undefined}>{node.code}</code>
					</pre>
				</section>
			);
		case "group":
			return (
				<section className="generated-ui-group">
					{node.title ? (
						<div className="generated-ui-group-title">{node.title}</div>
					) : null}
					<div className="generated-ui-group-body">
						{node.children.map((child, index) => (
							<GeneratedUiNodeView
								key={`${child.type}-${index}`}
								node={child}
							/>
						))}
					</div>
				</section>
			);
	}
};

export const GeneratedUiPanel = ({
	payload,
}: {
	payload: GeneratedUiDocument;
}) => {
	return (
		<section className="generated-ui-panel">
			<header className="generated-ui-panel-head">
				<div className="generated-ui-panel-kicker">Structured View</div>
				<h3 className="generated-ui-panel-title">{payload.title}</h3>
				<p className="generated-ui-panel-summary">{payload.summary}</p>
			</header>
			<div className="generated-ui-panel-body">
				{payload.nodes.map((node, index) => (
					<GeneratedUiNodeView key={`${node.type}-${index}`} node={node} />
				))}
			</div>
		</section>
	);
};
