import { expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const fakeRuntime = [
	'import { createInterface } from "node:readline";',
	'const sandbox = process.argv[process.argv.indexOf("--sandbox-mode") + 1];',
	'const write = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));',
	'createInterface({ input: process.stdin }).on("line", (line) => {',
	"  const { id, method } = JSON.parse(line);",
	'  if (method === "initialize") write({ id, result: { sandbox_mode: { value: sandbox } } });',
	'  if (method === "run.start") {',
	'    write({ id, result: { run_id: "fixture" } });',
	'    write({ method: "run.status", params: { run_id: "fixture", status: "completed" } });',
	"  }",
	"});",
].join("\n");

const runScript = async (argv: string[], root: string) => {
	const result = Bun.spawn(argv, {
		env: {
			PATH: process.env.PATH,
			CODELIA_LAYOUT: "xdg",
			XDG_STATE_HOME: path.join(root, "state"),
			CODELIA_SANDBOX_MODE: "full-access",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		result.exited,
		new Response(result.stdout).text(),
		new Response(result.stderr).text(),
	]);
	expect(exitCode, stdout + stderr).toBe(0);
};

test.each([
	{ args: [], legacy: null, expected: "workspace-write", useLocalScript: true },
	{
		args: ["--sandbox-mode=full-access"],
		legacy: null,
		expected: "full-access",
	},
	{
		args: ["--approval-mode", "full-access"],
		legacy: "full-access",
		expected: "workspace-write",
	},
	{
		args: ["--approval-mode=minimal"],
		legacy: "minimal",
		expected: "readonly",
	},
	{
		args: ["--approval-mode=full-access", "--sandbox-mode", "readonly"],
		legacy: "full-access",
		expected: "readonly",
	},
])(
	"the headless harness records the mode it launches ($expected)",
	async ({ args, legacy, expected, useLocalScript }) => {
		const root = await mkdtemp(path.join(tmpdir(), "codelia-bench-mode-"));
		try {
			const runtime = path.join(root, "runtime.mjs");
			const artifacts = path.join(root, "artifacts");
			await writeFile(runtime, fakeRuntime);
			const launcher =
				useLocalScript && process.platform !== "win32"
					? ["bash", path.join(import.meta.dir, "run-local.sh")]
					: [process.execPath, path.join(import.meta.dir, "run-benchmark.mjs")];
			await runScript(
				[
					...launcher,
					"--prompt",
					"Fixture task.",
					"--runtime-cmd",
					process.execPath,
					"--runtime-args",
					JSON.stringify(runtime),
					"--artifacts-root",
					artifacts,
					...args,
				],
				root,
			);
			const [run] = await readdir(artifacts);
			const metadata = await Bun.file(
				path.join(artifacts, run, "run-metadata.json"),
			).json();
			expect(metadata).toMatchObject({
				approval_mode: legacy,
				sandbox_mode_requested: expected,
				sandbox_mode: expected,
				sandbox_backend: expected === "full-access" ? "none" : null,
				runtime_args: [runtime, "--sandbox-mode", expected],
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("quick-subset keeps explicit sandbox selections and removes conflicting inherited kwargs", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "codelia-bench-subset-mode-"));
	const job = path.join(root, "job");
	const trial = path.join(job, "trial");
	const configPath = path.join(job, "config.json");
	const time = "2026-11-21T00:00:00Z";
	try {
		await mkdir(trial, { recursive: true });
		for (const [directory, result] of [
			[job, { finished_at: time, n_total_trials: 1 }],
			[
				trial,
				{
					task_name: "fixture",
					started_at: time,
					finished_at: time,
					agent_execution: { started_at: time, finished_at: time },
					verifier_result: { reward: 1 },
				},
			],
		] as const) {
			await writeFile(
				path.join(directory, "result.json"),
				JSON.stringify(result),
			);
		}
		for (const [baseKwargs, override, selectedKwargs] of [
			[{ approval_mode: "full-access" }, [], { approval_mode: "full-access" }],
			[
				{ approval_mode: "full-access" },
				["--sandbox-mode", "readonly"],
				{ sandbox_mode: "readonly" },
			],
			[
				{ sandbox_mode: "full-access" },
				["--approval-mode=full-access"],
				{ approval_mode: "full-access" },
			],
		] as const) {
			await writeFile(
				configPath,
				JSON.stringify({
					datasets: [{ name: "fixture", version: "1" }],
					agents: [{ kwargs: baseKwargs }],
				}),
			);
			const out = path.join(root, "out.json");
			await runScript(
				[
					process.execPath,
					path.join(import.meta.dir, "quick-subset.mjs"),
					"--jobs-dir",
					root,
					"--base-job",
					job,
					"--output-config",
					out,
					"--min-runs",
					"1",
					"--max-success-rate",
					"1",
					...override,
				],
				root,
			);
			const result = JSON.parse(await readFile(out, "utf8"));
			expect(result.agents[0].kwargs).toEqual(selectedKwargs);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
