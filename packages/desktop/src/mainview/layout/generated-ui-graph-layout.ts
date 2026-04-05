import type {
	GeneratedUiFlowEdge,
	GeneratedUiFlowNode,
	GeneratedUiStructureEntity,
	GeneratedUiStructureRelation,
} from "../../../../protocol/src/index";

export const FLOW_NODE_WIDTH = 124;
export const FLOW_NODE_HEIGHT = 34;
const FLOW_NODE_GAP = 56;
const FLOW_MARGIN = 18;
export const STRUCTURE_NODE_WIDTH = 220;
export const STRUCTURE_NODE_HEIGHT = 96;
const STRUCTURE_COLUMN_GAP = 72;
const STRUCTURE_ROW_GAP = 28;
export const STRUCTURE_MARGIN = 18;

type Point = { x: number; y: number };

export type FlowLayout = {
	width: number;
	height: number;
	positions: Map<string, Point>;
};

export type StructureLayout = {
	width: number;
	height: number;
	positions: Map<string, Point>;
};

export type EdgeGeometry = {
	path: string;
	labelX: number;
	labelY: number;
	endX: number;
	endY: number;
};

export const buildFlowLayout = (
	nodes: GeneratedUiFlowNode[],
	direction: "horizontal" | "vertical",
): FlowLayout => {
	const positions = new Map<string, Point>();
	for (const [index, node] of nodes.entries()) {
		const x =
			direction === "horizontal"
				? FLOW_MARGIN + index * (FLOW_NODE_WIDTH + FLOW_NODE_GAP)
				: FLOW_MARGIN;
		const y =
			direction === "horizontal"
				? FLOW_MARGIN
				: FLOW_MARGIN + index * (FLOW_NODE_HEIGHT + FLOW_NODE_GAP);
		positions.set(node.id, { x, y });
	}
	return {
		width:
			direction === "horizontal"
				? FLOW_MARGIN * 2 +
					nodes.length * FLOW_NODE_WIDTH +
					Math.max(0, nodes.length - 1) * FLOW_NODE_GAP
				: FLOW_MARGIN * 2 + FLOW_NODE_WIDTH,
		height:
			direction === "horizontal"
				? FLOW_MARGIN * 2 + FLOW_NODE_HEIGHT
				: FLOW_MARGIN * 2 +
					nodes.length * FLOW_NODE_HEIGHT +
					Math.max(0, nodes.length - 1) * FLOW_NODE_GAP,
		positions,
	};
};

const buildAdjacency = (
	entities: GeneratedUiStructureEntity[],
	relations: GeneratedUiStructureRelation[],
): Map<string, string[]> => {
	const entityIds = new Set(entities.map((entity) => entity.id));
	const adjacency = new Map<string, string[]>();
	for (const entity of entities) {
		adjacency.set(entity.id, []);
	}
	for (const relation of relations) {
		if (!entityIds.has(relation.from) || !entityIds.has(relation.to)) {
			continue;
		}
		adjacency.get(relation.from)?.push(relation.to);
	}
	return adjacency;
};

const findStronglyConnectedComponents = (
	adjacency: Map<string, string[]>,
): string[][] => {
	const stack: string[] = [];
	const indices = new Map<string, number>();
	const lowlinks = new Map<string, number>();
	const onStack = new Set<string>();
	const components: string[][] = [];
	let index = 0;

	const visit = (nodeId: string) => {
		indices.set(nodeId, index);
		lowlinks.set(nodeId, index);
		index += 1;
		stack.push(nodeId);
		onStack.add(nodeId);
		for (const nextId of adjacency.get(nodeId) ?? []) {
			if (!indices.has(nextId)) {
				visit(nextId);
				lowlinks.set(
					nodeId,
					Math.min(lowlinks.get(nodeId) ?? 0, lowlinks.get(nextId) ?? 0),
				);
				continue;
			}
			if (onStack.has(nextId)) {
				lowlinks.set(
					nodeId,
					Math.min(lowlinks.get(nodeId) ?? 0, indices.get(nextId) ?? 0),
				);
			}
		}
		if ((lowlinks.get(nodeId) ?? -1) !== (indices.get(nodeId) ?? -2)) {
			return;
		}
		const component: string[] = [];
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) {
				break;
			}
			onStack.delete(current);
			component.push(current);
			if (current === nodeId) {
				break;
			}
		}
		components.push(component);
	};

	for (const nodeId of adjacency.keys()) {
		if (!indices.has(nodeId)) {
			visit(nodeId);
		}
	}
	return components;
};

