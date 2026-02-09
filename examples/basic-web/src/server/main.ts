import { Hono } from "hono";
import { cors } from "hono/cors";
import { AgentPool } from "./agent/agent-pool";
import { createChatRoutes } from "./routes/chat";
import { createRunRoutes } from "./routes/runs";
import { createSessionRoutes } from "./routes/sessions";
import { createSettingsRoutes } from "./routes/settings";
import { PostgresRunManager } from "./runs/postgres-run-manager";
import { RunManager } from "./runs/run-manager";
import { PostgresSessionManager } from "./sessions/postgres-session-manager";
import { SessionManager } from "./sessions/session-manager";
import { PostgresSettingsStore } from "./settings/postgres-settings-store";
import { SettingsStore } from "./settings/settings-store";

type RunRole = "api" | "worker" | "all";

const parseRunRole = (value: string | undefined): RunRole => {
	if (value === "api" || value === "worker" || value === "all") return value;
	return "all";
};

const parseDatabaseUrl = (value: string | undefined): string | null => {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
};

const resolveEffectiveRunRole = (
	runRole: RunRole,
	hasDatabaseUrl: boolean,
): RunRole => {
	if (runRole === "worker" && !hasDatabaseUrl) return "all";
	return runRole;
};

const runRole = parseRunRole(process.env.CODELIA_RUN_ROLE);
const databaseUrl = parseDatabaseUrl(process.env.DATABASE_URL);
const hasDatabaseUrl = databaseUrl !== null;
const sessionManager = hasDatabaseUrl
	? new PostgresSessionManager(databaseUrl)
	: new SessionManager();
const settingsStore = hasDatabaseUrl
	? new PostgresSettingsStore(databaseUrl)
	: new SettingsStore();
const pool = new AgentPool(sessionManager, settingsStore);
const effectiveRunRole = resolveEffectiveRunRole(runRole, hasDatabaseUrl);
if (effectiveRunRole !== runRole) {
	console.warn(
		"[basic-web] CODELIA_RUN_ROLE=worker without DATABASE_URL is not supported; using CODELIA_RUN_ROLE=all",
	);
}
const runManager = hasDatabaseUrl
	? new PostgresRunManager(pool, {
			databaseUrl,
			enableWorker: effectiveRunRole !== "api",
		})
	: new RunManager(pool);
const runBackendLabel = hasDatabaseUrl ? "postgres" : "memory";

const app = new Hono();

app.use("*", cors());

const mountApiRoutes = () => {
	if (effectiveRunRole === "worker") return;
	app.route("/api/chat", createChatRoutes(pool));
	app.route("/api/runs", createRunRoutes(runManager));
	app.route("/api/sessions", createSessionRoutes(sessionManager, pool));
	app.route("/api/settings", createSettingsRoutes(settingsStore, pool));
};

mountApiRoutes();

// Health check
app.get("/api/health", (c) =>
	c.json({
		ok: true,
		run_role: effectiveRunRole,
		run_backend: runBackendLabel,
	}),
);

const port = Number(process.env.PORT) || 3001;

console.log(
	`[basic-web] server listening on http://localhost:${port} role=${effectiveRunRole} runs=${runBackendLabel}`,
);

process.on("SIGINT", () => {
	console.log("[basic-web] shutting down...");
	void runManager.dispose();
	void sessionManager.dispose?.();
	void settingsStore.dispose?.();
	pool.dispose();
	process.exit(0);
});

export default {
	port,
	// Keep SSE connections alive during long tool runs.
	idleTimeout: 120,
	fetch: app.fetch,
};
