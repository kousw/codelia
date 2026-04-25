import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage } from "../src/shared/types";
import { AssistantTurn } from "../src/mainview/components/transcript/AssistantTurn";
import { buildAssistantRenderRows } from "../src/mainview/controller/transcript";

describe("desktop transcript rendering projection", () => {
	test("projects tool and reasoning events into typed React rows", () => {
		const events = [
			{ type: "reasoning", content: "Inspecting the render path" },
			{
				type: "tool_call",
				tool_call_id: "tool-1",
				tool: "shell",
				display_name: "shell",
				args: { command: "bun test" },
			},
			{
				type: "tool_result",
				tool_call_id: "tool-1",
				tool: "shell",
				result: "ok",
				is_error: false,
			},
		] as ChatMessage["events"];

		const rows = buildAssistantRenderRows(events);

		expect(rows.map((row) => row.kind)).toEqual(["reasoning", "tool"]);
		expect(rows.some((row) => row.kind === "html")).toBe(false);

		const markup = renderToStaticMarkup(
			<AssistantTurn
				rows={rows}
				onOpenLink={async () => {}}
				onCopySection={() => {}}
			/>,
		);
		expect(markup).toContain("timeline-item");
		expect(markup).toContain("Reasoning");
		expect(markup).toContain("Shell");
	});

	test("groups adjacent read tools without flattening individual details", () => {
		const events = [
			{
				type: "tool_call",
				tool_call_id: "read-1",
				tool: "read",
				display_name: "read",
				args: { file_path: "/tmp/a.ts" },
			},
			{
				type: "tool_result",
				tool_call_id: "read-1",
				tool: "read",
				result: "alpha",
				is_error: false,
			},
			{
				type: "tool_call",
				tool_call_id: "read-2",
				tool: "read",
				display_name: "read",
				args: { file_path: "/tmp/b.ts" },
			},
			{
				type: "tool_result",
				tool_call_id: "read-2",
				tool: "read",
				result: "beta",
				is_error: false,
			},
		] as ChatMessage["events"];

		const rows = buildAssistantRenderRows(events);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("read_group");
		if (rows[0]?.kind === "read_group") {
			expect(rows[0].rows.map((row) => row.resultText)).toEqual([
				"alpha",
				"beta",
			]);
		}
	});

	test("renders tool details as escaped React text", () => {
		const events = [
			{
				type: "tool_call",
				tool_call_id: "tool-html",
				tool: "shell",
				display_name: "shell",
				args: { command: "printf html" },
			},
			{
				type: "tool_result",
				tool_call_id: "tool-html",
				tool: "shell",
				result: '<img src=x onerror="alert(1)">',
				is_error: false,
			},
		] as ChatMessage["events"];

		const markup = renderToStaticMarkup(
			<AssistantTurn
				rows={buildAssistantRenderRows(events)}
				onOpenLink={async () => {}}
				onCopySection={() => {}}
			/>,
		);

		expect(markup).not.toContain("<img src=");
		expect(markup).toContain("&lt;img src=x");
		expect(markup).toContain("onerror=&quot;alert(1)&quot;");
	});
});