const buildCondensedComponentLevels = (
	components: string[][],
	relations: GeneratedUiStructureRelation[],
): Map<string, number> => {
	const componentByEntity = new Map<string, number>();
	components.forEach((component, componentIndex) => {
		for (const entityId of component) {
			componentByEntity.set(entityId, componentIndex);
		}
	});

	const componentEdges = new Map<number, Set<number>>();
	const indegrees = new Array<number>(components.length).fill(0);
	for (
		let componentIndex = 0;
		componentIndex < components.length;
		componentIndex += 1
	) {
		componentEdges.set(componentIndex, new Set());
	}
	for (const relation of relations) {
		const fromComponent = componentByEntity.get(relation.from);
		const toComponent = componentByEntity.get(relation.to);
		if (
			fromComponent === undefined ||
			toComponent === undefined ||
			fromComponent === toComponent
		) {
			continue;
		}
		const neighbors = componentEdges.get(fromComponent);
		if (!neighbors?.has(toComponent)) {
			neighbors?.add(toComponent);
			indegrees[toComponent] += 1;
		}
	}

	const componentLevels = new Array<number>(components.length).fill(0);
	const queue: number[] = [];
	indegrees.forEach((indegree, componentIndex) => {
		if (indegree === 0) {
			queue.push(componentIndex);
		}
	});
	while (queue.length > 0) {
		const componentIndex = queue.shift();
		if (componentIndex === undefined) {
			break;
		}
		for (const nextIndex of componentEdges.get(componentIndex) ?? []) {
			componentLevels[nextIndex] = Math.max(
				componentLevels[nextIndex] ?? 0,
				(componentLevels[componentIndex] ?? 0) + 1,
			);
			indegrees[nextIndex] -= 1;
			if (indegrees[nextIndex] === 0) {
				queue.push(nextIndex);
			}
		}
	}

	const levelsByEntity = new Map<string, number>();
	components.forEach((component, componentIndex) => {
		for (const entityId of component) {
			levelsByEntity.set(entityId, componentLevels[componentIndex] ?? 0);
		}
	});
	return levelsByEntity;
};

export const buildStructureLayout = (
	entities: GeneratedUiStructureEntity[],
	relations: GeneratedUiStructureRelation[],
): StructureLayout => {
	const adjacency = buildAdjacency(entities, relations);
	const components = findStronglyConnectedComponents(adjacency);
	const levelsByEntity = buildCondensedComponentLevels(components, relations);

	const columns = new Map<number, GeneratedUiStructureEntity[]>();
	for (const entity of entities) {
		const level = levelsByEntity.get(entity.id) ?? 0;
		const column = columns.get(level) ?? [];
		column.push(entity);
		columns.set(level, column);
	}

	const sortedLevels = [...columns.keys()].sort((left, right) => left - right);
	const positions = new Map<string, Point>();
	let graphHeight = 0;
	for (const level of sortedLevels) {
		const column = columns.get(level) ?? [];
		column.forEach((entity, rowIndex) => {
			const x =
				STRUCTURE_MARGIN +
				level * (STRUCTURE_NODE_WIDTH + STRUCTURE_COLUMN_GAP);
			const y =
				STRUCTURE_MARGIN +
				rowIndex * (STRUCTURE_NODE_HEIGHT + STRUCTURE_ROW_GAP);
			positions.set(entity.id, { x, y });
			graphHeight = Math.max(graphHeight, y + STRUCTURE_NODE_HEIGHT);
		});
	}

	return {
		width:
			STRUCTURE_MARGIN * 2 +
			Math.max(1, sortedLevels.length) * STRUCTURE_NODE_WIDTH +
			Math.max(0, sortedLevels.length - 1) * STRUCTURE_COLUMN_GAP,
		height: Math.max(
			STRUCTURE_MARGIN * 2 + STRUCTURE_NODE_HEIGHT,
			graphHeight + STRUCTURE_MARGIN,
		),
		positions,
	};
};

