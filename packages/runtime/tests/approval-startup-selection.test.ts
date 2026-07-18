import { describe, expect, test } from "bun:test";
import { requestApprovalModeStartupSelection } from "../src/permissions/startup-selection";

describe("requestApprovalModeStartupSelection", () => {
	test("returns the selected approval mode", async () => {
		const result = await requestApprovalModeStartupSelection(
			{
				pick: async () => ({ ids: ["trusted"] }),
				log: () => {},
			},
			"/workspace",
		);

		expect(result).toBe("trusted");
	});

	test("returns null and records a skipped selection", async () => {
		const messages: string[] = [];
		const result = await requestApprovalModeStartupSelection(
			{
				pick: async () => null,
				log: (message) => messages.push(message),
			},
			"/workspace",
		);

		expect(result).toBeNull();
		expect(messages).toEqual([
			"approval_mode startup selection skipped project=/workspace",
		]);
	});
});
