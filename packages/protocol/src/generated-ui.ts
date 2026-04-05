const GENERATED_UI_TONES = [
	"default",
	"muted",
	"accent",
	"success",
	"warning",
	"danger",
] as const;

export type GeneratedUiTone = (typeof GENERATED_UI_TONES)[number];

export type GeneratedUiBadge = {
	label: string;
	tone: GeneratedUiTone;
};

export type GeneratedUiKeyValueItem = {
	label: string;
	value: string;
	tone: GeneratedUiTone;
};

export type GeneratedUiChartItem = {
	label: string;
	value: number;
	tone: GeneratedUiTone;
};

export type GeneratedUiFlowNode = {
	id: string;
	label: string;
	tone: GeneratedUiTone;
};

export type GeneratedUiFlowEdge = {
	from: string;
	to: string;
	label: string;
};

export type GeneratedUiStructureMember = {
	label: string;
	detail: string;
	tone: GeneratedUiTone;
};

export type GeneratedUiStructureEntity = {
	id: string;
	title: string;
	kind: string;
	subtitle: string;
	members: GeneratedUiStructureMember[];
};

export type GeneratedUiStructureRelation = {
	from: string;
	to: string;
	kind:
		| "extends"
		| "implements"
		| "uses"
		| "contains"
		| "calls"
		| "returns"
		| "emits";
	label: string;
};

export type GeneratedUiNode =
	| {
			type: "heading";
			text: string;
			level: 1 | 2 | 3;
			tone: GeneratedUiTone;
	  }
	| {
			type: "text";
			text: string;
			tone: GeneratedUiTone;
	  }
	| {
			type: "badge_row";
			items: GeneratedUiBadge[];
	  }
	| {
			type: "key_value";
			items: GeneratedUiKeyValueItem[];
	  }
	| {
			type: "list";
			items: string[];
			ordered: boolean;
	  }
	| {
			type: "table";
			columns: string[];
			rows: string[][];
	  }
	| {
			type: "bar_chart";
			title: string;
			max: number | null;
			items: GeneratedUiChartItem[];
	  }
	| {
			type: "flow_diagram";
			title: string;
			direction: "horizontal" | "vertical";
			nodes: GeneratedUiFlowNode[];
			edges: GeneratedUiFlowEdge[];
	  }
	| {
			type: "structure_map";
			title: string;
			entities: GeneratedUiStructureEntity[];
			relations: GeneratedUiStructureRelation[];
	  }
	| {
			type: "code";
			title: string;
			language: string;
			code: string;
	  }
	| {
			type: "group";
			title: string;
			children: GeneratedUiNode[];
	  };

export type GeneratedUiDocument = {
	kind: "generated_ui";
	version: 1;
	surface: "inline_panel";
	title: string;
	summary: string;
	nodes: GeneratedUiNode[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isTone = (value: unknown): value is GeneratedUiTone =>
	typeof value === "string" &&
	(GENERATED_UI_TONES as readonly string[]).includes(value);

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isBadge = (value: unknown): value is GeneratedUiBadge =>
	isRecord(value) && typeof value.label === "string" && isTone(value.tone);

const isKeyValueItem = (value: unknown): value is GeneratedUiKeyValueItem =>
	isRecord(value) &&
	typeof value.label === "string" &&
	typeof value.value === "string" &&
	isTone(value.tone);

const isChartItem = (value: unknown): value is GeneratedUiChartItem =>
	isRecord(value) &&
	typeof value.label === "string" &&
	typeof value.value === "number" &&
	isTone(value.tone);

const isFlowNode = (value: unknown): value is GeneratedUiFlowNode =>
	isRecord(value) &&
	typeof value.id === "string" &&
	typeof value.label === "string" &&
	isTone(value.tone);

const isFlowEdge = (value: unknown): value is GeneratedUiFlowEdge =>
	isRecord(value) &&
	typeof value.from === "string" &&
	typeof value.to === "string" &&
	typeof value.label === "string";

const isStructureMember = (
	value: unknown,
): value is GeneratedUiStructureMember =>
	isRecord(value) &&
	typeof value.label === "string" &&
	typeof value.detail === "string" &&
	isTone(value.tone);

const isStructureEntity = (
	value: unknown,
): value is GeneratedUiStructureEntity =>
	isRecord(value) &&
	typeof value.id === "string" &&
	typeof value.title === "string" &&
	typeof value.kind === "string" &&
	typeof value.subtitle === "string" &&
	Array.isArray(value.members) &&
	value.members.every(isStructureMember);

const isStructureRelation = (
	value: unknown,
): value is GeneratedUiStructureRelation =>
	isRecord(value) &&
	typeof value.from === "string" &&
	typeof value.to === "string" &&
	typeof value.label === "string" &&
	[
		"extends",
		"implements",
		"uses",
		"contains",
		"calls",
		"returns",
		"emits",
	].includes(String(value.kind));

export const isGeneratedUiNode = (value: unknown): value is GeneratedUiNode => {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}
	switch (value.type) {
		case "heading":
			return (
				typeof value.text === "string" &&
				(value.level === 1 || value.level === 2 || value.level === 3) &&
				isTone(value.tone)
			);
		case "text":
			return typeof value.text === "string" && isTone(value.tone);
		case "badge_row":
			return Array.isArray(value.items) && value.items.every(isBadge);
		case "key_value":
			return Array.isArray(value.items) && value.items.every(isKeyValueItem);
		case "list":
			return isStringArray(value.items) && typeof value.ordered === "boolean";
		case "table":
			return (
				isStringArray(value.columns) &&
				Array.isArray(value.rows) &&
				value.rows.every(isStringArray)
			);
		case "bar_chart":
			return (
				typeof value.title === "string" &&
				(value.max === null || typeof value.max === "number") &&
				Array.isArray(value.items) &&
				value.items.every(isChartItem)
			);
		case "flow_diagram":
			return (
				typeof value.title === "string" &&
				(value.direction === "horizontal" || value.direction === "vertical") &&
				Array.isArray(value.nodes) &&
				value.nodes.every(isFlowNode) &&
				Array.isArray(value.edges) &&
				value.edges.every(isFlowEdge)
			);
		case "structure_map":
			return (
				typeof value.title === "string" &&
				Array.isArray(value.entities) &&
				value.entities.every(isStructureEntity) &&
				Array.isArray(value.relations) &&
				value.relations.every(isStructureRelation)
			);
		case "code":
			return (
				typeof value.title === "string" &&
				typeof value.language === "string" &&
				typeof value.code === "string"
			);
		case "group":
			return (
				typeof value.title === "string" &&
				Array.isArray(value.children) &&
				value.children.every(isGeneratedUiNode)
			);
		default:
			return false;
	}
};

export const isGeneratedUiDocument = (
	value: unknown,
): value is GeneratedUiDocument =>
	isRecord(value) &&
	value.kind === "generated_ui" &&
	value.version === 1 &&
	value.surface === "inline_panel" &&
	typeof value.title === "string" &&
	typeof value.summary === "string" &&
	Array.isArray(value.nodes) &&
	value.nodes.every(isGeneratedUiNode);
