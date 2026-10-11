import { expect, spyOn, test } from "bun:test";
import { requestUiConfirm } from "../src/rpc/ui-requests";
import { RuntimeState } from "../src/runtime-state";

test("opted-in cancellation closes the exact active request before the next queued confirmation", async () => {
	const state = new RuntimeState();
	state.setUiCapabilities({ supports_ui_request_cancel: true });
	const sent: Array<{
		id?: string;
		method: string;
		params: Record<string, unknown>;
	}> = [];
	const output = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		sent.push(JSON.parse(String(chunk)));
		return true;
	});
	try {
		const activeAbort = new AbortController();
		const active = requestUiConfirm(
			state,
			{ title: "Child write", message: "write", task_id: "child" },
			activeAbort.signal,
		);
		const skippedAbort = new AbortController();
		const skipped = requestUiConfirm(
			state,
			{ title: "Skipped child", message: "write" },
			skippedAbort.signal,
		);
		const next = requestUiConfirm(state, {
			title: "Next child",
			message: "write",
		});
		skippedAbort.abort();
		expect(await skipped).toBeNull();
		expect(sent).toHaveLength(1);
		const activeId = sent[0]?.id;
		expect(activeId).toBeDefined();
		expect(sent[0]?.params.task_id).toBe("child");
		activeAbort.abort();
		expect(await active).toBeNull();
		await Bun.sleep(0);
		expect(sent.map((m) => m.method)).toEqual([
			"ui.confirm.request",
			"ui.request.cancel",
			"ui.confirm.request",
		]);
		expect(sent[1]?.params).toEqual({
			request_id: activeId,
			reason: "aborted",
		});
		const nextId = sent[2]?.id;
		if (!nextId || !activeId) throw new Error("Missing fixture request id");
		expect(
			state.resolveUiResponse({
				jsonrpc: "2.0",
				id: activeId,
				result: { ok: true },
			}),
		).toBe(false);
		state.resolveUiResponse({
			jsonrpc: "2.0",
			id: nextId,
			result: { ok: false },
		});
		expect(await next).toEqual({ ok: false });
	} finally {
		output.mockRestore();
	}
});

test("legacy clients receive no new cancellation notification", async () => {
	const state = new RuntimeState();
	const sent: Array<{ method: string }> = [];
	const output = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		sent.push(JSON.parse(String(chunk)));
		return true;
	});
	try {
		const abort = new AbortController();
		const pending = requestUiConfirm(
			state,
			{ title: "Parent", message: "write" },
			abort.signal,
		);
		abort.abort();
		expect(await pending).toBeNull();
		expect(sent.map((m) => m.method)).toEqual(["ui.confirm.request"]);
	} finally {
		output.mockRestore();
	}
});

test("an already cancelled confirmation never occupies a UI slot", async () => {
	const state = new RuntimeState();
	state.setUiCapabilities({ supports_ui_request_cancel: true });
	const output = spyOn(process.stdout, "write").mockImplementation(() => true);
	try {
		const abort = new AbortController();
		abort.abort();
		expect(
			await requestUiConfirm(
				state,
				{ title: "Cancelled", message: "write" },
				abort.signal,
			),
		).toBeNull();
		expect(output).not.toHaveBeenCalled();
	} finally {
		output.mockRestore();
	}
});
