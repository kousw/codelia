import { expect, test } from "bun:test";
import path from "node:path";
import { isWithin } from "../src/utils/paths";

const root = path.resolve("fixture-workspace");

test.each([
	[".", true],
	["child", true],
	["..cache", true],
	["..", false],
	[path.join("..", "fixture-workspace-sibling"), false],
] as const)("checks workspace containment for %s", (target, expected) => {
	expect(isWithin(root, path.resolve(root, target))).toBe(expected);
});

test.skipIf(process.platform !== "win32")(
	"rejects a path on a different drive",
	() => {
		expect(isWithin("C:\\workspace", "D:\\workspace")).toBe(false);
	},
);
