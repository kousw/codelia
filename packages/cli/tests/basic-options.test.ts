import { describe, expect, test } from "bun:test";
import {
	resolvePromptModeApproval,
	resolvePromptText,
	resolveTopLevelAction,
	TOP_LEVEL_HELP_TEXT,
	validatePromptText,
} from "../src/basic-options";

describe("resolveTopLevelAction", () => {
	test("routes mcp command before top-level flags", () => {
		expect(resolveTopLevelAction(["mcp", "--help"])).toBe("mcp");
	});

	test("resolves top-level help", () => {
		expect(resolveTopLevelAction(["--help"])).toBe("help");
		expect(resolveTopLevelAction(["-h"])).toBe("help");
		expect(resolveTopLevelAction(["help"])).toBe("help");
	});

	test("resolves top-level version", () => {
		expect(resolveTopLevelAction(["--version"])).toBe("version");
		expect(resolveTopLevelAction(["-V"])).toBe("version");
		expect(resolveTopLevelAction(["-v"])).toBe("version");
		expect(resolveTopLevelAction(["version"])).toBe("version");
	});

	test("resolves prompt mode", () => {
		expect(resolveTopLevelAction(["-p", "hello"])).toBe("prompt");
		expect(resolveTopLevelAction(["--prompt", "hello"])).toBe("prompt");
		expect(resolveTopLevelAction(["--prompt=hello"])).toBe("prompt");
	});

	test("does not treat prompt flags after -- as top-level prompt mode", () => {
		expect(resolveTopLevelAction(["--", "--prompt", "hello"])).toBe("tui");
	});

	test("defaults to tui flow", () => {
		expect(resolveTopLevelAction([])).toBe("tui");
		expect(resolveTopLevelAction(["--resume"])).toBe("tui");
	});
});

describe("prompt option parsing", () => {
	test("resolves prompt text from short/long forms", () => {
		expect(resolvePromptText(["-p", "hello"])).toBe("hello");
		expect(resolvePromptText(["--prompt", "hi"])).toBe("hi");
		expect(resolvePromptText(["--prompt=yo"])).toBe("yo");
	});

	test("keeps approval-mode optional in prompt mode", () => {
		expect(resolvePromptModeApproval(["-p", "hello"])).toBeUndefined();
		expect(resolvePromptModeApproval(["-p", "hello", "--approval-mode", "trusted"])).toBe("trusted");
	});

	test("rejects malformed approval-mode value forms", () => {
		expect(() => resolvePromptModeApproval(["-p", "hello", "--approval-mode"])).toThrow(
			"--approval-mode requires a value",
		);
		expect(() => resolvePromptModeApproval(["-p", "hello", "--approval-mode="])).toThrow(
			"--approval-mode requires a value",
		);
	});

	test("validates non-empty prompt", () => {
		expect(validatePromptText("hello")).toBe("hello");
		expect(() => validatePromptText("   ")).toThrow(
			"Prompt is required after -p/--prompt",
		);
	});
});

describe("TOP_LEVEL_HELP_TEXT", () => {
	test("contains expected usage and options", () => {
		expect(TOP_LEVEL_HELP_TEXT).toContain("usage: codelia [options]");
		expect(TOP_LEVEL_HELP_TEXT).toContain("--help");
		expect(TOP_LEVEL_HELP_TEXT).toContain("--version");
		expect(TOP_LEVEL_HELP_TEXT).toContain("--prompt");
		expect(TOP_LEVEL_HELP_TEXT).toContain("--resume");
		expect(TOP_LEVEL_HELP_TEXT).toContain("--diagnostics");
		expect(TOP_LEVEL_HELP_TEXT).toContain("--approval-mode");
		expect(TOP_LEVEL_HELP_TEXT).toContain("mcp");
	});
});
