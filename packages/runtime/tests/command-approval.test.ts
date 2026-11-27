import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import {
	type ApprovalAudit,
	ApprovalDispatcher,
	type Confirmation,
} from "../src/permissions/dispatch";
import { ReviewFailureError } from "../src/permissions/review-failure";
import { type ApprovalFacts, routeApproval } from "../src/permissions/route";
import { runtimeApprovalDispatcher } from "../src/permissions/runtime-approval";
import { analyzeShell } from "../src/permissions/shell-analysis";
import { createShellAuthorizer } from "../src/permissions/shell-approval";
import {
	fixedBash,
	type ProtectedShellBackend,
	type ShellChild,
} from "../src/permissions/shell-backend";
import { createRuntimeToolApproval } from "../src/permissions/tool-approval";
import { createToolContext } from "../src/rpc/tool";
import { RuntimeState } from "../src/runtime-state";

const loop = 'set -e; for f in a.txt b.txt; do wc -l "$f"; done';
const resource = { operation: "read", target: "/test" } as const;
const baseline: ApprovalFacts = {
	valid: true,
	owned: true,
	registered: true,
	enforceable: true,
	profile: "investigation",
	requested: [resource],
	ceiling: [resource],
	granted: [resource],
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((callback) => {
		resolve = callback;
	});
	return { promise, resolve };
}

const makeInvocation = (id: string, subject = "shell") => ({
	id,
	owner: "session",
	origin: "parent_agent" as const,
	subject,
	registration: "builtin/1",
	input: "frozen",
	authorityVersion: "1",
	intentVersion: "run",
	connectionGeneration: "1",
});

describe("approval routing", () => {
	test("denial, ceiling and OS capability precede human, rule and review", () => {
		const facts = {
			...baseline,
			reviewCategory: "local_test",
			launchRule: "saved",
			opaque: true,
		} as const;
		expect(routeApproval({ ...facts, explicitDeny: "deny" }).reason).toBe(
			"deny",
		);
		expect(routeApproval({ ...facts, ceiling: [] }).reason).toBe(
			"outside_authority_ceiling",
		);
		expect(routeApproval({ ...facts, enforceable: false }).reason).toBe(
			"sandbox_unavailable",
		);
		expect(routeApproval({ ...facts, granted: [] }).additional).toEqual([
			resource,
		]);
		expect(routeApproval(facts).kind).toBe("human");
		expect(routeApproval({ ...facts, opaque: false }).kind).toBe("immediate");
		expect(
			routeApproval({ ...facts, opaque: false, launchRule: undefined }).kind,
		).toBe("review");
	});

	test("read and status do not build evidence or enter review", async () => {
		let evidence = 0;
		let reviews = 0;
		let prompts = 0;
		const state = new RuntimeState();
		state.setRuntimeEnvironment({
			adapters: {
				approvalService: {
					confirm: async () => {
						prompts++;
						return null;
					},
				},
				approvalReviewer: {
					categories: ["local_test"],
					buildEvidence: async () => {
						evidence++;
						return "evidence";
					},
					review: async () => {
						reviews++;
						return null;
					},
				},
			},
		});
		const tools = new Set(["read", "task_status"]);
		const authorize = createRuntimeToolApproval({
			state,
			builtinNames: tools,
		});
		const samples: number[] = [];
		for (const name of tools) {
			const wrapped = authorize.wrap(
				defineTool({
					name,
					description: "Local operation fixture",
					input: z.object({}),
					execute: () => "allowed",
				}),
				"builtin",
			);
			for (let count = 0; count < 100; count++) {
				const start = performance.now();
				const result = await wrapped.executeRaw("{}", createToolContext());
				samples.push(performance.now() - start);
				expect(result).toEqual({ type: "text", text: "allowed" });
			}
		}
		expect([evidence, reviews, prompts]).toEqual([0, 0, 0]);
		samples.sort((a, b) => a - b);
		if (process.env.CODELIA_TEST_APPROVAL_MEASURE === "1")
			console.log("approval-only ms", { p50: samples[99], p95: samples[189] });
	});

	test("one review receipt coalesces identical retransmits while an independent read runs", async () => {
		const started = deferred<void>();
		const paused = deferred<unknown>();
		let launches = 0;
		let sent = 0;
		const dispatcher = new ApprovalDispatcher({
			review: {
				categories: ["local_test"],
				buildEvidence: async () => "user initiated a local test",
				review: async () => {
					sent++;
					started.resolve();
					return paused.promise;
				},
			},
		});
		const options = {
			request: makeInvocation("run-once"),
			evaluate: () => ({ ...baseline, reviewCategory: "local_test" as const }),
			stillCurrent: () => true,
			preview: () => {
				throw new Error("no UI");
			},
			deduplicate: true,
			execute: () => ++launches,
		};
		const first = dispatcher.dispatch(options);
		const retransmission = dispatcher.dispatch(options);
		await started.promise;
		expect(
			await dispatcher.dispatch({
				...options,
				request: makeInvocation("read", "read"),
				evaluate: () => ({ ...baseline, launchRule: "builtin" }),
				execute: () => "read complete",
			}),
		).toBe("read complete");
		expect(launches).toBe(0);
		paused.resolve({
			request_id: "run-once",
			decision: "allow_once",
			reason: "fixture",
		});
		expect(await Promise.all([first, retransmission])).toEqual([1, 1]);
		expect([sent, launches]).toEqual([1, 1]);
		await expect(
			dispatcher.dispatch({
				...options,
				request: { ...options.request, input: "different" },
			}),
		).rejects.toThrow("request_binding_mismatch");
	});

	test("a late confirmation cannot launch after the intent changes", async () => {
		const waiting = deferred<Confirmation>();
		const click = deferred<unknown>();
		let current = true;
		let launches = 0;
		const dispatcher = new ApprovalDispatcher({
			confirmation: {
				confirm: async (request) => {
					waiting.resolve(request);
					return click.promise;
				},
			},
		});
		const run = dispatcher.dispatch({
			request: makeInvocation("expired"),
			evaluate: () => baseline,
			stillCurrent: () => current,
			preview: () => "local operation",
			execute: () => ++launches,
		});
		const dialog = await waiting.promise;
		current = false;
		click.resolve({ requestId: dialog.requestId, choice: "allow_once" });
		await expect(run).rejects.toThrow("approval_expired");
		expect(launches).toBe(0);
	});

	test("closing the connection invalidates a pending dispatch before accepting a fresh request", async () => {
		const waiting = deferred<Confirmation>();
		const click = deferred<unknown>();
		const state = new RuntimeState();
		let launches = 0;
		const dispatcher = new ApprovalDispatcher({
			confirmation: {
				confirm: async (request) => {
					waiting.resolve(request);
					return click.promise;
				},
			},
		});
		const options = {
			request: makeInvocation("pending"),
			evaluate: () => baseline,
			stillCurrent: () => true,
			preview: () => "local operation",
			deduplicate: true,
			execute: () => ++launches,
		};
		const old = dispatcher.dispatch({
			...options,
			receiptScope: state.approvalReceiptScope(),
		});
		const dialog = await waiting.promise;
		state.setUiCapabilities({});
		click.resolve({ requestId: dialog.requestId, choice: "allow_once" });

		await expect(old).rejects.toThrow("approval_expired");
		expect(launches).toBe(0);
		expect(
			await dispatcher.dispatch({
				...options,
				receiptScope: state.approvalReceiptScope(),
				evaluate: () => ({ ...baseline, launchRule: "builtin" }),
			}),
		).toBe(1);
	});
});

