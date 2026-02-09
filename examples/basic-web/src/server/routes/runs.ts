import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { RunBackend, RunStatus } from "../runs/run-manager";

const createRunInput = z.object({
	session_id: z.string().min(1),
	message: z.string().min(1),
});

const RUN_STATUSES: RunStatus[] = [
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
];
const RUN_STATUS_SET = new Set<RunStatus>(RUN_STATUSES);

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const EVENT_BATCH_LIMIT = 100;
const TERMINAL_CHECK_LIMIT = 1;
const WAIT_TIMEOUT_MS = 20_000;

const parseStatuses = (raw: string | undefined): RunStatus[] | undefined => {
	if (!raw) return undefined;
	const parts = raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length === 0) return undefined;

	const statuses: RunStatus[] = [];
	for (const part of parts) {
		if (RUN_STATUS_SET.has(part as RunStatus)) {
			statuses.push(part as RunStatus);
		}
	}
	return statuses.length > 0 ? statuses : undefined;
};

const parseListLimit = (raw: string | undefined): number => {
	if (!raw) return DEFAULT_LIST_LIMIT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIST_LIMIT;
	return Math.min(MAX_LIST_LIMIT, Math.floor(parsed));
};

const parseCursor = (raw: string | undefined): number => {
	if (!raw) return -1;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return -1;
	return Math.max(-1, Math.floor(parsed));
};

export const createRunRoutes = (runs: RunBackend) => {
	const app = new Hono();

	app.get("/", async (c) => {
		const sessionId = c.req.query("session_id")?.trim();
		if (!sessionId) {
			return c.json({ error: "session_id is required" }, 400);
		}

		const statuses = parseStatuses(c.req.query("statuses"));
		const limit = parseListLimit(c.req.query("limit"));
		const list = await runs.listRuns({
			sessionId,
			statuses,
			limit,
		});
		return c.json({ runs: list });
	});

	app.post("/", async (c) => {
		const body = await c.req.json();
		const parsed = createRunInput.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "Invalid input", details: parsed.error }, 400);
		}

		const created = await runs.createRun({
			sessionId: parsed.data.session_id,
			message: parsed.data.message,
		});
		return c.json({
			run_id: created.runId,
			status: created.status,
		});
	});

	app.get("/:runId", async (c) => {
		const runId = c.req.param("runId");
		const run = await runs.getRun(runId);
		if (!run) {
			return c.json({ error: "Run not found" }, 404);
		}
		return c.json(run);
	});

	app.post("/:runId/cancel", async (c) => {
		const runId = c.req.param("runId");
		const ok = await runs.requestCancel(runId);
		if (!ok) {
			return c.json({ error: "Run not found" }, 404);
		}
		return c.json({ ok: true });
	});

	app.get("/:runId/events", async (c) => {
		const runId = c.req.param("runId");
		if (!(await runs.getRun(runId))) {
			return c.json({ error: "Run not found" }, 404);
		}

		const headerCursor = c.req.header("last-event-id");
		const queryCursor = c.req.query("cursor");
		const initialCursor = parseCursor(headerCursor ?? queryCursor);

		c.header("Cache-Control", "no-store");
		c.header("X-Accel-Buffering", "no");

		return streamSSE(c, async (stream) => {
			let cursor = initialCursor;
			let closed = false;

			const send = async (event: {
				seq: number;
				type: string;
				data: Record<string, unknown>;
			}): Promise<boolean> => {
				if (closed) return false;
				try {
					await stream.writeSSE({
						id: String(event.seq),
						event: event.type,
						data: JSON.stringify(event.data),
					});
					cursor = event.seq;
					return true;
				} catch {
					closed = true;
					return false;
				}
			};

			const sendPing = async (): Promise<boolean> => {
				if (closed) return false;
				try {
					await stream.writeSSE({
						event: "ping",
						data: "{}",
					});
					return true;
				} catch {
					closed = true;
					return false;
				}
			};

			const flushPendingEvents = async (): Promise<boolean> => {
				const pending = await runs.listEventsAfter(
					runId,
					cursor,
					EVENT_BATCH_LIMIT,
				);
				for (const event of pending) {
					const ok = await send(event);
					if (!ok) return false;
				}
				return !closed;
			};

			const shouldStopStreaming = async (): Promise<boolean> => {
				const run = await runs.getRun(runId);
				if (!run) return true;
				if (!runs.isTerminalStatus(run.status)) return false;
				const hasMore =
					(await runs.listEventsAfter(runId, cursor, TERMINAL_CHECK_LIMIT))
						.length > 0;
				return !hasMore;
			};

			while (!closed) {
				if (!(await flushPendingEvents())) break;
				if (await shouldStopStreaming()) break;

				const wait = await runs.waitForNewEvent(
					runId,
					cursor,
					c.req.raw.signal,
					WAIT_TIMEOUT_MS,
				);
				if (wait === "aborted" || wait === "missing") break;
				if (wait === "timeout" && !(await sendPing())) break;
			}
		});
	});

	return app;
};
