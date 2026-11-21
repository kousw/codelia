import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const command = "printf codelia-shell-smoke";
const fixture = `
const { spawn } = require("node:child_process");
const { realpathSync } = require("node:fs");
const { createMacMxcShellBackend, startRuntime } = require("@codelia/runtime/sdk");
const mode = process.argv[1];
const executable = realpathSync(process.execPath);
const proposed = ${JSON.stringify(command)};
const isolatedContract = {
  workspace: { filesystem: "enabled", process: "runtime", sandboxMode: "readonly" },
  context: {
    systemPrompt: "runtime-default",
    projectInstructions: "disabled",
    skills: "disabled",
    executionEnvironment: "disabled",
  },
  auth: { model: "runtime-default" },
  config: { source: "disabled" },
  tools: { builtin: "none", search: "disabled", mcp: "disabled", host: "disabled" },
  persistence: { mode: "runtime" },
  events: { live: "json-rpc" },
};
const adapters = {
  approvalService: {
    confirm: async ({ requestId }) => ({ requestId, choice: "allow_once" }),
  },
  approvalShellSource: (source) => ({
    kind: "source", source, executable, options: [], dialect: "fixture",
  }),
  shellProtectionBackend: {
    supportsReadOnlyPaths: true,
    supports: ({ profile, stdin }) => profile === "investigation" && stdin === "closed",
    supportsInvocation: (invocation) =>
      mode === "fixture" && invocation.executable === executable && invocation.source === proposed,
    launch: (invocation, { cwd }) => {
      if (mode !== "fixture" || invocation.source !== proposed)
        throw new Error("Unexpected payload in release fixture");
      // A fixed fixture process exercises stream and lifecycle wiring, not OS containment.
      return spawn(executable, ["-e", "process.stdout.write('codelia-shell-smoke')"], {
        cwd,
        env: {},
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
  },
};
globalThis.fetch = () => { throw new Error("Network unavailable in release shell fixture"); };
startRuntime(mode === "mxc-sdk" ? {
  adapters: { shellProtectionBackend: createMacMxcShellBackend() },
} : ["standard", "review", "mxc-local", "mxc-full-access"].includes(mode) ? {} : {
  environment: { contract: isolatedContract },
  ...(mode === "missing" ? {} : { adapters }),
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

const runInstalledRpc = (cwd, env, mode, requests, reply) =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", fixture, mode], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "inherit"],
		});
		const responses = [];
		const write = (message) =>
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
		const sendNext = () => {
			const request = requests[responses.length];
			if (request) write({ id: `smoke-${responses.length}`, ...request });
			else child.stdin.end();
		};
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Installed runtime fixture timed out (${mode})`));
		}, 15_000);
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			try {
				const message = JSON.parse(line);
				if (message.method && message.id) {
					assert.ok(reply, `Unexpected request ${message.method}`);
					write({ id: message.id, result: reply(message, responses.length) });
				} else if (message.id === `smoke-${responses.length}`) {
					responses.push(message);
					sendNext();
				}
			} catch (error) {
				child.kill();
				reject(error);
			}
		});
		child.stdin.on("error", reject);
		child.once("error", reject);
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0 && responses.length === requests.length)
				resolve(responses);
			else
				reject(
					new Error(`Installed runtime fixture failed (${mode}, exit ${code})`),
				);
		});
		sendNext();
	});

export const isolatedSmokeEnv = (root) => ({
	...Object.fromEntries(
		Object.entries(process.env).filter(([name]) =>
			/^(?:PATH|SYSTEMROOT|WINDIR)$/i.test(name),
		),
	),
	HOME: root,
	USERPROFILE: root,
	CODELIA_LAYOUT: "xdg",
	CODELIA_SANDBOX_ROOT: path.join(root, "workspace"),
	XDG_CONFIG_HOME: path.join(root, "config"),
	XDG_STATE_HOME: path.join(root, "state"),
	XDG_CACHE_HOME: path.join(root, "cache"),
});

export const checkInstalledShell = async (projectDir, tempRoot) => {
	const modes = ["missing", "refuse", "fixture"];
	if (process.platform === "linux" || process.platform === "win32")
		modes.push("standard");
	for (const mode of modes) {
		const env = isolatedSmokeEnv(path.join(tempRoot, `shell-smoke-${mode}`));
		mkdirSync(env.CODELIA_SANDBOX_ROOT, { recursive: true });
		const [response] = await runInstalledRpc(projectDir, env, mode, [
			{
				method: "shell.exec",
				params: { command, timeout_seconds: 5 },
			},
		]);
		const linuxStandard = mode === "standard" && process.platform === "linux";
		if (mode === "fixture" || (linuxStandard && !response.error)) {
			assert.equal(response.error, undefined);
			assert.equal(response.result?.exit_code, 0);
			assert.equal(response.result.stdout, "codelia-shell-smoke");
		} else {
			assert.equal(response.result, undefined);
			assert.match(response.error?.message ?? "", /sandbox_unavailable/);
		}
	}
};