describe("shell approval", () => {
	test("analyzes the bounded loop, conditionals, pipelines and literal empty arguments", () => {
		expect(
			analyzeShell(fixedBash(loop)).operations.map(({ argv }) => argv),
		).toEqual([
			["set", "-e"],
			["wc", "-l", "a.txt"],
			["wc", "-l", "b.txt"],
		]);
		const branch = analyzeShell(
			fixedBash("if true; then cat 'a b' ''; else cat x | wc -l y; fi"),
		);
		expect(branch.opaque).toBe(false);
		expect(branch.operations.map(({ argv }) => argv)).toEqual([
			["true"],
			["cat", "a b", ""],
			["cat", "x"],
			["wc", "-l", "y"],
		]);
		for (const source of [
			"cat a > b",
			"a=$(echo x)",
			"f() { pwd; }",
			"cat <<EOF\nx\nEOF",
			"while true; do pwd; done",
			'cat ";":x',
			"if true; then pwd",
		]) {
			expect(analyzeShell(fixedBash(source)).opaque).toBe(true);
		}
	});

	test("a finite loop starts its unchanged source once and any recognized deny blocks the whole unit", async () => {
		const cwd = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-approval-")),
		);
		try {
			const launches: string[] = [];
			let prompts = 0;
			const backend: ProtectedShellBackend = {
				supportsReadOnlyPaths: true,
				supportsCommandBinding: true,
				supports: () => true,
				launch: (invocation, protection) => {
					expect(protection.profile).toBe("investigation");
					if (invocation.kind !== "source")
						throw new Error("expected shell source");
					launches.push(invocation.source);
					return {} as ShellChild;
				},
			};
			const authorize = createShellAuthorizer({
				root: cwd,
				backend,
				dispatcher: new ApprovalDispatcher({
					confirmation: {
						confirm: async () => {
							prompts++;
							return null;
						},
					},
				}),
			});
			await authorize(
				{ source: loop, cwd, origin: "parent_agent" },
				(admission) => {
					admission();
					expect(admission).toThrow("approval_already_consumed");
				},
			);
			await expect(
				authorize(
					{
						source: loop,
						cwd,
						origin: "parent_agent",
						deny: [{ tool: "shell", command: "wc -l b.txt" }],
					},
					(admission) => admission(),
				),
			).rejects.toThrow("legacy_deny_rule");
			expect(launches).toEqual([loop]);
			expect(prompts).toBe(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("lack of containment blocks launch before requesting confirmation", async () => {
		let prompts = 0;
		const authorize = createShellAuthorizer({
			root: tmpdir(),
			backend: {
				supports: () => false,
				launch: () => {
					throw new Error("launched");
				},
			},
			dispatcher: new ApprovalDispatcher({
				confirmation: {
					confirm: async () => {
						prompts++;
						return null;
					},
				},
			}),
		});
		await expect(
			authorize(
				{
					source: "do-anything",
					cwd: tmpdir(),
					origin: "parent_agent",
				},
				(admission) => admission(),
			),
		).rejects.toThrow("sandbox_unavailable");
		expect(prompts).toBe(0);
	});

	test("recognized paths are evaluated without running parser input", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "codelia-approval-"));
		try {
			const location = path.join(directory, "observe");
			writeFileSync(location, "unchanged");
			expect(analyzeShell(fixedBash(`echo changed > ${location}`)).opaque).toBe(
				true,
			);
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});
});

test("developer shell requests use a host ceiling and grants independent of requested effects", async () => {
	const root = tmpdir();
	const seen: string[] = [];
	const dispatcher = new ApprovalDispatcher({
		confirmation: {
			confirm: async (request) => {
				seen.push(`human:${request.route.reason}`);
				expect(request.route.additional).toHaveLength(1);
				return { requestId: request.requestId, choice: "allow_once" };
			},
		},
		review: {
			categories: ["local_test"],
			buildEvidence: async () => "Approved local test",
			review: async (packet) => {
				seen.push("review");
				return {
					request_id: JSON.parse(packet).request_id,
					decision: "allow_once",
					reason: "matches intent",
				};
			},
		},
	});
	const invoke = (
		workspaceWrite: "forbid" | "confirm" | "granted",
		source: { source: string } | { argv: string[] },
	) =>
		createShellAuthorizer({
			root,
			dispatcher,
			authority: { investigation: true, workspaceWrite, stdinPipe: "forbid" },
			backend: {
				supportsReadOnlyPaths: true,
				supports: () => true,
				launch: (_, protection) => {
					expect(protection.profile).toBe("development");
					seen.push("launch");
					return {} as ShellChild;
				},
			},
		})({ ...source, origin: "parent_agent", cwd: root }, (admission) =>
			admission(),
		);
	await expect(invoke("forbid", { source: "bun test" })).rejects.toThrow(
		"outside_authority_ceiling",
	);
	expect(seen).toEqual([]);
	await invoke("confirm", { source: "bun test" });
	await invoke("granted", { argv: ["bun", "test"] });
	expect(seen).toEqual([
		"human:additional_resources",
		"launch",
		"review",
		"launch",
	]);
});

test("three reviews enter transport together and a canceled request cannot launch on a late reply", async () => {
	const allSent = deferred<void>();
	const replies = new Map<string, ReturnType<typeof deferred<unknown>>>();
	let launches = 0;
	const dispatcher = new ApprovalDispatcher({
		review: {
			categories: ["local_test"],
			buildEvidence: async () => "Evidence",
			review: async (packet) => {
				const reply = deferred<unknown>();
				replies.set(JSON.parse(packet).request_id, reply);
				if (replies.size === 3) allSent.resolve();
				return reply.promise;
			},
		},
	});
	const dispatch = (id: string, signal?: AbortSignal) =>
		dispatcher.dispatch({
			request: { ...makeInvocation(id), runId: "same-parent-run" },
			signal,
			evaluate: () => ({ ...baseline, reviewCategory: "local_test" }),
			stillCurrent: () => true,
			preview: () => "review evidence",
			execute: () => ++launches,
		});
	const cancellation = new AbortController();
	const canceled = dispatch("one", cancellation.signal).catch((error) => error);
	const second = dispatch("two");
	const third = dispatch("three");
	await allSent.promise;
	cancellation.abort();
	expect(String(await canceled)).toContain("approval_expired");
	expect(launches).toBe(0);
	for (const [id, reply] of replies)
		reply.resolve({
			request_id: id,
			decision: "allow_once",
			reason: "fixture",
		});
	await Promise.all([second, third]);
	expect(launches).toBe(2);
});

test("nine eligible requests in one run can each send a review", async () => {
	let eligibilityChecks = 0;
	let sends = 0;
	const dispatcher = new ApprovalDispatcher({
		review: {
			categories: ["local_test"],
			buildEvidence: async () => "Evidence",
			reserve: () => ++eligibilityChecks > 2,
			review: async (packet) => {
				sends++;
				return {
					request_id: JSON.parse(packet).request_id,
					decision: "allow_once",
					reason: "fixture",
				};
			},
		},
	});
	const dispatch = (id: string) =>
		dispatcher.dispatch({
			request: { ...makeInvocation(id), runId: "same-parent-run" },
			evaluate: () => ({ ...baseline, reviewCategory: "local_test" }),
			stillCurrent: () => true,
			preview: () => "fixture",
			execute: () => "launched",
		});
	await expect(dispatch("ineligible-1")).rejects.toThrow(
		"confirmation_required",
	);
	await expect(dispatch("ineligible-2")).rejects.toThrow(
		"confirmation_required",
	);
	expect(sends).toBe(0);
	for (let count = 1; count <= 9; count++)
		expect(await dispatch(`accepted-${count}`)).toBe("launched");
	expect([eligibilityChecks, sends]).toEqual([11, 9]);
});

test("search pipelines use the investigation rule without approving state-changing builtins", async () => {
	let prompts = 0;
	let launches = 0;
	const authorize = createShellAuthorizer({
		root: tmpdir(),
		backend: {
			supportsReadOnlyPaths: true,
			supportsCommandBinding: true,
			supports: () => true,
			launch: (_, protection) => {
				expect(protection.profile).toBe("investigation");
				launches++;
				return {} as ShellChild;
			},
		},
		dispatcher: new ApprovalDispatcher({
			confirmation: {
				confirm: async () => {
					prompts++;
					return null;
				},
			},
		}),
	});
	await authorize(
		{
			source: "/usr/bin/grep -n needle a.txt | /usr/bin/wc -l a.txt",
			cwd: tmpdir(),
			origin: "parent_agent",
		},
		(admit) => admit(),
	);
	for (const source of [
		"printf %n PATH",
		"printf -v PATH evil",
		"set -o allexport",
		"rg --pre foo needle a.txt",
	]) {
		await expect(
			authorize({ source, cwd: tmpdir(), origin: "parent_agent" }, (admit) =>
				admit(),
			),
		).rejects.toThrow("confirmation_required");
	}
	expect([prompts, launches]).toEqual([4, 1]);
});

test("a narrow SDK ceiling owns file effects and a replacement invalidates the selected inode", async () => {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-bound-file-")),
	);
	try {
		const { renameSync, readFileSync } = await import("node:fs");
		const { SandboxContext, createSandboxKey } = await import(
			"../src/sandbox/context"
		);
		const { createWriteTool } = await import("../src/tools/write");
		const state = new RuntimeState();
		const target = path.join(root, "approved.txt");
		const other = path.join(root, "outside.txt");
		writeFileSync(target, "original");
		writeFileSync(other, "outside");
		let prompts = 0;
		const requested = deferred<Confirmation>();
		const response = deferred<unknown>();
		state.setRuntimeEnvironment({
			adapters: {
				approvalService: {
					confirm: async (confirmation) => {
						prompts++;
						requested.resolve(confirmation);
						return response.promise;
					},
				},
				approvalToolAuthority: () => ({
					ceiling: [
						{ operation: "invoke", target: "write" },
						{ operation: "write", target },
					],
					granted: [{ operation: "invoke", target: "write" }],
				}),
			},
		});
		const sandboxKey = createSandboxKey(
			await SandboxContext.create(root, { protectResources: true }),
		);
		const admission = createRuntimeToolApproval({
			state,
			sandboxKey,
			builtinNames: new Set(["write"]),
		});
		const write = admission.wrap(createWriteTool(sandboxKey), "builtin");
		const call = (file_path: string) =>
			write.executeRaw(
				JSON.stringify({ file_path, content: "modified" }),
				createToolContext(),
			);
		await expect(call(other)).rejects.toThrow("outside_authority_ceiling");
		expect(prompts).toBe(0);
		const pending = call(target);
		const prompt = await requested.promise;
		expect(prompt.route.additional).toEqual([{ operation: "write", target }]);
		const prior = path.join(root, "moved-original.txt");
		renameSync(target, prior);
		writeFileSync(target, "replacement");
		response.resolve({ requestId: prompt.requestId, choice: "allow_once" });
		await expect(pending).rejects.toThrow("approval_expired");
		expect([
			readFileSync(target, "utf8"),
			readFileSync(prior, "utf8"),
			readFileSync(other, "utf8"),
		]).toEqual(["replacement", "original", "outside"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a read-only template cannot authorize a development launch", async () => {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-development-profile-")),
	);
	try {
		let prompts = 0;
		let launches = 0;
		const authorize = createShellAuthorizer({
			root,
			authority: {
				investigation: true,
				workspaceWrite: "granted",
				stdinPipe: "forbid",
			},
			backend: {
				supportsReadOnlyPaths: true,
				supports: () => true,
				launch: () => {
					launches++;
					return {} as ShellChild;
				},
			},
			dispatcher: new ApprovalDispatcher({
				confirmation: {
					confirm: async (prompt) => {
						prompts++;
						expect(prompt.route.profile).toBe("development");
						return null;
					},
				},
			}),
		});
		await expect(
			authorize(
				{
					source: "pwd",
					cwd: root,
					origin: "parent_agent",
					additionalWriteRoots: [root],
				},
				(admit) => admit(),
			),
		).rejects.toThrow("confirmation_required");
		expect([prompts, launches]).toEqual([1, 0]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unsupported shell dialects require one structured decision, or hard deny for an analysis-only host", async () => {
	let prompts = 0;
	const launches: string[] = [];
	const source = "  date\n";
	const invoke = (requireAnalysis: boolean) =>
		createShellAuthorizer({
			root: tmpdir(),
			requireAnalysis,
			resolveSource: (source) => ({
				kind: "source",
				dialect: "unsupported",
				executable: "/bin/sh",
				options: ["-c"],
				source,
			}),
			backend: {
				supportsReadOnlyPaths: true,
				supports: () => true,
				launch: (invocation) => {
					expect(invocation.kind).toBe("source");
					if (invocation.kind === "source") launches.push(invocation.source);
					return {} as ShellChild;
				},
			},
			dispatcher: new ApprovalDispatcher({
				confirmation: {
					confirm: async (request) => {
						prompts++;
						expect(request.preview).toStartWith(source);
						expect(request.choices).toEqual([
							"allow_once",
							"deny_continue",
							"deny_stop",
						]);
						return { requestId: request.requestId, choice: "allow_once" };
					},
				},
			}),
		})({ source, cwd: tmpdir(), origin: "parent_agent" }, (admit) => admit());
	await invoke(false);
	await expect(invoke(true)).rejects.toThrow("analysis_required");
	expect([prompts, launches]).toEqual([1, [source]]);
});

test("public reviewer sends one stateless structured request using the configured API key", async () => {
	const { createPublicApprovalReviewer } = await import(
		"../src/permissions/reviewer-models"
	);
	let sent = 0;
	let usages = 0;
	const request = makeInvocation("ready");
	const adapter = createPublicApprovalReviewer({
		apiKey: "review-fixture",
		buildEvidence: async () => "User explicitly requested the local test.",

		recordUsage: (usage) => {
			usages++;
			expect(usage.inputTokens).toBe(49);
			expect(usage.outputTokens).toBe(17);
		},
		fetcher: (async (url, init) => {
			sent++;
			expect(String(url)).toBe("https://api.openai.com/v1/responses");
			expect(init?.redirect).toBe("error");
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer review-fixture",
			);
			const body = JSON.parse(String(init?.body));
			expect(body).toMatchObject({
				model: "gpt-6-luna",
				store: false,
				stream: false,
				tools: [],
				service_tier: "default",
				reasoning: { effort: "low" },
				text: { format: { type: "json_schema", strict: true } },
			});
			expect(JSON.parse(body.input).request_id).toBe(request.id);
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
									request_id: request.id,
									decision: "allow_once",
									reason: "fixture",
								}),
							},
						],
					},
				],
				usage: { input_tokens: 49, output_tokens: 17 },
			});
		}) as typeof fetch,
	});
	const dispatcher = new ApprovalDispatcher({ review: adapter });
	expect(
		await dispatcher.dispatch({
			request,
			evaluate: () => ({ ...baseline, reviewCategory: "local_test" }),
			stillCurrent: () => true,
			preview: () => "test",
			execute: () => "ok",
		}),
	).toBe("ok");
	expect([sent, usages]).toEqual([1, 1]);
});

