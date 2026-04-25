import type { JSX } from "react";
import type {
	GeneratedUiFlowEdge,
	GeneratedUiFlowNode,
	GeneratedUiStructureEntity,
	GeneratedUiStructureRelation,
} from "../../../../../protocol/src/index";
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
} from "../../layout/generated-ui-graph-layout";

const textLabel = (label: string, x: number, y: number): JSX.Element | null =>
	label ? (
		<text x={x} y={y} className="generated-ui-flow-link-label">
			{label}
		</text>
	) : null;

export const GeneratedUiFlowDiagram = ({
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

export const GeneratedUiStructureMap = ({
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
