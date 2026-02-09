import crypto from "node:crypto";
import type { SessionState } from "@codelia/core";
import { Hono } from "hono";
import type { AgentPool } from "../agent/agent-pool";
import type { SessionManagerLike } from "../sessions/session-manager";

export const createSessionRoutes = (
	sessionManager: SessionManagerLike,
	pool: AgentPool,
) => {
	const app = new Hono();

	// List all sessions
	app.get("/", async (c) => {
		const summaries = await sessionManager.list();
		summaries.sort(
			(a, b) =>
				new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
		);
		return c.json(summaries);
	});

	// Create new session
	app.post("/", async (c) => {
		const sessionId = crypto.randomUUID().slice(0, 8);
		const state: SessionState = {
			schema_version: 1,
			session_id: sessionId,
			updated_at: new Date().toISOString(),
			messages: [],
		};
		await sessionManager.save(state);
		return c.json({ session_id: sessionId });
	});

	// Get session state (history)
	app.get("/:id", async (c) => {
		const id = c.req.param("id");
		const state = await sessionManager.load(id);
		if (!state) {
			return c.json({ error: "Session not found" }, 404);
		}
		return c.json(state);
	});

	// Delete session
	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		const deleted = await sessionManager.delete(id);
		if (!deleted) {
			return c.json({ error: "Session not found" }, 404);
		}
		return c.json({ ok: true });
	});

	// Cancel active run
	app.post("/:id/cancel", async (c) => {
		const id = c.req.param("id");
		const cancelled = pool.cancelRun(id);
		return c.json({ ok: cancelled });
	});

	return app;
};
