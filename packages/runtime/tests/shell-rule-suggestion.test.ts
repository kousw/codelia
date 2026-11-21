import { expect, test } from "bun:test";
import {
	link,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Agent } from "@codelia/core";
import { resolveStoragePaths } from "@codelia/storage";
import { AuthStore } from "../src/auth/store";
import { codexReviewEndpoint } from "../src/permissions/codex-reviewer";
import {
	ApprovalDispatcher,
	type ApprovalRequest,
} from "../src/permissions/dispatch";
import { fileIdentity, LaunchRuleStore } from "../src/permissions/launch-rules";
import { LocalAutoReview } from "../src/permissions/local-reviewer";
import { shellPolicyVersion } from "../src/permissions/policy-index";
import { ruleSuggestionInstruction } from "../src/permissions/public-reviewer";
import { localReviewModels } from "../src/permissions/reviewer-models";
import { createShellAuthorizer } from "../src/permissions/shell-approval";
import type { ShellChild } from "../src/permissions/shell-backend";
import { RuntimeState } from "../src/runtime-state";
import { fixtureShellAuthority } from "./fixtures/approval";

const words = ["cargo", "test", "--release"];

test.each([...localReviewModels])(
	"registered $provider rule setup uses the proposal contract on its own transport",
	async (reviewer) => {
		const originalFetch = globalThis.fetch;
		const state = new RuntimeState();
		const call = request(state, "/workspace", "operator");
		const packet = JSON.stringify({ request_id: call.id, argv: words });
		let body: string | undefined;
		try {
			globalThis.fetch = Object.assign(
				async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
					expect(String(url)).toBe(reviewer.endpoint);
					body = String(init?.body);
					return new Response(null, { status: 503 });
				},
				{ preconnect: originalFetch.preconnect },
			) as typeof fetch;
			const adapter = reviewer.createAdapter({
				purpose: "rule_suggestion",
				apiKey: "fixture-key",
				buildEvidence: async () => null,
			});
			await expect(
				adapter.review(packet, new AbortController().signal, call),
			).rejects.toThrow();
			expect(body).toContain(ruleSuggestionInstruction);
			expect(body).toContain("argv_prefix");
			expect(body).not.toContain("approval_decision");
		} finally {
			globalThis.fetch = originalFetch;
		}
	},
);

async function withSuggestionFixture(
	live: boolean,
	run: (state: RuntimeState, root: string) => Promise<void>,
) {
	const initialAuth = live
		? new AuthStore().loadForApproval().providers.openai
		: undefined;
	if (
		live &&
		(initialAuth?.method !== "oauth" ||
			!initialAuth.oauth.access_token ||
			initialAuth.oauth.expires_at <= Date.now())
	)
		throw new Error("Live smoke needs an active Codex OAuth session.");
	const dir = await mkdtemp(path.join(tmpdir(), "codelia-rule-suggestion-"));
	const saved = new Map<string, string | undefined>();
	for (const [k, v] of Object.entries({
		CODELIA_LAYOUT: "xdg",
		XDG_CONFIG_HOME: path.join(dir, "config"),
		XDG_STATE_HOME: path.join(dir, "state"),
		XDG_CACHE_HOME: path.join(dir, "cache"),
		XDG_DATA_HOME: path.join(dir, "data"),
		OPENAI_API_KEY: live ? "" : "fixture-review-key",
		OPENAI_BASE_URL: "https://api.openai.com/v1",
		CODELIA_CONFIG_PATH: path.join(dir, "config.json"),
	})) {
		saved.set(k, process.env[k]);
		process.env[k] = v;
	}
	try {
		const root = path.join(await realpath(dir), "workspace");
		await mkdir(root);
		const state = new RuntimeState();
		const agent = {} as Agent;
		state.recordAgentChatRoute(agent, {
			kind: "builtin",
			provider: "openai",
			apiBase: "https://api.openai.com/v1",
		});
		state.agent = agent;
		state.sessionId = state.nextSessionId();
		state.runtimeSandboxRoot = root;
		await mkdir(resolveStoragePaths().configDir, {
			recursive: true,
			mode: 0o700,
		});
		if (initialAuth?.method === "oauth") {
			await new AuthStore().save({
				version: 1,
				providers: {
					openai: {
						method: "oauth",
						oauth: {
							access_token: initialAuth.oauth.access_token,
							account_id: initialAuth.oauth.account_id,
							expires_at: initialAuth.oauth.expires_at,
							refresh_token: "",
						},
					},
				},
			});
		}
		await run(state, root);
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await rm(dir, { recursive: true, force: true });
	}
}

