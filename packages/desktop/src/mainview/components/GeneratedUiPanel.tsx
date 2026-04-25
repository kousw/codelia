import type { JSX } from "react";
import type {
	GeneratedUiChartItem,
	GeneratedUiDocument,
	GeneratedUiFlowEdge,
	GeneratedUiFlowNode,
	GeneratedUiNode,
	GeneratedUiStructureEntity,
	GeneratedUiStructureRelation,
} from "../../../../protocol/src/index";
import {
	buildFlowEdgeGeometry,
	buildFlowLayout,
	buildStructureLayout,
	buildStructureRelationGeometry,
	FLOW_NODE_HEIGHT,
	FLOW_NODE_WIDTH,
	STRUCTURE_MARGIN,
	STRUCTURE_NODE_HEIGHT,
	STRUCTURE_NODE_WIDTH,
} from "../layout/generated-ui-graph-layout";

const BAR_CHART_WIDTH = 240;

const GeneratedUiBarChart = ({
	title,
	max,
	items,
}: {
	title: string;
	max: number | null;
	items: GeneratedUiChartItem[];
}) => {
	const resolvedMax = Math.max(
		max ?? 0,
		...items.map((item) => Math.max(0, item.value)),
		1,
	);
	return (
		<section className="generated-ui-chart">
			{title ? <div className="generated-ui-group-title">{title}</div> : null}
			<div className="generated-ui-chart-body">
				{items.map((item, index) => (
					<div
						key={`${item.label}-${index}`}
						className="generated-ui-chart-row"
					>
						<div className="generated-ui-chart-label">{item.label}</div>
						<div className="generated-ui-chart-track">
							<div
								className={`generated-ui-chart-fill tone-${item.tone}`}
								style={{
									width: `${Math.max(
										8,
										(item.value / resolvedMax) * BAR_CHART_WIDTH,
									)}px`,
								}}
							/>
						</div>
						<div className="generated-ui-chart-value">{item.value}</div>
					</div>
				))}
			</div>
		</section>
	);
};

const GeneratedUiFlowDiagram = ({
	title,
	direction,
	nodes,
	edges,
}: {
	title: string;
	direction: "horizontal" | "vertical";
	nodes: GeneratedUiFlowNode[];
	edges: GeneratedUiFlowEdge[];
}) => {
	const { width, height, positions } = buildFlowLayout(nodes, direction);
	return (
		<section className="generated-ui-flow">
			{title ? <div className="generated-ui-group-title">{title}</div> : null}
			<div className="generated-ui-flow-wrap">
				<svg
					className="generated-ui-flow-diagram"
					viewBox={`0 0 ${Math.max(width, 1)} ${Math.max(height, 1)}`}
					role="img"
					aria-label={title || "Flow diagram"}
				>
					{edges.map((edge, index) => {
						const geometry = buildFlowEdgeGeometry(edge, positions, direction);
						if (!geometry) {
							return null;
						}
						return (
							<g key={`${edge.from}-${edge.to}-${index}`}>
								<path d={geometry.path} className="generated-ui-flow-link" />
								<circle
									cx={geometry.endX}
									cy={geometry.endY}
									r="3"
									className="generated-ui-flow-link-dot"
								/>
								{textLabel(edge.label, geometry.labelX, geometry.labelY)}
							</g>
						);
					})}
					{nodes.map((node) => {
						const position = positions.get(node.id);
						if (!position) {
							return null;
						}
						return (
							<g
								key={node.id}
								transform={`translate(${position.x}, ${position.y})`}
							>
								<rect
									width={FLOW_NODE_WIDTH}
									height={FLOW_NODE_HEIGHT}
									rx="10"
									className={`generated-ui-flow-node-bg tone-${node.tone}`}
								/>
								<text
									x={FLOW_NODE_WIDTH / 2}
									y={FLOW_NODE_HEIGHT / 2 + 4}
									className="generated-ui-flow-node-label"
								>
									{node.label}
								</text>
							</g>
						);
					})}
				</svg>
			</div>
		</section>
	);
};

const textLabel = (label: string, x: number, y: number): JSX.Element | null =>
	label ? (
		<text x={x} y={y} className="generated-ui-flow-link-label">
			{label}
		</text>
	) : null;

