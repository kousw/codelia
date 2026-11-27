import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const fakeRuntime = [
	'import { createInterface } from "node:readline";',
	'assertCapability(process.env.CAPABILITY === "1");',
	"function assertCapability(expected) {",
	'  const run_id = "active-run";',
	'  const p = "75b1341f-d51e-48d5-bb34-28c89ea14e07";',
	'  const write = (...messages) => process.stdout.write(messages.map((message) => JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n").join(""));',
	'  const shellParams = { run_id, approval: true, title: "Approve shell?", items: [{ id: p + "/save_project" }, { id: p + "/allow_once" }] };',
	"  const queries = [",
	'    ["ui.pick.request", shellParams, { ids: process.env.ALLOW === "1" ? [p + "/allow_once"] : [] }],',
	'    ["ui.pick.request", { ...shellParams, title: "Approve apply_patch?" }, { ids: [] }],',
	'    ["ui.pick.request", { ...shellParams, run_id: "old-run" }, { ids: [] }],',
	'    ["ui.pick.request", { ...shellParams, approval: false }, { ids: [] }],',
	'    ["ui.pick.request", { ...shellParams, items: shellParams.items.slice(0, 1) }, { ids: [] }],',
	'    ["ui.pick.request", { ...shellParams, items: [shellParams.items[1], shellParams.items[1]] }, { ids: [] }],',
	'    ["ui.confirm.request", { run_id }, { ok: false }],',
	'    ["ui.prompt.request", { run_id }, { value: null }],',
	"  ];",
	'  const outstanding = new Map(queries.map((query, index) => ["ui_" + (index + 1), query[2]]));',
	'  function finish() { write({ method: "run.end", params: { run_id, final: "Fixture completed." } }, { method: "run.status", params: { run_id, status: "completed" } }); }',
	'  createInterface({ input: process.stdin }).on("line", (line) => {',
	"    const { id, method, result, params } = JSON.parse(line);",
	'    if (method === "initialize") {',
	'      if (Boolean(params.ui_capabilities.supports_structured_approval) !== expected || params.ui_capabilities.supports_pick !== expected) throw Error("unexpected capabilities");',
	"      const sandbox = process.env.REPORTED_MODE ? { sandbox_mode: { value: process.env.REPORTED_MODE } } : {};",
	"      write({ id, result: { ...sandbox, server_capabilities: { supports_structured_approval: true } } });",
	'    } else if (method === "run.start") {',
	'      write({ id, result: { run_id, session_log_path: process.env.SESSION_LOG } }, ...queries.map(([method, params], index) => ({ id: "ui_" + (index + 1), method, params })));',
	"      if (!expected) setTimeout(finish, 30);",
	'      else setTimeout(() => { if (outstanding.size) throw Error("missing approval reply"); }, 3000).unref();',
	"    } else {",
	'      if (!expected || !outstanding.has(id) || JSON.stringify(result) !== JSON.stringify(outstanding.get(id))) throw Error("unexpected reply " + line);',
	"      outstanding.delete(id);",
	"      if (!outstanding.size) finish();",
	"    }",
	"  });",
	"}",
].join("\n");

test.each([
	{
		name: "Harbor full-access",
		marker: true,
		args: ["--sandbox-mode", "full-access", "--harbor-shell-approval"],
		requested: "full-access",
		reported: "full-access",
		capability: true,
		allow: true,
	},
	{
		name: "ordinary full-access with an environment-only Harbor marker",
		marker: true,
		args: ["--sandbox-mode", "full-access"],
		requested: "full-access",
		reported: "full-access",
		capability: false,
		allow: false,
	},
	{
		name: "full-access with the Harbor flag alone",
		marker: false,
		args: ["--sandbox-mode", "full-access", "--harbor-shell-approval"],
		requested: "full-access",
		reported: "full-access",
		capability: false,
		allow: false,
	},
	{
		name: "Harbor readonly",
		marker: true,
		args: ["--sandbox-mode", "readonly", "--harbor-shell-approval"],
		requested: "readonly",
		reported: "readonly",
		capability: false,
		allow: false,
	},
	{
		name: "runtime used a different profile",
		marker: true,
		args: ["--sandbox-mode", "full-access", "--harbor-shell-approval"],
		requested: "full-access",
		reported: "readonly",
		capability: true,
		allow: false,
	},
	{
		name: "legacy runtime omitted the reported mode",
		marker: true,
		args: ["--sandbox-mode", "full-access", "--harbor-shell-approval"],
		requested: "full-access",
		reported: null,
		capability: true,
		allow: false,
	},
])(
	"prompt mode restricts headless replies and records the reported mode in $name",
	async ({ marker, args, requested, reported, capability, allow }) => {
		const root = await mkdtemp(path.join(tmpdir(), "codelia-harbor-approval-"));
		try {
			const runtime = path.join(root, "runtime.mjs");
			const sessionLog = path.join(root, "session.jsonl");
			const trajectoryPath = path.join(root, "trajectory.json");
			await writeFile(runtime, fakeRuntime);
			await writeFile(sessionLog, '{"type":"header","session_id":"fixture"}\n');
			const cli = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "../src/index.ts"),
					"-p",
					"Fixture task.",
					...args,
				],
				{
					env: {
						PATH: process.env.PATH,
						CODELIA_RUNTIME_CMD: process.execPath,
						CODELIA_RUNTIME_ARGS: JSON.stringify(runtime),
						CODELIA_HARBOR_SHELL_APPROVAL: marker ? "1" : "0",
						CODELIA_ATIF_OUT: trajectoryPath,
						SESSION_LOG: sessionLog,
						CAPABILITY: capability ? "1" : "0",
						REPORTED_MODE: reported ?? "",
						ALLOW: allow ? "1" : "0",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				cli.exited,
				new Response(cli.stdout).text(),
				new Response(cli.stderr).text(),
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout.trim()).toBe("Fixture completed.");
			const trajectory = await Bun.file(trajectoryPath).json();
			expect(trajectory.extra.run_id).toBe("active-run");
			if (requested) {
				expect(trajectory.extra).toMatchObject({
					sandbox_mode_requested: requested,
					sandbox_mode: reported,
				});
			} else {
				expect(trajectory.extra).not.toHaveProperty("sandbox_mode_requested");
				expect(trajectory.extra).not.toHaveProperty("sandbox_mode");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
