import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { viewerApiSchema } from "./api-schema";
import { loadViewerConfig } from "./config";
import {
	getJobDetail,
	getTaskHistory,
	listJobSummaries,
	listTaskAggregates,
} from "./data";

const app = new Hono();
const port = Number(process.env.PORT) || 3310;
const clientDistDir = path.resolve(import.meta.dir, "../client");

const parseBoolean = (value: string | undefined) =>
	value === "1" || value === "true" || value === "yes" || value === "on";
const parsePositiveInt = (value: string | undefined) => {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const getResolvedConfig = async () => loadViewerConfig();

const respondMissingClient = () =>
	new Response(
		"Client build not found. Use `bun run --filter @codelia/terminal-bench-viewer dev` for local development or build the client first.",
		{ status: 503 },
	);

app.use("*", cors());

app.get("/api/health", (c) => c.json({ ok: true }));
app.get("/api/schema", (c) => c.json(viewerApiSchema));

app.get("/api/config", async (c) => {
	const config = await getResolvedConfig();
	return c.json(config);
});

app.get("/api/jobs", async (c) => {
	const config = await getResolvedConfig();
	const jobs = await listJobSummaries(config.jobsDir);
	return c.json({ jobs });
});

app.get("/api/tasks", async (c) => {
	const config = await getResolvedConfig();
	const includePartial = parseBoolean(c.req.query("include_partial"));
	const tasks = await listTaskAggregates(config.jobsDir, includePartial, {
		recentWindow: parsePositiveInt(c.req.query("recent_window")),
		recentDays: parsePositiveInt(c.req.query("recent_days")),
	});
	return c.json({ tasks });
});

app.get("/api/jobs/:jobId", async (c) => {
	const config = await getResolvedConfig();
	const detail = await getJobDetail(config.jobsDir, c.req.param("jobId"));
	if (!detail) {
		return c.json({ error: "job not found" }, 404);
	}
	return c.json(detail);
});

app.get("/api/tasks/:taskName/history", async (c) => {
	const config = await getResolvedConfig();
	const includePartial = parseBoolean(c.req.query("include_partial"));
	const jobIds = c.req.query("job_ids")?.split(",").filter(Boolean);
	const history = await getTaskHistory(
		config.jobsDir,
		c.req.param("taskName"),
		includePartial,
		jobIds && jobIds.length > 0 ? jobIds : undefined,
	);
	return c.json({ history });
});

app.get("*", async (c) => {
	const pathname = new URL(c.req.url).pathname;
	const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
	const assetPath = path.join(clientDistDir, requestedPath);
	const asset = Bun.file(assetPath);
	if (await asset.exists()) {
		return new Response(asset);
	}

	if (!path.extname(pathname)) {
		const indexFile = Bun.file(path.join(clientDistDir, "index.html"));
		if (await indexFile.exists()) {
			return new Response(indexFile, {
				headers: {
					"Content-Type": "text/html; charset=utf-8",
				},
			});
		}
		return respondMissingClient();
	}

	return c.notFound();
});

console.log(
	`[terminal-bench-viewer] server listening on http://localhost:${port}`,
);

export default {
	port,
	idleTimeout: 120,
	fetch: app.fetch,
};
