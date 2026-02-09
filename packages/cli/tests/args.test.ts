import { describe, expect, test } from "bun:test";
import {
	getAllFlagValues,
	getLastFlagValue,
	hasBooleanFlag,
	parseCliArgs,
	parseKeyValue,
} from "../src/args";

describe("cli args parser", () => {
	test("parses positional, flags, and boolean flags", () => {
		const parsed = parseCliArgs([
			"add",
			"server-id",
			"--transport",
			"http",
			"--header",
			"a=1",
			"--header=b=2",
			"--replace",
		]);
		expect(parsed.positionals).toEqual(["add", "server-id"]);
		expect(getLastFlagValue(parsed, "transport")).toBe("http");
		expect(getAllFlagValues(parsed, "header")).toEqual(["a=1", "b=2"]);
		expect(hasBooleanFlag(parsed, "replace")).toBe(true);
	});

	test("parses key=value with first equals as separator", () => {
		expect(parseKeyValue("Authorization=Bearer abc=xyz", "--header")).toEqual([
			"Authorization",
			"Bearer abc=xyz",
		]);
		expect(() => parseKeyValue("invalid", "--header")).toThrow(
			/--header must be key=value/,
		);
	});
});
