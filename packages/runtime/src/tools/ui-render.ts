import type { JSONSchema7 } from "json-schema";
import type { Tool } from "@codelia/core";
import type {
	GeneratedUiDocument,
	GeneratedUiNode,
	GeneratedUiTone,
} from "@codelia/protocol";
import { z } from "zod";

const toneSchema = z.enum([
	"default",
	"muted",
	"accent",
	"success",
	"warning",
	"danger",
]);

type UiRenderNodeInput =
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
			items: Array<{
				label: string;
				value?: string;
				tone?: GeneratedUiTone;
			}>;
	  }
	| {
			type: "key_value";
			items: Array<{
				label: string;
				value: string;
				tone?: GeneratedUiTone;
			}>;
	  }
	| {
			type: "list";
			items: Array<
				| string
				| {
						label: string;
						value?: string;
						tone?: GeneratedUiTone;
				  }
			>;
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
			items: Array<{
				label: string;
				value: number;
				tone?: GeneratedUiTone;
			}>;
	  }
	| {
			type: "flow_diagram";
			title: string;
			direction: "horizontal" | "vertical";
			nodes: Array<{
				id: string;
				label: string;
				tone?: GeneratedUiTone;
			}>;
			edges: Array<{
				from: string;
				to: string;
				label: string;
			}>;
	  }
	| {
			type: "structure_map";
			title: string;
			entities: Array<{
				id: string;
				title: string;
				kind: string;
				subtitle: string;
				members: Array<{
					label: string;
					detail: string;
					tone?: GeneratedUiTone;
				}>;
			}>;
			relations: Array<{
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
			}>;
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
			children: UiRenderNodeInput[];
	  };

const headingNodeSchema = z.object({
	type: z.literal("heading"),
	text: z.string().min(1),
	level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
	tone: toneSchema,
});

const textNodeSchema = z.object({
	type: z.literal("text"),
	text: z.string().min(1),
	tone: toneSchema,
});

const badgeRowNodeSchema = z.object({
	type: z.literal("badge_row"),
	items: z
		.array(
			z.object({
				label: z.string().min(1),
				value: z.string().optional(),
				tone: toneSchema.optional(),
			}),
		)
		.min(1)
		.max(8),
});

const keyValueNodeSchema = z.object({
	type: z.literal("key_value"),
	items: z
		.array(
			z.object({
				label: z.string().min(1),
				value: z.string(),
				tone: toneSchema.optional(),
			}),
		)
		.min(1)
		.max(16),
});

const listNodeSchema = z.object({
	type: z.literal("list"),
	items: z
		.array(
			z.union([
				z.string().min(1),
				z.object({
					label: z.string().min(1),
					value: z.string().optional(),
					tone: toneSchema.optional(),
				}),
			]),
		)
		.min(1)
		.max(24),
	ordered: z.boolean(),
});

const tableNodeSchema = z.object({
	type: z.literal("table"),
	columns: z.array(z.string().min(1)).min(1).max(8),
	rows: z.array(z.array(z.string()).min(1).max(8)).min(1).max(20),
});

const barChartNodeSchema = z.object({
	type: z.literal("bar_chart"),
	title: z.string(),
	max: z.number().positive().nullable(),
	items: z
		.array(
			z.object({
				label: z.string().min(1),
				value: z.number().nonnegative(),
				tone: toneSchema.optional(),
			}),
		)
		.min(1)
		.max(12),
});

const flowDiagramNodeSchema = z.object({
	type: z.literal("flow_diagram"),
	title: z.string(),
	direction: z.union([z.literal("horizontal"), z.literal("vertical")]),
	nodes: z
		.array(
			z.object({
				id: z.string().min(1),
				label: z.string().min(1),
				tone: toneSchema.optional(),
			}),
		)
		.min(1)
		.max(8),
	edges: z
		.array(
			z.object({
				from: z.string().min(1),
				to: z.string().min(1),
				label: z.string(),
			}),
		)
		.max(12),
});