export const buildFlowEdgeGeometry = (
	edge: GeneratedUiFlowEdge,
	positions: Map<string, Point>,
	direction: "horizontal" | "vertical",
): EdgeGeometry | null => {
	const from = positions.get(edge.from);
	const to = positions.get(edge.to);
	if (!from || !to) {
		return null;
	}
	if (edge.from === edge.to) {
		const loopStartX = from.x + FLOW_NODE_WIDTH - 12;
		const loopStartY = from.y + FLOW_NODE_HEIGHT / 2;
		return {
			path: `M ${loopStartX} ${loopStartY} C ${loopStartX + 24} ${loopStartY - 22}, ${loopStartX + 24} ${loopStartY + 22}, ${loopStartX} ${loopStartY + 8}`,
			labelX: loopStartX + 22,
			labelY: loopStartY - 18,
			endX: loopStartX,
			endY: loopStartY + 8,
		};
	}
	if (direction === "horizontal") {
		const forward = to.x >= from.x;
		const startX = from.x + (forward ? FLOW_NODE_WIDTH : 0);
		const endX = to.x + (forward ? 0 : FLOW_NODE_WIDTH);
		const startY = from.y + FLOW_NODE_HEIGHT / 2;
		const endY = to.y + FLOW_NODE_HEIGHT / 2;
		return {
			path: `M ${startX} ${startY} C ${startX + (forward ? 30 : -30)} ${startY}, ${endX + (forward ? -30 : 30)} ${endY}, ${endX} ${endY}`,
			labelX: (startX + endX) / 2,
			labelY: Math.min(startY, endY) - 8,
			endX,
			endY,
		};
	}
	const forward = to.y >= from.y;
	const startX = from.x + FLOW_NODE_WIDTH / 2;
	const endX = to.x + FLOW_NODE_WIDTH / 2;
	const startY = from.y + (forward ? FLOW_NODE_HEIGHT : 0);
	const endY = to.y + (forward ? 0 : FLOW_NODE_HEIGHT);
	return {
		path: `M ${startX} ${startY} C ${startX} ${startY + (forward ? 26 : -26)}, ${endX} ${endY + (forward ? -26 : 26)}, ${endX} ${endY}`,
		labelX: startX + 12,
		labelY: (startY + endY) / 2,
		endX,
		endY,
	};
};

export const buildStructureRelationGeometry = (
	relation: GeneratedUiStructureRelation,
	positions: Map<string, Point>,
): EdgeGeometry | null => {
	const from = positions.get(relation.from);
	const to = positions.get(relation.to);
	if (!from || !to) {
		return null;
	}
	if (relation.from === relation.to) {
		const loopStartX = from.x + STRUCTURE_NODE_WIDTH - 12;
		const loopStartY = from.y + STRUCTURE_NODE_HEIGHT / 2;
		return {
			path: `M ${loopStartX} ${loopStartY} C ${loopStartX + 28} ${loopStartY - 24}, ${loopStartX + 28} ${loopStartY + 24}, ${loopStartX} ${loopStartY + 12}`,
			labelX: loopStartX + 24,
			labelY: loopStartY - 20,
			endX: loopStartX,
			endY: loopStartY + 12,
		};
	}
	const sameColumn = Math.abs(from.x - to.x) < 2;
	const startX = sameColumn
		? from.x + STRUCTURE_NODE_WIDTH / 2
		: from.x + STRUCTURE_NODE_WIDTH;
	const startY = sameColumn
		? from.y + STRUCTURE_NODE_HEIGHT
		: from.y + STRUCTURE_NODE_HEIGHT / 2;
	const endX = sameColumn ? to.x + STRUCTURE_NODE_WIDTH / 2 : to.x;
	const endY = sameColumn ? to.y : to.y + STRUCTURE_NODE_HEIGHT / 2;
	return {
		path: sameColumn
			? `M ${startX} ${startY} C ${startX} ${startY + 20}, ${endX} ${endY - 20}, ${endX} ${endY}`
			: `M ${startX} ${startY} C ${startX + 28} ${startY}, ${endX - 28} ${endY}, ${endX} ${endY}`,
		labelX: sameColumn ? startX + 10 : (startX + endX) / 2,
		labelY: sameColumn ? (startY + endY) / 2 : startY - 8,
		endX,
		endY,
	};
};
