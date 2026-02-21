import { describe, expect, test } from "bun:test";
import {
	languageFromDiffHeaders,
	languageFromFilePath,
	languageFromShebang,
	resolvePreviewLanguageHint,
} from "../src/utils/language";

describe("permission preview language hint", () => {
	test("resolves from explicit language first", () => {
		expect(
			resolvePreviewLanguageHint({
				language: "Rust",
				filePath: "demo.ts",
			}),
		).toBe("rust");
	});

	test("resolves from shebang when no explicit language", () => {
		expect(
			resolvePreviewLanguageHint({
				content: "#!/usr/bin/env python3\nprint('hi')\n",
			}),
		).toBe("python");
	});

	test("resolves from diff header path", () => {
		expect(
			languageFromDiffHeaders(
				"--- a/src/main.go\n+++ b/src/main.go\n@@ -1 +1 @@\n-package main\n+package app",
			),
		).toBe("go");
	});

	test("resolves from file path extension as last fallback", () => {
		expect(languageFromFilePath("scripts/build.sh")).toBe("bash");
		expect(languageFromFilePath("config/app.yml")).toBe("yaml");
	});

	test("supports env shebang forms", () => {
		expect(languageFromShebang("#!/usr/bin/env -S node --no-warnings\n")).toBe(
			"javascript",
		);
	});
});
