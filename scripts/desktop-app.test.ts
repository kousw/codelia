import { describe, expect, test } from "bun:test";
import { isMachO, options } from "./desktop-app.mjs";

describe("native desktop packaging", () => {
	test("rejects a shell main executable and accepts native Mach-O", () => {
		expect(isMachO(Buffer.from("#!/bin/sh"))).toBe(false);
		expect(isMachO(Buffer.from("cffaedfe", "hex"))).toBe(true);
	});
	test("validation cannot use the product identity or a paid provider", () => {
		const args = [
			"--name",
			"Codelia Native Entry QA",
			"--bundle-id",
			"dev.codelia.desktop.native-entry-qa",
			"--validation-fixture",
			"/tmp/codelia-fixture",
			"--provider-url",
			"http://127.0.0.1:64405/v1",
		];
		expect(options(args).bundleId).toBe("dev.codelia.desktop.native-entry-qa");
		expect(() => options(args.slice(4))).toThrow("own app name");
		expect(() =>
			options([...args.slice(0, -1), "https://api.openai.com/v1"]),
		).toThrow("loopback");
		expect(() =>
			options([...args.slice(0, -3), "/tmp/../Users/other", ...args.slice(-2)]),
		).toThrow("temporary directory");
	});
});