test("a tool registered by a host cannot inherit builtin authority from its name", async () => {
	const { Agent, defineTool } = await import("@codelia/core");
	const { z } = await import("zod");
	const { setOperatorContext } = await import(
		"../src/permissions/operator-context"
	);
	const state = new RuntimeState();
	let hits = 0;
	let prompts = 0;
	state.setRuntimeEnvironment({
		adapters: {
			approvalService: {
				confirm: async (request) => {
					prompts++;
					expect(request.route.profile).toBe("host_managed");
					return { requestId: request.requestId, choice: "deny_continue" };
				},
			},
		},
	});
	const policy = createRuntimeToolApproval({
		state,
		builtinNames: new Set(["shell"]),
	});
	const host = policy.wrap(
		defineTool({
			name: "shell",
			description: "Advertised as read-only by an external host",
			input: z.object({ command: z.string() }),
			execute: () => {
				hits++;
				return "executed";
			},
		}),
		"host",
	);
	const call = {
		id: "fake-shell-call",
		type: "function" as const,
		function: { name: "shell", arguments: '{"command":"pwd"}' },
	};
	let modelCalls = 0;
	const agent = new Agent({
		tools: [host],
		llm: {
			provider: "openai",
			model: "gpt-5",
			async ainvoke() {
				return {
					messages: [
						modelCalls++ === 0
							? { role: "assistant", content: "", tool_calls: [call] }
							: { role: "assistant", content: "done" },
					],
				};
			},
		},
	});
	await agent.run("Fixture");
	expect(agent.getHistoryMessages()).toContainEqual(
		expect.objectContaining({
			role: "tool",
			tool_name: "shell",
			is_error: true,
			content: expect.stringContaining("user_denied"),
		}),
	);
	const directContext = createToolContext();
	setOperatorContext(directContext, "fixture-direct");
	await expect(
		host.executeRaw(call.function.arguments, directContext),
	).rejects.toThrow("user_denied");
	expect([hits, prompts]).toEqual([0, 2]);
});

