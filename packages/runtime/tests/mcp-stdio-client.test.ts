import { describe, expect, test } from "bun:test";
import { StdioMcpClient } from "../src/mcp/client";

const createTrackableSignal = (): {
	signal: AbortSignal;
	getActiveListeners: () => number;
	getAddCalls: () => number;
	getRemoveCalls: () => number;
} => {
	const listeners = new Set<EventListenerOrEventListenerObject>();
	let addCalls = 0;
	let removeCalls = 0;
	const signalLike = {
		aborted: false,
		addEventListener: (
			type: string,
			listener: EventListenerOrEventListenerObject,
		) => {
			if (type !== "abort") return;
			addCalls += 1;
			listeners.add(listener);
		},
		removeEventListener: (
			type: string,
			listener: EventListenerOrEventListenerObject,
		) => {
			if (type !== "abort") return;
			removeCalls += 1;
			listeners.delete(listener);
		},
	};
	return {
		signal: signalLike as unknown as AbortSignal,
		getActiveListeners: () => listeners.size,
		getAddCalls: () => addCalls,
		getRemoveCalls: () => removeCalls,
	};
};

describe("StdioMcpClient abort listener cleanup", () => {
	test("removes abort listeners when requests time out", async () => {
		const trackedSignal = createTrackableSignal();
		const client = new StdioMcpClient({
			serverId: "srv",
			command: process.execPath,
			args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
			log: () => {},
		});

		try {
			for (let i = 0; i < 12; i += 1) {
				await expect(
					client.request(
						"tools/list",
						{},
						{
							timeoutMs: 10,
							signal: trackedSignal.signal,
						},
					),
				).rejects.toThrow("MCP request timed out");
			}

			expect(trackedSignal.getActiveListeners()).toBe(0);
			expect(trackedSignal.getRemoveCalls()).toBe(trackedSignal.getAddCalls());
		} finally {
			await client.close();
		}
	});
});
