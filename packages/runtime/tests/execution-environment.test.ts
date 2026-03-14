import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import {
	appendInitialExecutionEnvironment,
	buildExecutionEnvironmentContext,
	collectExecutionEnvironmentStartupChecks,
	logInitialExecutionEnvironmentDebug,
	probeExecutionEnvironmentCommand,
} from "../src/execution-environment";

type FakeShellChild = EventEmitter & {
	pid: number;
	stdout: Readable;
	stderr: Readable;
	kill: (signal?: NodeJS.Signals | number) => boolean;
};

const createFakeChild = (options?: {
	onKill?: (
		signal: NodeJS.Signals | number | undefined,
		child: FakeShellChild,
	) => void;
}): FakeShellChild => {
	const child = new EventEmitter() as FakeShellChild;
	child.pid = 4242;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = (signal) => {
		options?.onKill?.(signal, child);
		return true;
	};
	return child;
};

describe("execution environment context", () => {
	test("buildExecutionEnvironmentContext renders plaintext startup checks with richer host info", async () => {
		const probedCommands: string[] = [];
		const context = await buildExecutionEnvironmentContext({
			workingDir: "/repo/packages/runtime",
			sandboxRoot: "/repo",
			config: {
				startupChecks: {
					enabled: true,
					commands: [
						["python", "--version"],
						["python3", "--version"],
					],
					timeoutMs: 750,
				},
			},
			hostInfo: {
				osDescription: "Linux 6.8.0 (linux x64)",
				shellExecution: "/bin/zsh -lc",
				bashSyntaxGuaranteed: false,
			},
			probeCommand: async (command) => {
				probedCommands.push(command.join(" "));
				return command[0] === "python3" ? "Python 3.12.8" : "exit 127";
			},
		});

		expect(probedCommands).toEqual(["python --version", "python3 --version"]);
		expect(context).toContain("<execution_environment>");
		expect(context).toContain("os: Linux 6.8.0 (linux x64)");
		expect(context).toContain(
			"shell tool execution environment: /bin/zsh -lc",
		);
		expect(context).toContain("bash syntax guaranteed: false");
		expect(context).toContain("sandbox root: /repo");
		expect(context).toContain("working directory: /repo/packages/runtime");
		expect(context).toContain("startup checks:");
		expect(context).toContain('- "python --version" => exit 127');
		expect(context).toContain('- "python3 --version" => Python 3.12.8');
		expect(context).toContain("</execution_environment>");
	});

	test("collectExecutionEnvironmentStartupChecks skips probes when disabled", async () => {
		let calls = 0;
		const checks = await collectExecutionEnvironmentStartupChecks({
			config: {
				startupChecks: {
					enabled: false,
					commands: [["rg", "--version"]],
					timeoutMs: 500,
				},
			},
			workingDir: "/repo",
			probeCommand: async () => {
				calls += 1;
				return "ripgrep 14.1.1";
			},
		});

		expect(calls).toBe(0);
		expect(checks).toEqual([]);
	});

	test("collectExecutionEnvironmentStartupChecks runs probes concurrently and preserves command order", async () => {
		const started: string[] = [];
		const resolvers = new Map<string, (value: string) => void>();
		const checksPromise = collectExecutionEnvironmentStartupChecks({
			config: {
				startupChecks: {
					enabled: true,
					commands: [
						["python", "--version"],
						["python3", "--version"],
						["bun", "--version"],
					],
					timeoutMs: 500,
				},
			},
			workingDir: "/repo",
			probeCommand: (command) => {
				const label = command.join(" ");
				started.push(label);
				return new Promise((resolve) => {
					resolvers.set(label, resolve);
				});
			},
		});

		expect(started).toEqual([
			"python --version",
			"python3 --version",
			"bun --version",
		]);

		resolvers.get("python3 --version")?.("Python 3.12.8");
		resolvers.get("bun --version")?.("1.3.9");
		resolvers.get("python --version")?.("exit 127");

		await expect(checksPromise).resolves.toEqual([
			{
				command: ["python", "--version"],
				summary: "exit 127",
			},
			{
				command: ["python3", "--version"],
				summary: "Python 3.12.8",
			},
			{
				command: ["bun", "--version"],
				summary: "1.3.9",
			},
		]);
	});

	test("probeExecutionEnvironmentCommand shells out through the shared shell path", async () => {
		let invoked: { command: string; cwd: string } | undefined;
		const child = createFakeChild();
		queueMicrotask(() => {
			(child.stdout as PassThrough).end("Python 3.12.8\n");
			child.emit("close", 0, null);
		});

		const summary = await probeExecutionEnvironmentCommand(
			["python3", "--version"],
			500,
			"/repo",
			{
				spawnProcess: (command, cwd) => {
					invoked = { command, cwd };
					return child as never;
				},
			},
		);

		if (!invoked) {
			throw new Error("expected spawnProcess to be called");
		}
		expect(invoked).toEqual({ command: "'python3' '--version'", cwd: "/repo" });
		expect(summary).toBe("Python 3.12.8");
	});

	test("probeExecutionEnvironmentCommand resolves on timeout even if child ignores termination", async () => {
		const signals: Array<NodeJS.Signals | number | undefined> = [];
		const child = createFakeChild();
		const startedAt = Date.now();
		const summary = await probeExecutionEnvironmentCommand(
			["sleep", "999"],
			20,
			"/repo",
			{
				spawnProcess: () => child as never,
				terminateProcess: (_child, signal) => {
					signals.push(signal);
				},
				forceKillDelayMs: 1,
			},
		);

		expect(summary).toBe("timeout after 20ms");
		expect(Date.now() - startedAt).toBeLessThan(200);
		await Bun.sleep(10);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	test("appendInitialExecutionEnvironment appends after base prompt", () => {
		expect(
			appendInitialExecutionEnvironment(
				"base system prompt",
				"<execution_environment>\nos: Linux\n</execution_environment>",
			),
		).toBe(
			"base system prompt\n\n<execution_environment>\nos: Linux\n</execution_environment>",
		);
	});

	test("logInitialExecutionEnvironmentDebug logs once and skips repeats", () => {
		const messages: string[] = [];
		const context = "<execution_environment>\nos: Linux\n</execution_environment>";

		expect(
			logInitialExecutionEnvironmentDebug(context, {
				alreadyLogged: false,
				log: (message) => {
					messages.push(message);
				},
			}),
		).toBe(true);
		expect(messages).toEqual([
			"startup execution environment context\n<execution_environment>\nos: Linux\n</execution_environment>",
		]);
		expect(
			logInitialExecutionEnvironmentDebug(context, {
				alreadyLogged: true,
				log: (message) => {
					messages.push(message);
				},
			}),
		).toBe(false);
		expect(messages).toHaveLength(1);
	});
});
