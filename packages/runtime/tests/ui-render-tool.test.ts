import { describe, expect, test } from "bun:test";
import { createUiRenderTool } from "../src/tools/ui-render";

const expectJsonResult = (result: unknown): Record<string, unknown> => {
	if (
		typeof result !== "object" ||
		result === null ||
		!("type" in result) ||
		(result as { type: string }).type !== "json"
	) {
		throw new Error("unexpected tool result");
	}
	const value = (result as { value?: unknown }).value;
	if (typeof value !== "object" || value === null) {
		throw new Error("unexpected tool result");
	}
	return value as Record<string, unknown>;
};

describe("ui_render tool", () => {
	test("schema explains desktop-only structured UI usage", () => {
		const tool = createUiRenderTool();
		const definition = tool.definition as { description: string };
		expect(definition.description).toContain("desktop UI surface");
		expect(definition.description).toContain("supplement");
		expect(definition.description).toContain("charts");
		expect(definition.description).toContain("diagrams");
		expect(definition.description).toContain("architecture maps");
		expect(definition.description).toContain("arbitrary HTML");
		expect(definition.description).toContain("JavaScript");
	});

	test("schema avoids oneOf for provider compatibility", () => {
		const tool = createUiRenderTool();
		expect(JSON.stringify(tool.definition)).not.toContain('"oneOf"');
	});

	test("returns a typed generated-ui document", async () => {
		const tool = createUiRenderTool();
		const result = await tool.executeRaw(
			JSON.stringify({
				title: "Repository Snapshot",
				summary: "Key package counts and current focus.",
				nodes: [
					{
						type: "badge_row",
						items: [
							{ label: "desktop", tone: "accent" },
							{ label: "runtime", tone: "muted" },
						],
					},
					{
						type: "key_value",
						items: [
							{ label: "packages", value: "12", tone: "default" },
							{ label: "focus", value: "desktop ui_render", tone: "accent" },
						],
					},
					{
						type: "table",
						columns: ["Area", "Status"],
						rows: [
							["desktop", "active"],
							["runtime", "wired"],
						],
					},
				],
			}),
			{
				deps: {},
				resolve: async () => {
					throw new Error("not used");
				},
			},
		);
		const value = expectJsonResult(result);
		expect(value.kind).toBe("generated_ui");
		expect(value.version).toBe(1);
		expect(value.surface).toBe("inline_panel");
		expect(value.title).toBe("Repository Snapshot");
		expect(value.summary).toBe("Key package counts and current focus.");
		expect(Array.isArray(value.nodes)).toBe(true);
	});

	test("accepts chart, flow, and structure-map nodes", async () => {
		const tool = createUiRenderTool();
		const result = await tool.executeRaw(
			JSON.stringify({
				title: "Execution Status",
				summary: "Chart and flow overview.",
				nodes: [
					{
						type: "bar_chart",
						title: "Tool volume",
						text: null,
						level: null,
						tone: null,
						items: [
							{ label: "read", value: 8, tone: "muted" },
							{ label: "shell", value: 3, tone: "accent" },
						],
						ordered: null,
						columns: null,
						rows: null,
						max: null,
						direction: null,
						nodes: null,
						edges: null,
						language: null,
						code: null,
						children: null,
					},
					{
						type: "flow_diagram",
						title: "Flow",
						text: null,
						level: null,
						tone: null,
						items: null,
						ordered: null,
						columns: null,
						rows: null,
						max: null,
						direction: "horizontal",
						nodes: [
							{ id: "a", label: "Inspect", tone: "muted" },
							{ id: "b", label: "Plan", tone: "accent" },
						],
						edges: [{ from: "a", to: "b", label: "next" }],
						language: null,
						code: null,
						children: null,
						entities: null,
						relations: null,
					},
					{
						type: "structure_map",
						title: "Types",
						text: null,
						level: null,
						tone: null,
						items: null,
						ordered: null,
						columns: null,
						rows: null,
						max: null,
						direction: null,
						nodes: null,
						edges: null,
						entities: [
							{
								id: "agent",
								title: "Agent",
								kind: "class",
								subtitle: "@codelia/core",
								members: [
									{ label: "runStream()", detail: "main loop", tone: "accent" },
								],
							},
						],
						relations: [
							{
								from: "agent",
								to: "agent",
								kind: "returns",
								label: "",
							},
						],
						language: null,
						code: null,
						children: null,
					},
				],
			}),
			{
				deps: {},
				resolve: async () => {
					throw new Error("not used");
				},
			},
		);
		const value = expectJsonResult(result);
		const nodes = value.nodes as Array<Record<string, unknown>>;
		expect(nodes[0]?.type).toBe("bar_chart");
		expect(nodes[1]?.type).toBe("flow_diagram");
		expect(nodes[2]?.type).toBe("structure_map");
	});
});
