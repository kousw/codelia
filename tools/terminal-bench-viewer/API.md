# terminal-bench-viewer API

Agent-friendly contract for the local viewer server.

## Discovery

Fetch [`/api/schema`](http://localhost:3310/api/schema) first.

- It returns a machine-readable summary of all endpoints, parameters, and response types.
- It is the intended entrypoint for local agents and scripts.
- All API routes are read-only and return JSON.

## Calling examples

### `curl`

```bash
curl http://localhost:3310/api/schema | jq
curl http://localhost:3310/api/config | jq
curl http://localhost:3310/api/jobs | jq '.jobs[:3]'
curl "http://localhost:3310/api/tasks?recent_window=10" | jq '.tasks[:10]'
curl "http://localhost:3310/api/tasks/query-optimize/history" | jq '.history[:5]'
```

### `fetch` from Bun / Node

```ts
const base = "http://localhost:3310";

const fetchJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}`);
  }
  return (await response.json()) as T;
};

const schema = await fetchJson("/api/schema");
const config = await fetchJson("/api/config");
const jobs = await fetchJson("/api/jobs");
const tasks = await fetchJson("/api/tasks?recent_window=10");
const history = await fetchJson("/api/tasks/query-optimize/history");
```

### Example analysis flow

```ts
const tasksPayload = await fetchJson<{ tasks: Array<{
  taskName: string;
  successRate: number | null;
  windowSuccessRate: number | null;
  windowSuccessDelta: number | null;
  windowExecutionDeltaSec: number | null;
}> }>("/api/tasks?recent_window=10");

const degraded = tasksPayload.tasks
  .filter((task) => typeof task.windowSuccessDelta === "number")
  .sort((a, b) => (a.windowSuccessDelta ?? 0) - (b.windowSuccessDelta ?? 0))
  .slice(0, 10);

console.log(degraded);
```

## Recommended flow

1. `GET /api/schema`
2. `GET /api/config`
3. `GET /api/jobs`
4. `GET /api/jobs/{jobId}`
5. `GET /api/tasks?recent_window=5`
6. `GET /api/tasks/{taskName}/history`

## Endpoints

### `GET /api/health`

Simple health check.

Response:

```json
{
  "ok": true
}
```

### `GET /api/schema`

Machine-readable discovery document. Use this for automation instead of scraping HTML or README text.

### `GET /api/config`

Returns the resolved config.

Response shape:

```json
{
  "jobsDir": "/abs/path/to/jobs",
  "configFiles": ["/abs/path/to/config.local.json", "/abs/path/to/config.json"]
}
```

### `GET /api/jobs`

Returns all parsed jobs, newest first.

Response shape:

```json
{
  "jobs": ["JobSummary", "..."]
}
```

### `GET /api/jobs/{jobId}`

Returns one job plus its per-task rows.

Success response shape:

```json
{
  "job": "JobSummary",
  "tasks": ["TaskResultRow", "..."]
}
```

Not found:

```json
{
  "error": "job not found"
}
```

### `GET /api/tasks`

Returns task-level aggregates across jobs.

Query parameters:

- `include_partial=1` to include partial jobs
- `recent_window=<N>` for recent N runs per task
- `recent_days=<N>` for runs in the last N days
- `model_name=<model>` to restrict aggregates to one model

Response shape:

```json
{
  "tasks": ["TaskAggregateSummary", "..."]
}
```

Useful fields:

- `successRate`: overall success rate
- `windowSuccessRate`: success rate in the active recent window
- `windowSuccessDelta`: recent minus overall success rate
- `windowExecutionDeltaSec`: recent minus overall execution time

### `GET /api/tasks/{taskName}/history`

Returns per-job history for one task, newest first.

Query parameters:

- `include_partial=1` to include partial jobs
- `job_ids=job-a,job-b` to restrict history rows
- `model_name=<model>` to restrict history rows to one model

Response shape:

```json
{
  "history": ["TaskHistoryPoint", "..."]
}
```

## Notes for agents

- Default behavior excludes partial jobs from task history and task aggregate responses.
- `include_partial` accepts `1`, `true`, `yes`, or `on`.
- `recent_window` and `recent_days` are mutually optional. If neither is set, the server uses its default recent window.
- The canonical field list lives in [`src/server/api-schema.ts`](./src/server/api-schema.ts).
- For automated clients, prefer reading `/api/schema` and generating requests from that document instead of hardcoding assumptions.