const structureMapNodeSchema = z.object({
	type: z.literal("structure_map"),
	title: z.string(),
	entities: z
		.array(
			z.object({
				id: z.string().min(1),
				title: z.string().min(1),
				kind: z.string().min(1),
				subtitle: z.string(),
				members: z
					.array(
						z.object({
							label: z.string().min(1),
							detail: z.string(),
							tone: toneSchema.optional(),
						}),
					)
					.max(12),
			}),
		)
		.min(1)
		.max(8),
	relations: z
		.array(
			z.object({
				from: z.string().min(1),
				to: z.string().min(1),
				kind: z.enum([
					"extends",
					"implements",
					"uses",
					"contains",
					"calls",
					"returns",
					"emits",
				]),
				label: z.string(),
			}),
		)
		.max(16),
});

const codeNodeSchema = z.object({
	type: z.literal("code"),
	title: z.string(),
	language: z.string(),
	code: z.string().min(1),
});

const nodeSchema: z.ZodType<UiRenderNodeInput> = z.lazy(() =>
	z.discriminatedUnion("type", [
		headingNodeSchema,
		textNodeSchema,
		badgeRowNodeSchema,
		keyValueNodeSchema,
		listNodeSchema,
		tableNodeSchema,
		barChartNodeSchema,
		flowDiagramNodeSchema,
		structureMapNodeSchema,
		codeNodeSchema,
		z.object({
			type: z.literal("group"),
			title: z.string(),
			children: z.array(nodeSchema).min(1).max(24),
		}),
	]),
);

const inputSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	nodes: z.array(nodeSchema).min(1).max(32),
});

