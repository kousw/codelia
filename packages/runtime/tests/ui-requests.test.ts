import { expect, spyOn, test } from "bun:test";
import type { RpcRequest } from "@codelia/protocol";
import { requestUiConfirm, requestUiPick } from "../src/rpc/ui-requests";
import { RuntimeState } from "../src/runtime-state";

const setup = {
	title: "Let's set up your provider to get started.",
	items: [{ id: "openai", label: "OpenAI" }],
};
const approval = {
	title: "Approve shell?",
	message: "Start MCP service",
	approval: true,
	items: [{ id: "allow", label: "Allow once" }],
};

test("an MCP approval waits for startup setup and holds the next confirmation in order", async () => {
	const state = new RuntimeState();
	const requests: RpcRequest[] = [];
	const output = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		requests.push(JSON.parse(String(chunk)));
		return true;
	});
	const respond = (id: string, result: unknown) =>
		state.resolveUiResponse({ jsonrpc: "2.0", id, result });

	try {
		const setupResult = requestUiPick(state, setup);
		const approvalResult = requestUiPick(state, approval);
		const confirmResult = requestUiConfirm(state, {
			title: "Confirm",
			message: "Continue?",
		});
		expect(requests).toEqual([
			{ jsonrpc: "2.0", id: "ui_1", method: "ui.pick.request", params: setup },
		]);

		expect(respond("ui_1", { ids: ["openai"] })).toBe(true);
		expect(await setupResult).toEqual({ ids: ["openai"] });
		expect(requests.map(({ method }) => method)).toEqual([
			"ui.pick.request",
			"ui.pick.request",
		]);
		expect(respond("ui_2", { ids: ["allow"] })).toBe(true);
		expect(await approvalResult).toEqual({ ids: ["allow"] });
		expect(requests.at(-1)?.method).toBe("ui.confirm.request");
		expect(respond("ui_3", { ok: false })).toBe(true);
		expect(await confirmResult).toEqual({ ok: false });
	} finally {
		output.mockRestore();
	}
});

test("cancelling a queued approval keeps setup active and cancelling setup dismisses it before the next approval", async () => {
	const state = new RuntimeState();
	const requests: Array<{ id?: string; method: string; params: unknown }> = [];
	const output = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		requests.push(JSON.parse(String(chunk)));
		return true;
	});

	try {
		const setupAbort = new AbortController();
		const queuedAbort = new AbortController();
		const setupResult = requestUiPick(state, setup, setupAbort.signal);
		const queued = requestUiPick(state, approval, queuedAbort.signal);
		const next = requestUiPick(state, approval);
		expect(requests.map(({ id }) => id)).toEqual(["ui_1"]);

		queuedAbort.abort();
		expect(await queued).toBeNull();
		expect(requests.map(({ id }) => id)).toEqual(["ui_1"]);

		setupAbort.abort();
		expect(await setupResult).toBeNull();
		expect(requests[1]).toMatchObject({
			method: "ui.pick.cancelled",
			params: { id: "ui_1" },
		});
		expect(
			state.resolveUiResponse({
				jsonrpc: "2.0",
				id: "ui_1",
				result: { ids: ["openai"] },
			}),
		).toBe(false);
		await Bun.sleep(0);
		expect(requests.map(({ id }) => id)).toEqual(["ui_1", undefined, "ui_2"]);
		expect(
			state.resolveUiResponse({
				jsonrpc: "2.0",
				id: "ui_2",
				result: { ids: ["allow"] },
			}),
		).toBe(true);
		expect(await next).toEqual({ ids: ["allow"] });
	} finally {
		output.mockRestore();
	}
});
