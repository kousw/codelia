import { describe, expect, test } from "bun:test";
import { RPC_ERROR_CODE } from "@codelia/protocol";
import { resolveRpcShellTimeoutSeconds } from "../src/rpc/shell-timeout";
import {
	DEFAULT_TIMEOUT_SECONDS,
	MAX_EXECUTION_TIMEOUT_SECONDS,
	MAX_TIMEOUT_SECONDS,
} from "../src/tools/bash-utils";

describe("RPC shell timeout (shell.start, task.spawn)", () => {
	test("foreground launches default and clamp to the foreground limit", () => {
		expect(resolveRpcShellTimeoutSeconds(undefined, false)).toBe(
			DEFAULT_TIMEOUT_SECONDS,
		);
		expect(resolveRpcShellTimeoutSeconds(0.5, false)).toBe(1);
		expect(resolveRpcShellTimeoutSeconds(12.9, false)).toBe(12);
		expect(resolveRpcShellTimeoutSeconds(MAX_TIMEOUT_SECONDS + 1, false)).toBe(
			MAX_TIMEOUT_SECONDS,
		);
	});

	test("background launches run without a timer unless one is requested", () => {
		expect(resolveRpcShellTimeoutSeconds(undefined, true)).toBeUndefined();
		expect(
			resolveRpcShellTimeoutSeconds(MAX_EXECUTION_TIMEOUT_SECONDS, true),
		).toBe(MAX_EXECUTION_TIMEOUT_SECONDS);
	});

	test("rejects non-positive values and background values beyond the Node timer range", () => {
		for (const [value, background] of [
			[0, false],
			[-1, true],
			[Number.NaN, true],
			[Number.POSITIVE_INFINITY, false],
		] as const)
			expect(resolveRpcShellTimeoutSeconds(value, background)).toEqual({
				error: {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "timeout_seconds must be a positive number",
				},
			});
		expect(
			resolveRpcShellTimeoutSeconds(MAX_EXECUTION_TIMEOUT_SECONDS + 1, true),
		).toMatchObject({
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: expect.stringContaining("background timeout_seconds must be"),
			},
		});
	});
});