const nodeParametersSchema: JSONSchema7 = {
	type: "object",
	description:
		"One generated UI node. Set type first, then provide only the fields that match that type.",
	properties: {
		type: {
			type: "string",
			enum: [
				"heading",
				"text",
				"badge_row",
				"key_value",
				"list",
				"table",
				"bar_chart",
				"flow_diagram",
				"structure_map",
				"code",
				"group",
			],
			description: "Node kind.",
		},
		text: {
			type: ["string", "null"],
			description: "Used by heading/text nodes.",
		},
		level: {
			type: ["number", "null"],
			enum: [1, 2, 3, null],
			description: "Heading level for heading nodes only.",
		},
		tone: {
			type: ["string", "null"],
			enum: [
				"default",
				"muted",
				"accent",
				"success",
				"warning",
				"danger",
				null,
			],
			description:
				"Visual tone for heading/text nodes and badge or value items.",
		},
		items: {
			type: ["array", "null"],
			description:
				"Entries for list, badge_row, or key_value nodes. For badge_row or list, use value as an empty string when it has no separate secondary value.",
			items: {
				type: "object",
				properties: {
					label: {
						type: "string",
						description: "Primary item label or list text.",
					},
					value: {
						type: ["string", "number"],
						description:
							"Secondary value. Use empty string when a second value is not needed; use number values for bar_chart items.",
					},
					tone: {
						type: "string",
						enum: [
							"default",
							"muted",
							"accent",
							"success",
							"warning",
							"danger",
						],
						description: "Badge/value tone.",
					},
				},
				required: ["label", "value", "tone"],
				additionalProperties: false,
			},
		},
		ordered: {
			type: ["boolean", "null"],
			description: "Used by list nodes only. True means numbered list.",
		},
		columns: {
			type: ["array", "null"],
			items: { type: "string" },
			description: "Table column headers for table nodes only.",
		},
		rows: {
			type: ["array", "null"],
			items: {
				type: "array",
				items: { type: "string" },
			},
			description: "Table rows for table nodes only.",
		},
		max: {
			type: ["number", "null"],
			description:
				"Optional explicit chart maximum for bar_chart nodes. Use null to auto-scale.",
		},
		direction: {
			type: ["string", "null"],
			enum: ["horizontal", "vertical", null],
			description: "Flow direction for flow_diagram nodes only.",
		},
		nodes: {
			type: ["array", "null"],
			description: "Flow nodes for flow_diagram nodes only.",
			items: {
				type: "object",
				properties: {
					id: { type: "string", description: "Stable node id." },
					label: { type: "string", description: "Node label." },
					tone: {
						type: "string",
						enum: [
							"default",
							"muted",
							"accent",
							"success",
							"warning",
							"danger",
						],
						description: "Node tone.",
					},
				},
				required: ["id", "label", "tone"],
				additionalProperties: false,
			},
		},
		edges: {
			type: ["array", "null"],
			description: "Flow edges for flow_diagram nodes only.",
			items: {
				type: "object",
				properties: {
					from: { type: "string", description: "Source node id." },
					to: { type: "string", description: "Target node id." },
					label: {
						type: "string",
						description: "Optional edge label. Use empty string when none.",
					},
				},
				required: ["from", "to", "label"],
				additionalProperties: false,
			},
		},
		entities: {
			type: ["array", "null"],
			description:
				"Structure entities for structure_map nodes only, such as classes, modules, or services.",
			items: {
				type: "object",
				properties: {
					id: { type: "string", description: "Stable entity id." },
					title: { type: "string", description: "Entity title." },
					kind: {
						type: "string",
						description:
							"Entity kind such as class, interface, module, or service.",
					},
					subtitle: {
						type: "string",
						description: "Optional secondary label or package path.",
					},
					members: {
						type: "array",
						items: {
							type: "object",
							properties: {
								label: { type: "string", description: "Member label." },
								detail: {
									type: "string",
									description: "Member detail such as signature or role.",
								},
								tone: {
									type: "string",
									enum: [
										"default",
										"muted",
										"accent",
										"success",
										"warning",
										"danger",
									],
									description: "Member tone.",
								},
							},
							required: ["label", "detail", "tone"],
							additionalProperties: false,
						},
						description: "Members shown inside the entity card.",
					},
				},
				required: ["id", "title", "kind", "subtitle", "members"],
				additionalProperties: false,
			},
		},
		relations: {
			type: ["array", "null"],
			description: "Entity relations for structure_map nodes only.",
			items: {
				type: "object",
				properties: {
					from: { type: "string", description: "Source entity id." },
					to: { type: "string", description: "Target entity id." },
					kind: {
						type: "string",
						enum: [
							"extends",
							"implements",
							"uses",
							"contains",
							"calls",
							"returns",
							"emits",
						],
						description: "Relation kind.",
					},
					label: {
						type: "string",
						description: "Optional relation label. Use empty string when none.",
					},
				},
				required: ["from", "to", "kind", "label"],
				additionalProperties: false,
			},
		},
		title: {
			type: ["string", "null"],
			description: "Section/code title for group or code nodes.",
		},
		language: {
			type: ["string", "null"],
			description: "Code language hint for code nodes only.",
		},
		code: {
			type: ["string", "null"],
			description: "Code block content for code nodes only.",
		},
		children: {
			type: ["array", "null"],
			items: { $ref: "#/definitions/generatedUiNode" },
			description: "Nested nodes for group nodes only.",
		},
	},
	required: [
		"type",
		"text",
		"level",
		"tone",
		"items",
		"ordered",
		"columns",
		"rows",
		"max",
		"direction",
		"nodes",
		"edges",
		"entities",
		"relations",
		"title",
		"language",
		"code",
		"children",
	],
	additionalProperties: false,
};

