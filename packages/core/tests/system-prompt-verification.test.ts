import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("system prompt requires exhausting feasible verification before UNVERIFIED", () => {
	const promptPath = join(import.meta.dir, "..", "prompts", "system.md");
	const prompt = readFileSync(promptPath, "utf8");

	expect(prompt).toContain(
		"Do not stop at the first unavailable check. If the task's success criterion can still be probed through other reasonable local checks, keep going and run them.",
	);
	expect(prompt).toContain(
		"Do not fake, bypass, or game verification; satisfy the real task requirements without verifier-specific hacks.",
	);
	expect(prompt).toContain(
		"If further verification depends on user-only confirmation, access the user has but you do not, or an inherently human judgment, say what remains unverified and ask how they want to proceed.",
	);
});
