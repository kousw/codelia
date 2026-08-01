import { describe, expect, test } from "bun:test";
import { ProviderFailureError } from "@codelia/core";
import { normalizeRunFailure } from "../src/provider-errors";

describe("normalizeRunFailure", () => {
	test("persists structured provider fields without raw message or stack", () => {
		const raw = new Error(
			"organization=org-secret project=project-secret api_key=key-secret",
		);
		const error = new ProviderFailureError(
			{
				provider: "moonshot",
				kind: "hard_quota",
				retryable: false,
				safeMessage:
					"Moonshot quota is exhausted for the interactive retry window. Wait for reset, review billing, or switch provider.",
				status: 429,
			},
			{ attempts: 1, maxAttempts: 3, cause: raw },
		);

		const normalized = normalizeRunFailure(error);

		expect(normalized.statusMessage).toContain("Moonshot quota");
		expect(normalized.error).toEqual({
			name: "ProviderFailureError",
			message:
				"Moonshot quota is exhausted for the interactive retry window. Wait for reset, review billing, or switch provider.",
			provider: "moonshot",
			kind: "hard_quota",
			status: 429,
			attempts: 1,
			max_attempts: 3,
		});
		const serialized = JSON.stringify(normalized);
		expect(serialized).not.toContain("org-secret");
		expect(serialized).not.toContain("project-secret");
		expect(serialized).not.toContain("key-secret");
		expect(serialized).not.toContain("stack");
	});

	test("keeps non-provider errors backward compatible", () => {
		const error = new Error("local failure");
		const normalized = normalizeRunFailure(error);

		expect(normalized.error.name).toBe("Error");
		expect(normalized.error.message).toBe("local failure");
		expect(normalized.error.stack).toContain("local failure");
	});
});