const toolParametersSchema: JSONSchema7 = {
	$schema: "http://json-schema.org/draft-07/schema#",
	type: "object",
	properties: {
		title: {
			type: "string",
			minLength: 1,
			description: "Panel title shown above the generated UI.",
		},
		summary: {
			type: "string",
			minLength: 1,
			description:
				"One concise line describing why this panel exists or what it summarizes.",
		},
		nodes: {
			type: "array",
			minItems: 1,
			maxItems: 32,
			items: { $ref: "#/definitions/generatedUiNode" },
			description:
				"Structured nodes. Prefer heading/text/list/key_value/table/code/group over long prose.",
		},
	},
	required: ["title", "summary", "nodes"],
	additionalProperties: false,
	definitions: {
		generatedUiNode: nodeParametersSchema,
	},
};

const toToolResult = (value: GeneratedUiDocument) => ({
	type: "json" as const,
	value,
});

const toOutputNode = (node: UiRenderNodeInput): GeneratedUiNode => {
	switch (node.type) {
		case "heading":
		case "text":
		case "table":
		case "code":
			return node;
		case "badge_row":
			return {
				type: "badge_row",
				items: node.items.map((item) => ({
					label: item.label,
					tone: item.tone ?? "default",
				})),
			};
		case "key_value":
			return {
				type: "key_value",
				items: node.items.map((item) => ({
					label: item.label,
					value: item.value,
					tone: item.tone ?? "default",
				})),
			};
		case "list":
			return {
				type: "list",
				ordered: node.ordered,
				items: node.items.map((item) =>
					typeof item === "string" ? item : item.label,
				),
			};
		case "bar_chart":
			return {
				type: "bar_chart",
				title: node.title,
				max: node.max,
				items: node.items.map((item) => ({
					label: item.label,
					value: item.value,
					tone: item.tone ?? "default",
				})),
			};
		case "flow_diagram":
			return {
				type: "flow_diagram",
				title: node.title,
				direction: node.direction,
				nodes: node.nodes.map((item) => ({
					id: item.id,
					label: item.label,
					tone: item.tone ?? "default",
				})),
				edges: node.edges,
			};
		case "structure_map":
			return {
				type: "structure_map",
				title: node.title,
				entities: node.entities.map((entity) => ({
					id: entity.id,
					title: entity.title,
					kind: entity.kind,
					subtitle: entity.subtitle,
					members: entity.members.map((member) => ({
						label: member.label,
						detail: member.detail,
						tone: member.tone ?? "default",
					})),
				})),
				relations: node.relations,
			};
		case "group":
			return {
				type: "group",
				title: node.title,
				children: node.children.map(toOutputNode),
			};
	}
};

export const createUiRenderTool = (): Tool => ({
	name: "ui_render",
	description:
		"Render a bounded desktop UI surface when structured presentation or lightweight interaction is clearer than prose. Use it for tables, summaries, charts, diagrams, architecture maps, review panels, and other compact generated UI that supplements normal assistant text. Keep it concise, use only the supported node shapes, and do not use it for decorative layout or arbitrary HTML or JavaScript.",
	definition: {
		name: "ui_render",
		description:
			"Render a bounded desktop UI surface when structured presentation or lightweight interaction is clearer than prose. Use it for tables, summaries, charts, diagrams, architecture maps, review panels, and other compact generated UI that supplements normal assistant text. Keep it concise, use only the supported node shapes, and do not use it for decorative layout or arbitrary HTML or JavaScript.",
		parameters: toolParametersSchema,
		strict: true,
	},
	executeRaw: async (rawArgsJson) => {
		let rawArgs: unknown;
		try {
			rawArgs = JSON.parse(rawArgsJson) as unknown;
		} catch (error) {
			throw new Error(
				`Invalid tool arguments JSON for ui_render: ${String(error)}`,
			);
		}
		const parsed = inputSchema.safeParse(rawArgs);
		if (!parsed.success) {
			throw new Error(
				`Tool input validation failed for ui_render: ${parsed.error.message}`,
			);
		}
		return toToolResult({
			kind: "generated_ui",
			version: 1,
			surface: "inline_panel",
			title: parsed.data.title,
			summary: parsed.data.summary,
			nodes: parsed.data.nodes.map(toOutputNode),
		});
	},
});