const request = (
	state: RuntimeState,
	root: string,
	origin: "parent_agent" | "operator",
	argv = words,
): ApprovalRequest => ({
	id: state.nextRunId(),
	owner: state.sessionId ?? "operator",
	origin,
	subject: "shell",
	registration: "builtin.shell/1",
	authorityVersion:
		state.runtimeSandboxRoot === root
			? shellPolicyVersion(state, root)
			: "fixture",
	intentVersion: state.approvalContext(),
	connectionGeneration: "0",
	...(state.activeRunId ? { runId: state.activeRunId } : {}),
	input: JSON.stringify({
		invocation: {
			kind: "source",
			dialect: "bash",
			executable: "/bin/bash",
			options: ["-c"],
			source: argv.join(" "),
		},
		protection: {
			profile: "development",
			root,
			cwd: root,
			stdin: "closed",
			writeRoots: [root],
			protectedPaths: [path.join(root, "private")],
		},
		analysis: { opaque: false, compound: false, operations: [{ argv }] },
	}),
});

test("explicit rule setup uses the actual chat provider with Auto off, sends argv only, and validates proposals", async () => {
	await withSuggestionFixture(false, async (state, root) => {
		const originalFetch = globalThis.fetch;
		let calls = 0;
		let invalid = false;
		const adapter = new LocalAutoReview(state);
		const signal = new AbortController().signal;
		try {
			globalThis.fetch = Object.assign(
				async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
					expect(String(url)).toBe("https://api.openai.com/v1/responses");
					const body = JSON.parse(String(init?.body));
					expect(body.text.format.name).toBe("shell_rule_suggestion");
					const packet = JSON.parse(body.input);
					expect(Object.keys(packet).sort()).toEqual(["argv", "request_id"]);
					expect(packet.argv).toEqual(words);
					calls++;
					return Response.json({
						status: "completed",
						output: [
							{
								type: "message",
								role: "assistant",
								content: [
									{
										type: "output_text",
										text: JSON.stringify({
											request_id: packet.request_id,
											kind: "prefix",
											argv_prefix: invalid
												? ["other", "test"]
												: words.slice(0, 2),
										}),
									},
								],
							},
						],
					});
				},
				{ preconnect: originalFetch.preconnect },
			) as typeof fetch;
			expect(adapter.isEnabled(root)).toBe(false);
			await expect(
				adapter.proposeLaunchRule(
					request(state, root, "operator"),
					words,
					signal,
				),
			).resolves.toEqual({ kind: "prefix", words: ["cargo", "test"] });
			state.beginRun(
				"run",
				null,
				"Run the tests for the private feature.",
				state.agent ?? undefined,
			);
			await expect(
				adapter.proposeLaunchRule(
					request(state, root, "parent_agent"),
					words,
					signal,
				),
			).resolves.toEqual({ kind: "prefix", words: ["cargo", "test"] });
			invalid = true;
			await expect(
				adapter.proposeLaunchRule(
					request(state, root, "parent_agent"),
					words,
					signal,
				),
			).resolves.toBeUndefined();
			const privateWords = ["cargo", "test", "private/fixture.txt"];
			await expect(
				adapter.proposeLaunchRule(
					request(state, root, "parent_agent", privateWords),
					privateWords,
					signal,
				),
			).resolves.toBeUndefined();
			state.finishRun("run");
			state.beginRun(
				"private",
				null,
				"Do not share this command externally.",
				state.agent ?? undefined,
			);
			await expect(
				adapter.proposeLaunchRule(
					request(state, root, "parent_agent"),
					words,
					signal,
				),
			).resolves.toBeUndefined();
			expect(adapter.isEnabled(root)).toBe(false);
			expect(calls).toBe(3);
			state.finishRun("private");
			adapter.configuration(root).select({ mode: "follow" });
			await rm(path.join(resolveStoragePaths().configDir, "auto-review.json"));
			await expect(
				adapter.proposeLaunchRule(
					request(state, root, "operator"),
					words,
					signal,
				),
			).resolves.toBeUndefined();
			expect(calls).toBe(3);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test.skipIf(process.platform === "win32")(
	"a missing model proposal offers an exact bound rule only after the user asks to save",
	() =>
		withSuggestionFixture(false, async (state, root) => {
			const bin = path.join(root, "..", "fallback-bin");
			await mkdir(bin);
			await writeFile(path.join(bin, "fixture-cli"), "fixture executable", {
				mode: 0o700,
			});
			const store = new LaunchRuleStore(
				path.join(root, "..", "fallback-rules"),
			);
			const owner = state.sessionId ?? "operator";
			const handled: string[] = [];
			const authorize = createShellAuthorizer({
				root,
				shellPath: bin,
				authority: fixtureShellAuthority,
				launchRules: store,
				backend: {
					supportsReadOnlyPaths: true,
					supports: () => true,
					exactLaunchBindingId: "fixture/1",
					supportsExactLaunchBinding: () => true,
					launch: () => ({}) as ShellChild,
				},
				proposeLaunchRule: async () => undefined,
				dispatcher: new ApprovalDispatcher({
					confirmation: {
						confirm: async (request) => {
							handled.push(request.shellStage ?? "missing");
							if (request.shellStage === "initial")
								return {
									requestId: request.requestId,
									choice: "setup_allowance",
								};
							expect(request.saveDescription).toContain(
								"Exact command",
							);
							expect(store.list(root, owner)).toHaveLength(0);
							return { requestId: request.requestId, choice: "save_project" };
						},
					},
				}),
			});
			const launch = () =>
				authorize(
					{ cwd: root, origin: "operator", owner, source: "fixture-cli test" },
					(admit) => admit(),
				);
			await launch();
			await launch();
			expect(handled).toEqual(["initial", "rule"]);
			expect(store.list(root, owner)).toMatchObject([
				{ template: "exact-argv/v2", args: ["test"] },
			]);
		}),
);

test.skipIf(process.platform === "win32").each([
	{ kind: "source", program: "bun", shared: false },
	{ kind: "argv", program: "bun", shared: false },
	{ kind: "source", program: "fixture-cli", shared: true },
	{ kind: "argv", program: "fixture-cli", shared: true },
] as const)(
	"$program $kind rule setup validates the invocation, confirms the scope, and reuses the saved rule",
	async ({ kind, program, shared }) => {
		await withSuggestionFixture(false, async (state, root) => {
			const bin = path.join(root, "..", "bin");
			const executable = path.join(bin, program);
			await mkdir(bin);
			await writeFile(executable, "Executable fixture", { mode: 0o700 });
			if (shared) await link(executable, path.join(bin, `${program}-copy`));
			const store = new LaunchRuleStore(path.join(root, "..", "rules"));
			const adapter = new LocalAutoReview(state);
			const argv0 = kind === "source" ? program : executable;
			const originalFetch = globalThis.fetch;
			const order: string[] = [];
			let executableReplaced = false;
			try {
				globalThis.fetch = Object.assign(
					async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
						order.push("proposal");
						const packet = JSON.parse(JSON.parse(String(init?.body)).input);
						expect(packet.argv).toEqual([argv0, "test"]);
						return Response.json({
							status: "completed",
							output: [
								{
									type: "message",
									role: "assistant",
									content: [
										{
											type: "output_text",
											text: JSON.stringify({
												request_id: packet.request_id,
												kind: "prefix",
												argv_prefix: packet.argv,
											}),
										},
									],
								},
							],
						});
					},
					{ preconnect: originalFetch.preconnect },
				) as typeof fetch;
				const authorize = createShellAuthorizer({
					root,
					shellPath: bin,
					authority: fixtureShellAuthority,
					context: () => state.approvalContext(),
					policy: () => ({ version: shellPolicyVersion(state, root) }),
					launchRules: store,
					backend: {
						supportsReadOnlyPaths: true,
						supports: () => true,
						exactLaunchBindingId: "fixture/1",
						supportsExactLaunchBinding: () => true,
						launch: (invocation) => {
							expect(invocation.kind).toBe(kind);
							order.push("launch");
							return {} as ShellChild;
						},
					},
					proposeLaunchRule: async (request, words, signal) => {
						// A different executable spelling cannot be sent as the bound command.
						const wrongArgv0 = kind === "source" ? executable : program;
						await expect(
							adapter.proposeLaunchRule(
								request,
								[wrongArgv0, ...words.slice(1)],
								signal,
							),
						).resolves.toBeUndefined();
						return adapter.proposeLaunchRule(request, words, signal);
					},
					dispatcher: new ApprovalDispatcher({
						confirmation: {
							confirm: async (prompt) => {
								order.push(prompt.shellStage ?? "unexpected");
								if (executableReplaced)
									return { requestId: prompt.requestId, choice: "allow_once" };
								if (prompt.shellStage === "initial") {
									expect(prompt.choices).toContain("setup_allowance");
									return {
										requestId: prompt.requestId,
										choice: "setup_allowance",
									};
								}
								expect(prompt.saveDescription).toContain(
									`${JSON.stringify([argv0, "test"])} with any trailing arguments`,
								);
								expect(prompt.saveDescription).toContain(
									JSON.stringify(executable),
								);
								expect(store.list(root, state.sessionId ?? "operator")).toEqual(
									[],
								);
								return { requestId: prompt.requestId, choice: "save_project" };
							},
						},
					}),
				});
				const run = (
					trailing: string[] = [],
					beforeLaunch: () => Promise<void> = async () => {},
				) =>
					authorize(
						{
							owner: state.sessionId ?? "operator",
							cwd: root,
							origin: "operator",
							...(kind === "source"
								? { source: [program, "test", ...trailing].join(" ") }
								: { argv: [program, "test", ...trailing] }),
						},
						async (admit) => {
							await beforeLaunch();
							return admit();
						},
					);
				await run();
				expect(store.list(root, state.sessionId ?? "operator")).toMatchObject([
					{
						template: "argv-prefix/v1",
						launchKind: kind,
						argv0,
						executable,
						executableIdentity: fileIdentity(executable),
						args: ["test"],
					},
				]);
				await run(["--timeout", "1000"]);
				expect(order).toEqual([
					"initial",
					"proposal",
					"rule",
					"launch",
					"launch",
				]);

				if (shared) {
					const outsideAlias = path.join(root, program);
					await expect(
						run([], () => link(executable, outsideAlias)),
					).rejects.toThrow("approval_expired");
					expect(order).toHaveLength(5);
					await rm(outsideAlias);
				}
				executableReplaced = true;
				await writeFile(executable, "Replacement executable fixture");
				await run();
				expect(order.slice(5)).toEqual(["initial", "launch"]);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	},
);

// Only argv and an opaque request ID go on the wire. The expectations stay local.
const liveSuggestionCases = [
	{
		label: "cargo filter",
		argv: ["cargo", "test", "-p", "parser"],
		prefix: ["cargo", "test"],
	},
	{
		label: "named script",
		argv: ["npm", "run", "build", "--", "--watch"],
		prefix: ["npm", "run", "build"],
	},
	{
		label: "unrepresentable script name",
		argv: ["npm", "run", "build:docs"],
		prefix: null,
	},
	{ label: "inline interpreter", argv: ["python", "-c", "pass"], prefix: null },
	{
		label: "unfamiliar task selector",
		argv: ["fixture-cli", "run", "compile", "--verbose"],
		prefix: ["fixture-cli", "run", "compile"],
		allowExact: true,
	},
];

test
	.skipIf(
		process.env.INTEGRATION !== "1" ||
			process.env.CODELIA_RULE_SUGGESTION_CODEX_LIVE !== "1",
	)
	.each(liveSuggestionCases)(
	"live Codex OAuth keeps the operation boundary for $label",
	async ({ argv, prefix, allowExact }) => {
		await withSuggestionFixture(true, async (state, root) => {
			const originalFetch = globalThis.fetch;
			const call = request(state, root, "operator", argv);
			let sends = 0;
			try {
				globalThis.fetch = Object.assign(
					async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
						const body = JSON.parse(String(init?.body));
						if (
							String(url) !== codexReviewEndpoint ||
							body.text?.format?.name !== "shell_rule_suggestion" ||
							body.model !== "gpt-6-luna" ||
							++sends !== 1
						)
							throw new Error("Unexpected live request");
						expect(JSON.parse(body.input[0].content[0].text)).toEqual({
							request_id: call.id,
							argv,
						});
						return originalFetch(url, init);
					},
					{ preconnect: originalFetch.preconnect },
				) as typeof fetch;
				const suggestion = await new LocalAutoReview(state).proposeLaunchRule(
					call,
					argv,
					new AbortController().signal,
				);
				expect(sends).toBe(1);
				if (prefix === null || (allowExact && suggestion?.kind === "exact")) {
					expect(suggestion).toEqual({ kind: "exact" });
				} else {
					expect(suggestion).toEqual({ kind: "prefix", words: prefix });
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	},
	120_000,
);
