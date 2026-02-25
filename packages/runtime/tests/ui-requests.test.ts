import { describe, expect, test } from "bun:test";
import type { RpcRequest } from "@codelia/protocol";
import { requestUiClipboardRead } from "../src/rpc/ui-requests";
import { RuntimeState } from "../src/runtime-state";

const captureStdoutRequests = () => {
	const originalWrite = process.stdout.write.bind(process.stdout);
	const requests: RpcRequest[] = [];
	let buffer = "";

	process.stdout.write = ((chunk: string | Uint8Array) => {
		const text =
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		buffer += text;
		let idx = buffer.indexOf("\n");
		while (idx >= 0) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (line) {
				try {
					const parsed = JSON.parse(line) as unknown;
					if (
						typeof parsed === "object" &&
						parsed !== null &&
						"method" in parsed &&
						"id" in parsed
					) {
						requests.push(parsed as RpcRequest);
					}
				} catch {
					// ignore non-JSON lines
				}
			}
			idx = buffer.indexOf("\n");
		}
		return true;
	}) as typeof process.stdout.write;

	return {
		requests,
		restore() {
			process.stdout.write = originalWrite;
		},
	};
};

describe("ui clipboard request", () => {
	test("returns null without sending when clipboard capability is missing", async () => {
		const state = new RuntimeState();
		const capture = captureStdoutRequests();
		try {
			const result = await requestUiClipboardRead(state, {
				purpose: "image_attachment",
				formats: ["image/png"],
			});
			expect(result).toBeNull();
			expect(capture.requests).toHaveLength(0);
		} finally {
			capture.restore();
		}
	});

	test("sends ui.clipboard.read and resolves response when capability is enabled", async () => {
		const state = new RuntimeState();
		state.setUiCapabilities({ supports_clipboard_read: true });
		const capture = captureStdoutRequests();
		try {
			const responsePromise = requestUiClipboardRead(state, {
				purpose: "image_attachment",
				formats: ["image/png"],
				max_bytes: 1024,
				prompt: "Attach clipboard image",
			});

			expect(capture.requests).toHaveLength(1);
			const request = capture.requests[0];
			expect(request.method).toBe("ui.clipboard.read");

			state.resolveUiResponse({
				jsonrpc: "2.0",
				id: request.id,
				result: {
					ok: true,
					items: [],
				},
			});

			await expect(responsePromise).resolves.toEqual({ ok: true, items: [] });
		} finally {
			capture.restore();
		}
	});
});