const GeneratedUiStructureMap = ({
	title,
	entities,
	relations,
}: {
	title: string;
	entities: GeneratedUiStructureEntity[];
	relations: GeneratedUiStructureRelation[];
}) => {
	const entityMap = new Map(entities.map((entity) => [entity.id, entity]));
	const {
		positions,
		width: graphWidth,
		height: graphHeight,
	} = buildStructureLayout(entities, relations);

	const truncateSvgText = (value: string, maxLength: number): string =>
		value.length > maxLength
			? `${value.slice(0, Math.max(0, maxLength - 1))}…`
			: value;

	const relationStroke = (
		kind: GeneratedUiStructureRelation["kind"],
	): string => {
		switch (kind) {
			case "extends":
			case "implements":
				return "var(--accent-ink)";
			case "contains":
				return "#6d7782";
			case "calls":
			case "emits":
				return "#8f6a24";
			case "returns":
				return "#356753";
			default:
				return "#87919d";
		}
	};

	return (
		<section className="generated-ui-structure-map">
			{title ? <div className="generated-ui-group-title">{title}</div> : null}
			<div className="generated-ui-structure-diagram-wrap">
				<svg
					className="generated-ui-structure-diagram"
					viewBox={`0 0 ${Math.max(graphWidth, 1)} ${Math.max(graphHeight + STRUCTURE_MARGIN, 1)}`}
					role="img"
					aria-label={title || "Structure map"}
				>
					{relations.map((relation, index) => {
						const geometry = buildStructureRelationGeometry(
							relation,
							positions,
						);
						if (!geometry) {
							return null;
						}
						return (
							<g key={`${relation.from}-${relation.to}-${index}`}>
								<path
									d={geometry.path}
									className={`generated-ui-structure-link is-${relation.kind}`}
									style={{ stroke: relationStroke(relation.kind) }}
								/>
								<circle
									cx={geometry.endX}
									cy={geometry.endY}
									r="3"
									className={`generated-ui-structure-link-dot is-${relation.kind}`}
									style={{ fill: relationStroke(relation.kind) }}
								/>
								<text
									x={geometry.labelX}
									y={geometry.labelY}
									className="generated-ui-structure-link-label"
								>
									{relation.label || relation.kind}
								</text>
							</g>
						);
					})}
					{entities.map((entity) => {
						const position = positions.get(entity.id);
						if (!position) {
							return null;
						}
						const previewMembers = entity.members.slice(0, 2);
						return (
							<g
								key={entity.id}
								transform={`translate(${position.x}, ${position.y})`}
							>
								<rect
									width={STRUCTURE_NODE_WIDTH}
									height={STRUCTURE_NODE_HEIGHT}
									rx="12"
									className="generated-ui-structure-node-bg"
								/>
								<text
									x="14"
									y="18"
									className="generated-ui-structure-node-kind"
								>
									{entity.kind.toUpperCase()}
								</text>
								<text
									x="14"
									y="38"
									className="generated-ui-structure-node-title"
								>
									{truncateSvgText(entity.title, 24)}
								</text>
								{entity.subtitle ? (
									<text
										x="14"
										y="54"
										className="generated-ui-structure-node-subtitle"
									>
										{truncateSvgText(entity.subtitle, 28)}
									</text>
								) : null}
								{previewMembers.map((member, memberIndex) => (
									<text
										key={`${member.label}-${memberIndex}`}
										x="14"
										y={74 + memberIndex * 14}
										className={`generated-ui-structure-node-member tone-${member.tone}`}
									>
										{truncateSvgText(member.label, 28)}
									</text>
								))}
							</g>
						);
					})}
				</svg>
			</div>
			<div className="generated-ui-structure-grid">
				{entities.map((entity) => (
					<section key={entity.id} className="generated-ui-structure-card">
						<header className="generated-ui-structure-card-head">
							<div className="generated-ui-structure-kind">{entity.kind}</div>
							<h4 className="generated-ui-structure-title">{entity.title}</h4>
							{entity.subtitle ? (
								<div className="generated-ui-structure-subtitle">
									{entity.subtitle}
								</div>
							) : null}
						</header>
						<div className="generated-ui-structure-members">
							{entity.members.map((member, index) => (
								<div
									key={`${member.label}-${index}`}
									className="generated-ui-structure-member"
								>
									<div
										className={`generated-ui-structure-member-label tone-${member.tone}`}
									>
										{member.label}
									</div>
									{member.detail ? (
										<div className="generated-ui-structure-member-detail">
											{member.detail}
										</div>
									) : null}
								</div>
							))}
						</div>
					</section>
				))}
			</div>
			{relations.length > 0 ? (
				<div className="generated-ui-structure-relations">
					<div className="generated-ui-structure-relations-title">
						Relations
					</div>
					<div className="generated-ui-structure-relation-list">
						{relations.map((relation, index) => (
							<div
								key={`${relation.from}-${relation.to}-${index}`}
								className="generated-ui-structure-relation"
							>
								<span className="generated-ui-structure-relation-endpoint">
									{entityMap.get(relation.from)?.title ?? relation.from}
								</span>
								<span className="generated-ui-structure-relation-kind">
									{relation.kind}
								</span>
								<span className="generated-ui-structure-relation-endpoint">
									{entityMap.get(relation.to)?.title ?? relation.to}
								</span>
								{relation.label ? (
									<span className="generated-ui-structure-relation-label">
										{relation.label}
									</span>
								) : null}
							</div>
						))}
					</div>
				</div>
			) : null}
		</section>
	);
};

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