test("queued execution consumes its permit only while the approved generation remains valid", async () => {
	const admitted = deferred<void>();
	const queueReleased = deferred<void>();
	let current = true;
	let effects = 0;
	const dispatcher = new ApprovalDispatcher();
	const pending = dispatcher.dispatch({
		request: makeInvocation("pending-write"),
		evaluate: () => ({ ...baseline, launchRule: "granted" }),
		stillCurrent: () => current,
		preview: () => "write fixture",
		deferConsumption: true,
		execute: async (consume) => {
			admitted.resolve();
			await queueReleased.promise;
			consume();
			return ++effects;
		},
	});
	await admitted.promise;
	current = false;
	queueReleased.resolve();
	await expect(pending).rejects.toThrow("approval_expired");
	expect(effects).toBe(0);
});

test("exact saved rules accept literal arguments only on a capable backend", async () => {
	const { mkdirSync } = await import("node:fs");
	const { LaunchRuleStore } = await import("../src/permissions/launch-rules");
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-template-")),
	);
	try {
		mkdirSync(path.join(root, "tests"));
		writeFileSync(path.join(root, "tests/feature.test.ts"), "");
		const candidates: boolean[] = [];
		const launches: string[] = [];
		const fixture = (enforceBinding: boolean) =>
			createShellAuthorizer({
				root,
				authority: {
					investigation: true,
					workspaceWrite: "granted",
					stdinPipe: "forbid",
				},
				launchRules: new LaunchRuleStore(path.join(root, "rules")),
				backend: {
					supportsReadOnlyPaths: true,
					supports: () => true,
					exactLaunchBindingId: "fixture/1",
					supportsExactLaunchBinding: () => enforceBinding,
					launch: (invocation) => {
						launches.push(invocation.kind);
						return {} as ShellChild;
					},
				},
				dispatcher: new ApprovalDispatcher({
					confirmation: {
						confirm: async (request) => {
							candidates.push(request.choices.includes("save_project"));
							return { requestId: request.requestId, choice: "allow_once" };
						},
					},
				}),
			});
		const input = { cwd: root, origin: "parent_agent" as const };
		await fixture(true)(
			{ ...input, source: "bun test tests/feature.test.ts" },
			(admit) => admit(),
		);
		await fixture(true)(
			{ ...input, source: "bun test ./tests/feature.test.ts" },
			(admit) => admit(),
		);
		await fixture(true)(
			{ ...input, argv: ["bun", "test", "./tests/feature.test.ts"] },
			(admit) => admit(),
		);
		await fixture(false)(
			{ ...input, source: "bun test ./tests/feature.test.ts" },
			(admit) => admit(),
		);
		expect(candidates).toEqual([true, true, true, false]);
		expect(launches).toEqual(["source", "source", "argv", "source"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an acknowledged SDK external update reserves concrete authority and reconciles an unknown result without resending", async () => {
	const { defineTool } = await import("@codelia/core");
	const { z } = await import("zod");
	const { runBrokeredMutation } = await import(
		"../src/permissions/brokered-mutation"
	);
	const destination = "https://example.invalid/test";
	const scope = { operation: "network", target: destination } as const;
	let prompts = 0;
	let sends = 0;
	let reads = 0;
	const state = new RuntimeState();
	state.setRuntimeEnvironment({
		adapters: {
			approvalToolEffect: () => ({
				resources: [scope],
				kind: "external_update",
			}),
			approvalToolAuthority: () => ({
				ceiling: [{ operation: "invoke", target: "update_ref" }, scope],
				granted: [{ operation: "invoke", target: "update_ref" }, scope],
				launchRule: "registered-broker",
			}),
			approvalService: {
				confirm: async (request) => {
					prompts++;
					expect(request.route.reason).toBe("external_mutation");
					return { requestId: request.requestId, choice: "allow_once" };
				},
			},
		},
	});
	const tool = defineTool({
		name: "update_ref",
		description: "Fixture conditional ref update",
		input: z.object({
			value: z.string(),
			expectedValue: z.string().nullable(),
		}),
		execute: ({ value, expectedValue }, ctx) =>
			runBrokeredMutation(
				{
					requestId: "fixture",
					destination,
					operation: "update_ref",
					target: "refs/heads/test",
					value,
					expectedValue,
				},
				{
					update: async (request) => {
						sends++;
						expect(Object.isFrozen(request)).toBe(true);
						expect(request.expectedValue).toBe("before");
						return "unknown";
					},
					observe: async (request) => {
						reads++;
						expect(request).toMatchObject({
							destination,
							target: "refs/heads/test",
							value: "after",
						});
						return "applied";
					},
				},
				ctx.signal,
			),
	});
	const dispatcher = createRuntimeToolApproval({
		state,
		builtinNames: new Set(),
	});
	const effected = dispatcher.wrap(tool, "host");
	expect(
		await effected.executeRaw(
			'{"value":"after","expectedValue":"before"}',
			createToolContext(),
		),
	).toEqual({ type: "text", text: "applied" });
	expect([prompts, sends, reads]).toEqual([1, 1, 1]);
});

test("a rejected local review retains its safe diagnostic across retry suppression", async () => {
	const audit: ApprovalAudit[] = [];
	let sends = 0;
	let launches = 0;
	const dispatcher = new ApprovalDispatcher({
		audit: (entry) => audit.push(entry),
		review: {
			categories: ["local_test"],
			buildEvidence: async () => "private packet fixture",
			review: async () => {
				sends++;
				const error = new ReviewFailureError("review_rate_limited", 429);
				error.message = "private transport fixture";
				throw error;
			},
		},
	});
	const run = (id: string) =>
		dispatcher.dispatch({
			request: { ...makeInvocation(id), runId: "owning-run" },
			evaluate: () => ({
				...baseline,
				reviewCategory: "local_test",
				autoReview: true,
			}),
			stillCurrent: () => true,
			preview: () => "private command fixture",
			execute: () => ++launches,
		});
	for (const id of ["original", "retry"]) {
		const result = await run(id).catch((error: Error) => error.message);
		expect(result).toContain("review_rate_limited");
		expect(result).toContain("HTTP 429");
		expect(result).not.toContain("private");
	}
	expect([sends, launches]).toEqual([1, 0]);
	expect(audit).toHaveLength(2);
	for (const entry of audit) {
		expect(entry).toMatchObject({
			runId: "owning-run",
			state: "denied",
			reason: "review_unavailable",
			reviewDiagnostic: { code: "review_rate_limited", httpStatus: 429 },
		});
	}
	expect(JSON.stringify(audit)).not.toContain("private");
});

test("manual fallback receives one safe diagnostic for an invalid reply", async () => {
	const audit: ApprovalAudit[] = [];
	const dispatcher = new ApprovalDispatcher({
		audit: (entry) => audit.push(entry),
		review: {
			categories: ["local_test"],
			buildEvidence: async () => "intent",
			review: async () => ({
				request_id: "other-request",
				decision: "allow_once",
				reason: "private provider reply",
			}),
		},
		confirmation: {
			confirm: async (request) => {
				expect(request.reviewFallback).toBe("review_unavailable");
				expect(request.reviewDiagnostic).toEqual({
					code: "review_invalid_reply",
				});
				return { requestId: request.requestId, choice: "allow_once" };
			},
		},
	});
	await expect(
		dispatcher.dispatch({
			request: makeInvocation("manual-fallback"),
			evaluate: () => ({ ...baseline, reviewCategory: "local_test" }),
			stillCurrent: () => true,
			preview: () => "manual command",
			execute: () => "launched",
		}),
	).resolves.toBe("launched");
	expect(audit.map(({ state }) => state)).toEqual([
		"review_failed",
		"dispatch",
	]);
	expect(audit[0].reviewDiagnostic).toEqual({ code: "review_invalid_reply" });
	expect(audit[1].reviewDiagnostic).toBeUndefined();
	expect(JSON.stringify(audit)).not.toContain("private provider reply");
});

test("cancelling pending evidence reports cancellation and never sends the packet", async () => {
	const audit: ApprovalAudit[] = [];
	const started = deferred<void>();
	const evidence = deferred<string>();
	const controller = new AbortController();
	let sends = 0;
	const dispatcher = new ApprovalDispatcher({
		audit: (entry) => audit.push(entry),
		review: {
			categories: ["local_test"],
			buildEvidence: () => {
				started.resolve();
				return evidence.promise;
			},
			review: async () => ++sends,
		},
	});
	const run = dispatcher.dispatch({
		request: makeInvocation("cancelled-review"),
		evaluate: () => ({
			...baseline,
			reviewCategory: "local_test",
			autoReview: true,
		}),
		stillCurrent: () => true,
		signal: controller.signal,
		preview: () => "preview",
		execute: () => {
			throw new Error("unexpected launch");
		},
	});
	await started.promise;
	controller.abort(new Error("private cancellation detail"));
	await expect(run).rejects.toThrow("review_cancelled");
	evidence.resolve("late evidence");
	expect(sends).toBe(0);
	expect(audit).toHaveLength(1);
	expect(audit[0]).toMatchObject({
		state: "expired",
		reason: "approval_expired",
		reviewDiagnostic: { code: "review_cancelled" },
	});
	expect(JSON.stringify(audit)).not.toContain("private cancellation detail");
});

test.each([
	["withheld evidence", null, true, "review_evidence_unavailable"],
	["oversized evidence", "x".repeat(8192), true, "review_evidence_too_large"],
	["failed preparation", "intent", false, "review_preparation_failed"],
] as const)(
	"%s reports the local failure before contacting the reviewer",
	async (_scenario, evidence, reserve, code) => {
		const audit: ApprovalAudit[] = [];
		let sends = 0;
		const dispatcher = new ApprovalDispatcher({
			audit: (entry) => audit.push(entry),
			review: {
				categories: ["local_test"],
				buildEvidence: async () => evidence,
				reserve: () => reserve,
				review: async () => ++sends,
			},
		});
		const run = () =>
			dispatcher.dispatch({
				request: makeInvocation("prepare-review"),
				evaluate: () => ({
					...baseline,
					reviewCategory: "local_test",
					autoReview: true,
				}),
				stillCurrent: () => true,
				preview: () => "preview",
				execute: () => {
					throw new Error("unexpected launch");
				},
			});
		const expected = code.startsWith("review_evidence_")
			? new RegExp(`^Permission denied: ${code}: (?!.*review_evidence_)`, "u")
			: code;
		await expect(run()).rejects.toThrow(expected);
		await expect(run()).rejects.toThrow(expected);
		expect(sends).toBe(0);
		expect(audit[0].reviewDiagnostic).toEqual({ code });
		expect(audit.map((entry) => entry.actor)).toEqual(["rule", "rule"]);
	},
);

test.each([true, false])(
	"pre-send privacy failures permit one current launch with confined Auto approve %s",
	async (autoReview) => {
		const prompts: Confirmation[] = [];
		let sends = 0;
		let launches = 0;
		let persisted = 0;
		let current = true;
		let choice: "deny_continue" | "allow_once" | "save_session" =
			"deny_continue";
		const dispatcher = new ApprovalDispatcher({
			review: {
				categories: ["local_test"],
				buildEvidence: async () => "private fixture",
				reserve: () => {
					throw new ReviewFailureError(
						"review_evidence_credential",
						undefined,
						"reviewer_packet",
					);
				},
				review: async () => ++sends,
			},
			confirmation: {
				confirm: async (request) => {
					prompts.push(request);
					if (prompts.length === 4) current = false;
					return { requestId: request.requestId, choice };
				},
			},
		});
		const run = () =>
			dispatcher.dispatch({
				request: makeInvocation("private-review"),
				evaluate: () => ({
					...baseline,
					reviewCategory: "local_test",
					autoReview,
				}),
				stillCurrent: () => current,
				preview: () => "secret command fixture",
				execute: () => ++launches,
				save: {
					description: "secret save description",
					commit: () => {
						persisted++;
					},
				},
				grantSession: {
					description: "secret grant description",
					commit: () => {
						persisted++;
					},
				},
			});
		await expect(run()).rejects.toThrow("user_denied");
		choice = "save_session";
		await expect(run()).rejects.toThrow("confirmation_required");
		choice = "allow_once";
		await expect(run()).resolves.toBe(1);
		await expect(run()).rejects.toThrow("approval_expired");
		expect([sends, launches, persisted]).toEqual([0, 1, 0]);
		expect(prompts).toHaveLength(4);
		for (const prompt of prompts) {
			expect(prompt).toMatchObject({
				choices: ["allow_once", "deny_continue", "deny_stop"],
				reviewWithheldForPrivacy: true,
				reviewDiagnostic: {
					code: "review_evidence_credential",
					location: "reviewer_packet",
				},
			});
			expect(JSON.stringify(prompt)).not.toContain("secret");
		}
	},
);

test("an inconclusive review waits for one user decision under the original profile", async () => {
	const prompts: Confirmation[] = [];
	let available = false;
	let current = true;
	let sends = 0;
	let launches = 0;
	const dispatcher = new ApprovalDispatcher({
		review: {
			categories: ["local_test"],
			buildEvidence: async () => "synthetic test request",
			review: async (_packet, _signal, { id }) => {
				sends++;
				return {
					request_id: id,
					decision: "insufficient_evidence",
					reason: "fixture",
				};
			},
		},
		confirmation: {
			available: () => available,
			confirm: async (request) => {
				prompts.push(request);
				if (prompts.length === 2) current = false;
				return { requestId: request.requestId, choice: "allow_once" };
			},
		},
	});
	const run = () =>
		dispatcher.dispatch({
			request: makeInvocation("local-test"),
			evaluate: () => ({
				...baseline,
				profile: "development",
				reviewCategory: "local_test",
				autoReview: true,
			}),
			stillCurrent: () => current,
			preview: () => "run fixture tests",
			save: {
				description: "save",
				commit: () => {
					throw new Error("unexpected save");
				},
			},
			grantSession: {
				description: "grant",
				commit: () => {
					throw new Error("unexpected session grant");
				},
			},
			execute: () => ++launches,
		});
	await expect(run()).rejects.toThrow(
		"Interactive confirmation is unavailable",
	);
	await expect(run()).rejects.toThrow("review_inconclusive");
	expect([sends, prompts.length, launches]).toEqual([1, 0, 0]);
	available = true;
	await expect(run()).resolves.toBe(1);
	await expect(run()).rejects.toThrow("approval_expired");
	expect([sends, prompts.length, launches]).toEqual([1, 2, 1]);
	for (const prompt of prompts) {
		expect(prompt).toMatchObject({
			reviewFallback: "review_inconclusive",
			route: { profile: "development" },
			preview: "run fixture tests",
			choices: ["allow_once", "deny_continue", "deny_stop"],
		});
		expect(prompt.saveDescription).toBeUndefined();
		expect(prompt.grantDescription).toBeUndefined();
	}
});

test.each(["headless", "after_send"] as const)(
	"a privacy diagnostic cannot authorize a %s launch",
	async (scenario) => {
		const fail = () => {
			throw new ReviewFailureError("review_evidence_sharing_restricted");
		};
		let sends = 0;
		let prompts = 0;
		const dispatcher = new ApprovalDispatcher({
			review: {
				categories: ["local_test"],
				buildEvidence: async () =>
					scenario === "headless" ? fail() : "fixture",
				review: async () => {
					sends++;
					return fail();
				},
			},
			confirmation: {
				available: () => scenario !== "headless",
				confirm: async () => ++prompts,
			},
		});
		await expect(
			dispatcher.dispatch({
				request: makeInvocation("private-no-confirm"),
				evaluate: () => ({
					...baseline,
					reviewCategory: "local_test",
					autoReview: true,
				}),
				stillCurrent: () => true,
				preview: () => "private",
				execute: () => {
					throw new Error("unexpected launch");
				},
			}),
		).rejects.toThrow("review_evidence_sharing_restricted");
		expect([sends, prompts]).toEqual([scenario === "headless" ? 0 : 1, 0]);
	},
);

test.each([
	"allow_once",
	"deny_continue",
	"save_session",
	"save_project",
] as const)(
	"interactive shell after model deny binds %s to the actual human selection",
	async (chosen) => {
		const events: string[] = [];
		const prompts: Confirmation[] = [];
		const setup = chosen.startsWith("save_");
		const dispatcher = new ApprovalDispatcher({
			review: {
				categories: ["local_shell"],
				buildEvidence: async () => "synthetic",
				review: async (_packet, _signal, { id }) => ({
					request_id: id,
					decision: "deny",
					reason: "This changes the test cache.",
				}),
			},
			confirmation: {
				confirm: async (prompt) => {
					events.push(prompt.shellStage ?? "missing");
					prompts.push(prompt);
					return {
						requestId: prompt.requestId,
						choice:
							setup && prompt.shellStage === "initial"
								? "setup_allowance"
								: chosen,
					};
				},
			},
		});
		const run = dispatcher.dispatch({
			request: makeInvocation("shell-approval"),
			preview: () => "example test",
			evaluate: () => ({
				...baseline,
				autoReview: true,
				reviewCategory: "local_shell",
			}),
			stillCurrent: () => true,
			interactiveShell: {
				propose: async () => {
					events.push("propose");
					return {
						description: "example test with any trailing arguments",
						commit: (scope) => events.push(scope),
					};
				},
			},
			deferConsumption: true,
			execute: (consume) => {
				events.push("execute");
				consume();
				events.push("launch");
			},
		});
		if (chosen === "deny_continue")
			await expect(run).rejects.toThrow("user_denied");
		else await run;
		expect(prompts[0]).toMatchObject({
			reviewFallback: "review_denied",
			reviewReason: "This changes the test cache.",
			choices: ["allow_once", "setup_allowance", "deny_continue"],
		});
		expect(prompts[0].saveDescription).toBeUndefined();
		if (setup) {
			expect(prompts[1]).toMatchObject({
				shellStage: "rule",
				saveDescription: "example test with any trailing arguments",
				choices: [
					"allow_once",
					"save_session",
					"save_project",
					"deny_continue",
				],
			});
			expect(prompts[1].requestId).not.toBe(prompts[0].requestId);
			expect(events).toEqual([
				"initial",
				"propose",
				"rule",
				"execute",
				chosen === "save_session" ? "session" : "project",
				"launch",
			]);
		} else
			expect(events).toEqual(
				chosen === "allow_once"
					? ["initial", "execute", "launch"]
					: ["initial"],
			);
	},
);

test.each([
	"invalid",
	"error",
	"stale",
	"first-reply",
	"skip",
	"once",
] as const)(
	"a requested shell suggestion handles %s without writing an unapproved rule",
	async (scenario) => {
		let current = true;
		let launches = 0;
		let commits = 0;
		const prompts: Confirmation[] = [];
		const dispatch = new ApprovalDispatcher({
			confirmation: {
				confirm: async (p) => {
					prompts.push(p);
					return {
						requestId: scenario === "first-reply" ? "first" : p.requestId,
						choice:
							p.shellStage === "initial"
								? "setup_allowance"
								: scenario === "skip"
									? "deny_continue"
									: "allow_once",
					};
				},
			},
		});
		const run = dispatch.dispatch({
			request: makeInvocation("first"),
			evaluate: () => baseline,
			stillCurrent: () => current,
			preview: () => "example test",
			interactiveShell: {
				propose: async () => {
					if (scenario === "invalid") return undefined;
					if (scenario === "error")
						throw new Error("simulated proposal failure");
					if (scenario === "stale") current = false;
					return { description: "runtime rule", commit: () => commits++ };
				},
			},
			execute: () => ++launches,
		});
		if (scenario === "stale")
			await expect(run).rejects.toThrow("approval_expired");
		else if (scenario === "first-reply")
			await expect(run).rejects.toThrow("confirmation_required");
		else if (scenario === "skip")
			await expect(run).rejects.toThrow("user_denied");
		else await run;
		expect(commits).toBe(0);
		expect(launches).toBe(
			["invalid", "error", "once"].includes(scenario) ? 1 : 0,
		);
		if (scenario === "error" || scenario === "invalid") {
			expect(prompts[1]).toMatchObject({
				shellStage: "unavailable",
				choices: ["allow_once", "deny_continue"],
			});
		}
	},
);

test.each([
	"hard-deny",
	"private",
	"compound",
	"headless",
	"automatic",
] as const)(
	"a %s shell decision never opens the future rule workflow",
	async (scenario) => {
		let proposals = 0;
		let reviews = 0;
		let launches = 0;
		const prompts: Confirmation[] = [];
		const dispatcher = new ApprovalDispatcher({
			confirmation: {
				available: () => scenario !== "headless",
				confirm: async (p) => {
					prompts.push(p);
					return { requestId: p.requestId, choice: "allow_once" };
				},
			},
			review: {
				categories: ["local_shell"],
				buildEvidence: async () => {
					if (scenario === "private")
						throw new ReviewFailureError("review_evidence_private_path");
					return "synthetic";
				},
				review: async (_p, _s, { id }) => {
					reviews++;
					return {
						request_id: id,
						decision: scenario === "automatic" ? "allow_once" : "deny",
						reason: "fixture",
					};
				},
			},
		});
		const run = dispatcher.dispatch({
			request: makeInvocation("one"),
			stillCurrent: () => true,
			preview: () => "synthetic shell",
			evaluate: () => ({
				...baseline,
				autoReview: true,
				reviewCategory: scenario === "compound" ? undefined : "local_shell",
				opaque: scenario === "compound",
				explicitDeny: scenario === "hard-deny" ? "policy_deny" : undefined,
			}),
			interactiveShell: {
				propose: async () => {
					proposals++;
					return undefined;
				},
			},
			execute: () => launches++,
		});
		if (scenario === "hard-deny")
			await expect(run).rejects.toThrow("policy_deny");
		else if (scenario === "headless")
			await expect(run).rejects.toThrow("review_denied");
		else await run;
		expect(proposals).toBe(0);
		expect(reviews).toBe(
			scenario === "automatic" || scenario === "headless" ? 1 : 0,
		);
		expect(launches).toBe(
			scenario === "hard-deny" || scenario === "headless" ? 0 : 1,
		);
		if (scenario === "private" || scenario === "compound") {
			expect(prompts).toHaveLength(1);
			expect(prompts[0].choices).toEqual(["allow_once", "deny_continue"]);
		} else expect(prompts).toHaveLength(0);
	},
);

test("structured local UI leads with the command for one run and the rule for future runs", async () => {
	const state = new RuntimeState();
	state.setUiCapabilities({ supports_structured_approval: true });
	state.setRuntimeEnvironment({
		environment: { preset: "tui-local" },
		adapters: {
			approvalReviewer: {
				categories: ["local_shell"],
				buildEvidence: async () => "simulated command",
				review: async (_packet, _signal, { id }) => ({
					request_id: id,
					decision: "insufficient_evidence",
					reason: "The test target is ambiguous.",
				}),
			},
		},
	});
	const prompts: {
		title: string;
		message: string;
		items: { id: string; label: string }[];
	}[] = [];
	const write = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		const response = JSON.parse(String(chunk));
		if (response.method === "ui.pick.request") {
			const p = response.params;
			prompts.push(p);
			const suffix =
				prompts.length === 1 ? "/setup_allowance" : "/save_project";
			const chosen = p.items.find((item: { id: string }) =>
				item.id.endsWith(suffix),
			);
			queueMicrotask(() =>
				state.resolveUiResponse({
					id: response.id,
					jsonrpc: "2.0",
					result: { ids: [chosen.id] },
				}),
			);
		}
		return true;
	}) as typeof process.stdout.write;
	let commits = 0;
	try {
		await runtimeApprovalDispatcher(state).dispatch({
			request: makeInvocation("ui-request"),
			stillCurrent: () => true,
			preview: () => "example test --filter suite",
			evaluate: () => ({
				...baseline,
				reviewCategory: "local_shell",
				autoReview: true,
			}),
			interactiveShell: {
				propose: async () => ({
					description: "example test with any trailing arguments",
					commit: () => commits++,
				}),
			},
			execute: () => undefined,
		});
	} finally {
		process.stdout.write = write;
	}
	expect(commits).toBe(1);
	expect(prompts).toHaveLength(2);
	expect(prompts[0].message).toStartWith(
		"Command: example test --filter suite\n\n",
	);
	expect(prompts[0].message).toContain("The test target is ambiguous.");
	expect(prompts[0].items.map((item) => item.label)).toEqual([
		"Run once",
		"Set up future allowance…",
		"Skip",
	]);
	expect(prompts[1].title).toBe("Save this command allowance?");
	expect(prompts[1].message.split("\n")[0]).toBe(
		"Future allowance: example test with any trailing arguments",
	);
	expect(prompts[1].items.map((item) => item.label)).toEqual([
		"Run once",
		"Save for this session and run",
		"Save for this workspace and run",
		"Skip",
	]);
});
