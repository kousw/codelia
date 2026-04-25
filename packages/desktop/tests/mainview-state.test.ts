import { beforeEach, describe, expect, test } from "bun:test";
import type { StreamEvent } from "../src/shared/types";
import {
	commitState,
	getDesktopViewState,
} from "../src/mainview/state/desktop-store";
import {
	attachStartedRun,
	beginPromptRun,
} from "../src/mainview/state/actions/composer";
import {
	applyAgentRunEvent,
	applyRunStatusEvent,
} from "../src/mainview/state/actions/runtime";
import { hydrateSnapshotWithLiveRuns } from "../src/mainview/state/actions/shared";
import { createInitialViewState } from "../src/mainview/state/view-state";

const textEvent = (
	runId: string,
	sessionId: string,
	content: string,
): Extract<StreamEvent, { kind: "agent.event" }> => ({
	kind: "agent.event",
	run_id: runId,
	session_id: sessionId,
	workspace_path: "/tmp/workspace",
	seq: 1,
	event: {
		type: "text",
		content,
	},
});

describe("desktop mainview state", () => {
	beforeEach(() => {
		commitState((draft) => {
			Object.assign(draft, createInitialViewState());
		});
	});

	test("creates independent empty snapshots for fresh view states", () => {
		const first = createInitialViewState();
		const second = createInitialViewState();

		expect(first.snapshot).not.toBe(second.snapshot);
		expect(first.snapshot.transcript).not.toBe(second.snapshot.transcript);
		expect(first.snapshot.sessions).not.toBe(second.snapshot.sessions);
		expect(first.snapshot.workspaces).not.toBe(second.snapshot.workspaces);
	});

	test("hydrates only live events for the selected session", () => {
		const state = createInitialViewState();
		state.liveRuns = {
			"run-a": {
				runId: "run-a",
				sessionId: "session-a",
				workspacePath: "/tmp/workspace",
				status: "running",
				events: [textEvent("run-a", "session-a", "visible")],
				activeSteps: [],
				contextLeftPercent: null,
			},
			"run-b": {
				runId: "run-b",
				sessionId: "session-b",
				workspacePath: "/tmp/workspace",
				status: "running",
				events: [textEvent("run-b", "session-b", "hidden")],
				activeSteps: [],
				contextLeftPercent: null,
			},
		};

		hydrateSnapshotWithLiveRuns(state, {
			workspaces: [],
			sessions: [],
			selected_workspace_path: "/tmp/workspace",
			selected_session_id: "session-a",
			transcript: [],
		});

		expect(state.snapshot.transcript).toHaveLength(1);
		expect(state.snapshot.transcript[0]?.content).toBe("visible");
		expect(state.activeRunId).toBe("run-a");
		expect(state.isStreaming).toBe(true);
		expect(state.activeSteps).not.toBe(state.liveRuns["run-a"]?.activeSteps);
	});

	test("commitState preserves unrelated large slice identities", () => {
		const before = getDesktopViewState();
		const transcript = before.snapshot.transcript;
		const inspect = before.inspect;

		commitState((draft) => {
			draft.composer = "identity check";
		});

		const after = getDesktopViewState();
		expect(after.snapshot.transcript).toBe(transcript);
		expect(after.inspect).toBe(inspect);
		expect(after.composer).toBe("identity check");
	});

	test("routes visible live events into the selected transcript", () => {
		commitState((draft) => {
			draft.snapshot = {
				workspaces: [],
				sessions: [],
				selected_workspace_path: "/tmp/workspace",
				selected_session_id: "session-a",
				transcript: [],
			};
		});
		const beforeTranscript = getDesktopViewState().snapshot.transcript;

		applyAgentRunEvent(textEvent("run-a", "session-a", "visible update"));

		const after = getDesktopViewState();
		expect(after.snapshot.transcript).not.toBe(beforeTranscript);
		expect(after.snapshot.transcript).toHaveLength(1);
		expect(after.snapshot.transcript[0]?.content).toBe("visible update");
		expect(after.liveRuns["run-a"]?.events).toHaveLength(1);
		expect(after.activeRunId).toBe("run-a");
		expect(after.isStreaming).toBe(true);
	});

	test("buffers background live events without touching the visible transcript", () => {
		commitState((draft) => {
			draft.snapshot = {
				workspaces: [],
				sessions: [],
				selected_workspace_path: "/tmp/workspace",
				selected_session_id: "session-a",
				transcript: [],
			};
		});
		const beforeTranscript = getDesktopViewState().snapshot.transcript;

		applyAgentRunEvent(textEvent("run-b", "session-b", "hidden update"));

		const after = getDesktopViewState();
		expect(after.snapshot.transcript).toBe(beforeTranscript);
		expect(after.snapshot.transcript).toHaveLength(0);
		expect(after.liveRuns["run-b"]?.events).toHaveLength(1);
		expect(after.activeRunId).toBeNull();
		expect(after.isStreaming).toBe(false);
	});

	test("background terminal status does not clear visible run chrome", () => {
		commitState((draft) => {
			draft.snapshot = {
				workspaces: [],
				sessions: [],
				selected_workspace_path: "/tmp/workspace",
				selected_session_id: "session-a",
				transcript: [],
			};
		});
		beginPromptRun("visible prompt");
		attachStartedRun({
			run_id: "run-a",
			session_id: "session-a",
			workspace_path: "/tmp/workspace",
		});

		applyRunStatusEvent({
			kind: "run.status",
			run_id: "run-b",
			session_id: "session-b",
			workspace_path: "/tmp/workspace",
			status: "error",
			message: "background failed",
		});

		const after = getDesktopViewState();
		expect(after.activeRunId).toBe("run-a");
		expect(after.isStreaming).toBe(true);
		expect(after.errorMessage).toBeNull();
		expect(after.liveRuns["run-b"]?.status).toBe("error");
	});

	test("visible active steps are not aliased to live run buffers", () => {
		commitState((draft) => {
			draft.snapshot = {
				workspaces: [],
				sessions: [],
				selected_workspace_path: "/tmp/workspace",
				selected_session_id: "session-a",
				transcript: [],
			};
		});

		applyAgentRunEvent({
			kind: "agent.event",
			run_id: "run-a",
			session_id: "session-a",
			workspace_path: "/tmp/workspace",
			seq: 1,
			event: {
				type: "step_start",
				step_id: "step-1",
				step_number: 1,
				title: "Inspect state",
			},
		});

		const after = getDesktopViewState();
		expect(after.activeSteps).toEqual([
			{ step_id: "step-1", step_number: 1, title: "Inspect state" },
		]);
		expect(after.liveRuns["run-a"]?.activeSteps).toEqual(after.activeSteps);
		expect(after.activeSteps).not.toBe(after.liveRuns["run-a"]?.activeSteps);
	});
});
