import { expect, test } from "bun:test";
import { summarizeProviderMeta } from "../src/rpc/run-debug";

test("Codex diagnostics show useful known facts without opaque metadata", () => {
	const summary = summarizeProviderMeta({
		transport: "http_stream",
		codex_metadata: {
			server_model: "gpt-6.1-sol",
			model_verifications: ["trusted_access_for_cyber"],
			moderation_metadata_present: true,
			safety_buffering: { active: false },
			routing: "private-routing",
			moderation: "private-moderation",
		},
	});
	expect(summary).toContain("server_model=gpt-6.1-sol");
	expect(summary).toContain("verification=trusted_access_for_cyber");
	expect(summary).toContain("moderation_metadata=present");
	expect(summary).toContain("safety_buffering=observed");
	expect(summary).not.toContain("private-");
});
