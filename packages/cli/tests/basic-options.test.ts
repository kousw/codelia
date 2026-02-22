import { describe, expect, test } from "bun:test";
import {
	resolveTopLevelAction,
	TOP_LEVEL_HELP_TEXT,
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

	test("defaults to tui flow", () => {
		expect(resolveTopLevelAction([])).toBe("tui");
		expect(resolveTopLevelAction(["--resume"])).toBe("tui");
	});
});

describe("TOP_LEVEL_HELP_TEXT", () => {
	test("contains expected usage and options", () => {
		expect(TOP_LEVEL_HELP_TEXT).toContain("usage: codelia [options]");
		expect(TOP_LEVEL_HELP_TEXT).toContain("--help");
		expect(TOP_LEVEL_HELP_TEXT).toContain("--version");
		expect(TOP_LEVEL_HELP_TEXT).toContain("--resume");
		expect(TOP_LEVEL_HELP_TEXT).toContain("--diagnostics");
		expect(TOP_LEVEL_HELP_TEXT).toContain("--approval-mode");
		expect(TOP_LEVEL_HELP_TEXT).toContain("mcp");
	});
});