export const checkInstalledMxc = async (projectDir, tempRoot) => {
	assert.equal(`${process.platform}-${process.arch}`, "darwin-arm64");
	for (const mode of ["mxc-local", "mxc-sdk", "mxc-full-access"]) {
		const root = path.join(tempRoot, mode);
		const env = isolatedSmokeEnv(root);
		mkdirSync(env.CODELIA_SANDBOX_ROOT, { recursive: true });
		// The fixture outside the workspace is readable but writable only under
		// the explicitly selected full-access mode. No production data is used.
		const output = path.join(root, "fixture");
		const fullAccess = mode === "mxc-full-access";
		if (mode !== "mxc-sdk") env.CODELIA_MAC_SHELL_BACKEND = "mxc";
		if (fullAccess) env.CODELIA_SANDBOX_MODE = "full-access";
		const target = `'${output.replaceAll("'", "'\\''")}'`;
		const request = fullAccess
			? `printf codelia-shell-smoke > ${target} && cat ${target}`
			: `if printf blocked > ${target}; then exit 91; fi; ${command}`;
		const [initialized, response] = await runInstalledRpc(
			projectDir,
			env,
			mode,
			[
				{
					method: "initialize",
					params: {
						protocol_version: "0",
						client: { name: "codelia-tui", version: "smoke" },
						ui_capabilities: {
							supports_pick: true,
							supports_structured_approval: true,
						},
					},
				},
				{
					method: "shell.exec",
					params: { command: request, timeout_seconds: 5 },
				},
			],
			(message) => {
				assert.equal(message.method, "ui.pick.request");
				assert.equal(message.params.approval, true);
				assert.ok(message.params.message.includes(request));
				const choice = message.params.items.find(({ id }) =>
					id.endsWith("/allow_once"),
				);
				assert.ok(choice);
				return { ids: [choice.id] };
			},
		);
		assert.equal(
			initialized.error,
			undefined,
			JSON.stringify(initialized.error),
		);
		assert.equal(response.error, undefined, JSON.stringify(response.error));
		assert.equal(
			response.result?.exit_code,
			0,
			JSON.stringify(response.result),
		);
		assert.equal(response.result.stdout, "codelia-shell-smoke");
		console.log(`Installed runtime shell passed (${mode}).`);
	}
};

export const checkInstalledAutoReview = async (projectDir, tempRoot) => {
	if (process.platform === "win32") return;
	const env = isolatedSmokeEnv(path.join(tempRoot, "review-smoke"));
	mkdirSync(env.CODELIA_SANDBOX_ROOT, { recursive: true });
	env.CODELIA_CONFIG_PATH = path.join(env.HOME, "config.json");
	writeFileSync(
		env.CODELIA_CONFIG_PATH,
		JSON.stringify({
			version: 1,
			model: { provider: "google", name: "gemini-4-carbon" },
		}),
	);
	env.GEMINI_API_KEY = "fixture-google-key";
	env.ANTHROPIC_API_KEY = "fixture-anthropic-key";
	const screens = [];
	const [initialized, enabled, following, picked, status, disabled] =
		await runInstalledRpc(
			projectDir,
			env,
			"review",
			[
				{
					method: "initialize",
					params: {
						protocol_version: "0",
						client: { name: "codelia-tui", version: "smoke" },
						ui_capabilities: {
							supports_auth_management: true,
							supports_pick: true,
							supports_structured_approval: true,
						},
					},
				},
				{ method: "auto_review.configure", params: { action: "pick" } },
				{ method: "auto_review.configure", params: { action: "pick" } },
				{ method: "auto_review.configure", params: { action: "pick" } },
				{ method: "auto_review.configure", params: { action: "status" } },
				{ method: "auto_review.configure", params: { action: "off" } },
			],
			(message, requestIndex) => {
				assert.equal(message.method, "ui.pick.request");
				screens.push([requestIndex, message.params.title]);
				if (message.params.title === "Select an Auto approve mode") {
					const mode = ["enable", "follow", "pin"][requestIndex - 1];
					assert.ok(mode);
					assert.ok(message.params.items.some(({ id }) => id === mode));
					return { ids: [mode] };
				}
				assert.equal(message.params.title, "Select an Auto approve model");
				assert.equal(message.params.items.length, 8);
				const item = message.params.items.find(
					({ id }) => id === "anthropic/claude-haiku-5-5",
				);
				assert.match(
					item?.label ?? "",
					/Experimental \/ decision quality untested/,
				);
				return { ids: [item.id] };
			},
		);
	assert.deepEqual(screens, [
		[1, "Select an Auto approve mode"],
		[2, "Select an Auto approve mode"],
		[3, "Select an Auto approve mode"],
		[3, "Select an Auto approve model"],
	]);
	assert.equal(
		initialized.result?.server_capabilities?.supports_auto_review_configure,
		true,
	);
	assert.equal(
		initialized.result?.tui?.auto_review_confined_launch_enabled,
		false,
	);
	assert.equal(enabled.result?.confined_launch_enabled, true);
	assert.equal(enabled.result?.state, "off");
	assert.equal(following.result?.mode, "follow");
	assert.equal(following.result?.confined_launch_enabled, true);
	assert.equal(following.result?.state, "active");
	assert.equal(following.result?.provider, "google");
	assert.equal(picked.result?.state, "active");
	assert.equal(status.result?.state, "active");
	assert.equal(status.result?.confined_launch_enabled, true);
	assert.equal(status.result?.mode, "pin");
	assert.equal(status.result?.model, "claude-haiku-5-5");
	assert.equal(Object.hasOwn(status.result, "reserved_usd_micros"), false);
	assert.equal(disabled.result?.confined_launch_enabled, false);
	assert.equal(disabled.result?.state, "active");
	assert.equal(disabled.result?.mode, "pin");
	assert.equal(disabled.result?.model, "claude-haiku-5-5");
};
