import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GeneratedUiDocument } from "@codelia/protocol";
import { GeneratedUiPanel } from "../src/mainview/components/GeneratedUiPanel";
import { buildStructureLayout } from "../src/mainview/layout/generated-ui-graph-layout";

describe("GeneratedUiPanel", () => {
	test("renders declared flow edges instead of inventing adjacent connectors", () => {
		const payload: GeneratedUiDocument = {
			kind: "generated_ui",
			version: 1,
			surface: "inline_panel",
			title: "Flow",
			summary: "Flow summary",
			nodes: [
				{
					type: "flow_diagram",
					title: "Dependency flow",
					direction: "horizontal",
					nodes: [
						{ id: "a", label: "A", tone: "default" },
						{ id: "b", label: "B", tone: "default" },
						{ id: "c", label: "C", tone: "default" },
					],
					edges: [
						{ from: "a", to: "b", label: "first" },
						{ from: "a", to: "c", label: "skip" },
					],
				},
			],
		};

		const markup = renderToStaticMarkup(<GeneratedUiPanel payload={payload} />);
		expect(markup.match(/generated-ui-flow-link"/g)?.length).toBe(2);
		expect(markup).toContain(">first</text>");
		expect(markup).toContain(">skip</text>");
	});

	test("keeps cyclic structure maps in bounded columns", () => {
		const layout = buildStructureLayout(
			[
				{
					id: "a",
					kind: "package",
					title: "A",
					subtitle: "",
					members: [],
				},
				{
					id: "b",
					kind: "service",
					title: "B",
					subtitle: "",
					members: [],
				},
			],
			[
				{ from: "a", to: "b", kind: "uses", label: "" },
				{ from: "b", to: "a", kind: "uses", label: "" },
				{ from: "a", to: "a", kind: "uses", label: "self" },
			],
		);

		const uniqueColumns = new Set(
			[...layout.positions.values()].map((position) => position.x),
		);
		expect(uniqueColumns.size).toBe(1);
		expect(layout.width).toBeGreaterThan(0);
		expect(layout.width).toBeLessThan(400);
	});
});
