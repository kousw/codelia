import { describe, expect, test } from "bun:test";
import { switchComposerModeValue } from "../src/mainview/components/shell/Composer";

describe("desktop composer behavior", () => {
	test("switches command mode prefixes while preserving explicit mode suffixes", () => {
		expect(switchComposerModeValue("/help", "!")).toBe("!help");
		expect(switchComposerModeValue("$skill arg", "/")).toBe("/skill arg");
		expect(switchComposerModeValue("!ls", "$")).toBe("$ls");
	});

	test("starts a mode prefix without appending normal text", () => {
		expect(switchComposerModeValue("", "!")).toBe("!");
		expect(switchComposerModeValue("normal prompt", "/")).toBe("/");
	});
});
