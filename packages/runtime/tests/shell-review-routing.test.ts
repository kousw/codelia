import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ApprovalDispatcher,
	type ApprovalRequest,
	type Confirmation,
	type ReviewAdapter,
} from "../src/permissions/dispatch";
import {
	buildLocalShellEvidence,
	requestedReviewHistory,
} from "../src/permissions/review-evidence";
import { analyzeShell } from "../src/permissions/shell-analysis";
import { createShellAuthorizer } from "../src/permissions/shell-approval";
import { fixedBash, type ShellChild } from "../src/permissions/shell-backend";

test("confined Auto approve explains why a shell invocation is outside review coverage", async () => {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-review-coverage-")),
	);
	const buildEvidence = async () => {
		throw new Error("Unexpected evidence preparation");
	};
	const authorize = createShellAuthorizer({
		root,
		sandboxMode: "workspace-write",
		authority: {
			investigation: true,
			workspaceWrite: "granted",
			stdinPipe: "granted",
		},
		autoReviewEnabled: () => true,
		resolveSource: fixedBash,
		backend: {
			supportsReadOnlyPaths: true,
			supports: () => true,
			launch: () => {
				throw new Error("Unexpected launch");
			},
		},
		dispatcher: new ApprovalDispatcher({
			review: {
				categories: ["local_shell"],
				buildEvidence,
				review: buildEvidence,
			},
		}),
	});
	try {
		for (const [input, code] of [
			[{ stdin: "pipe" }, "review_evidence_interactive_stdin"],
			[{ additionalWriteRoots: [root] }, "review_evidence_extra_write"],
		] as const) {
			await expect(
				authorize(
					{ cwd: root, source: "cargo test", origin: "parent_agent", ...input },
					(admit) => admit(),
				),
			).rejects.toThrow(new RegExp(`^Permission denied: ${code}:`, "u"));
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed reviewer can recover after the retry cooldown without prompting", async () => {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-review-retry-")),
	);
	let now = 0;
	let sends = 0;
	let prompts = 0;
	const dispatcher = new ApprovalDispatcher({
		monotonicNow: () => now,
		review: {
			categories: ["local_shell"],
			buildEvidence: async () => ({ fixture: true }),
			review: async (_packet, _signal, request) => {
				if (++sends === 1) throw new Error("temporary fixture outage");
				return {
					request_id: request.id,
					decision: "allow_once",
					reason: "Fixture inspection.",
				};
			},
		},
		confirmation: {
			confirm: async ({ requestId }) => {
				prompts++;
				return { requestId, choice: "deny_continue" };
			},
		},
	});
	const authorize = createShellAuthorizer({
		root,
		sandboxMode: "workspace-write",
		authority: {
			investigation: true,
			workspaceWrite: "granted",
			stdinPipe: "forbid",
		},
		autoReviewEnabled: () => true,
		resolveSource: fixedBash,
		backend: {
			supportsReadOnlyPaths: true,
			supports: () => true,
			launch: () => ({}) as ShellChild,
		},
		dispatcher,
	});
	const run = () =>
		authorize(
			{ cwd: root, source: "cargo test", origin: "parent_agent" },
			(admit) => {
				admit();
				return "admitted";
			},
		);
	try {
		await expect(run()).rejects.toThrow("review_unavailable");
		await expect(run()).rejects.toThrow("review_unavailable");
		expect([sends, prompts]).toEqual([1, 0]);
		now += 15_000;
		await expect(run()).resolves.toBe("admitted");
		expect([sends, prompts]).toEqual([2, 0]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ordinary finite loop bindings are equivalent and shell-controlled bindings stay opaque", () => {
	for (const name of ["f", "sourceFile", "test_case2", "target"]) {
		const result = analyzeShell(
			fixedBash(`for ${name} in a b; do wc -l "$${name}"; done`),
		);
		expect(result.opaque).toBe(false);
		expect(result.operations.map((op) => op.argv)).toEqual([
			["wc", "-l", "a"],
			["wc", "-l", "b"],
		]);
	}
	expect(
		analyzeShell(fixedBash("for target in a b; do wc -l $target; done")).opaque,
	).toBe(false);
	expect(
		analyzeShell(fixedBash("for target in 'a b'; do wc -l $target; done"))
			.opaque,
	).toBe(true);
	for (const name of ["PATH", "histchars", "BASH_ENV"]) {
		expect(
			analyzeShell(fixedBash(`for ${name} in a; do pwd; done`)).opaque,
		).toBe(true);
	}
});

test("confined auto approve reviews partial source only when shell deny rules can be enforced", async () => {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-review-partial-")),
	);
	const sends: string[] = [];
	const launches: string[] = [];
	const prompts: string[] = [];
	const dispatcher = new ApprovalDispatcher({
		review: {
			categories: ["local_shell"],
			buildEvidence: async (request) =>
				buildLocalShellEvidence(request, root, {
					original: "List the fixture files.",
					corrections: [],
				}),
			review: async (packet, _, request) => {
				const { evidence } = JSON.parse(packet);
				expect(evidence.operation.coverage).toBe("partial");
				sends.push(evidence.operation.profile);
				return {
					request_id: request.id,
					decision: "allow_once",
					reason: "Fixture inspection.",
				};
			},
		},
		confirmation: {
			confirm: async (request) => {
				prompts.push(request.route.profile);
				return { requestId: request.requestId, choice: "deny_continue" };
			},
		},
	});
	const authorize = (
		sandboxMode: "readonly" | "workspace-write" | "full-access",
	) =>
		createShellAuthorizer({
			root,
			sandboxMode,
			authority: {
				investigation: true,
				workspaceWrite: "granted",
				stdinPipe: "forbid",
			},
			autoReviewEnabled: () => true,
			resolveSource: fixedBash,
			backend: {
				supportsReadOnlyPaths: true,
				supports: () => true,
				launch: (invocation) => {
					if (invocation.kind === "source") launches.push(invocation.source);
					return {} as ShellChild;
				},
			},
			dispatcher,
		});
	const source = "printf '%s\\n' *.txt";
	const origin = "parent_agent" as const;
	try {
		for (const mode of ["readonly", "workspace-write"] as const) {
			const run = authorize(mode);
			await run({ source, cwd: root, origin }, (admit) => admit());
			const deny = [{ tool: "shell", command: "fixture-blocked" }];
			for (const [command, reason] of [
				[source, "deny_rule_unverifiable"],
				["fixture-tool clean; bash -c 'pwd'", "deny_rule_unverifiable"],
				["pwd; fixture-blocked", "legacy_deny_rule"],
			]) {
				await expect(
					run({ source: command, cwd: root, origin, deny }, (admit) => admit()),
				).rejects.toThrow(reason);
			}
		}
		await authorize("readonly")(
			{
				source,
				cwd: root,
				origin,
				deny: [
					{
						tool: "shell",
						command: "fixture-blocked",
						skill_name: "fixture-only",
					},
				],
			},
			(admit) => admit(),
		);
		await expect(
			authorize("full-access")({ source, cwd: root, origin }, (admit) =>
				admit(),
			),
		).rejects.toThrow("user_denied");
		expect(launches).toEqual([source, source, source]);
		expect(sends).toEqual(["investigation", "development", "investigation"]);
		expect(prompts).toEqual(["full-access"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("confined review binds historical consent only to a directory shared by all guarded stages", async () => {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-review-cwd-")),
	);
	const pkg = path.join(root, "pkg");
	mkdirSync(pkg);
	const intent = { original: "Inspect the fixture.", corrections: [] };
	const inputs = new Map<string, ApprovalRequest>();
	const authorize = createShellAuthorizer({
		root,
		sandboxMode: "workspace-write",
		authority: {
			investigation: true,
			workspaceWrite: "granted",
			stdinPipe: "forbid",
		},
		autoReviewEnabled: () => true,
		resolveSource: fixedBash,
		backend: {
			supportsReadOnlyPaths: true,
			supports: () => true,
			launch: () => ({}) as ShellChild,
		},
		dispatcher: new ApprovalDispatcher({
			review: {
				categories: ["local_shell"],
				buildEvidence: async (request) => {
					inputs.set(JSON.parse(request.input).invocation.source, request);
					return buildLocalShellEvidence(request, root, intent);
				},
				review: async (_packet, _signal, request) => ({
					request_id: request.id,
					decision: "allow_once",
					reason: "Fixture inspection.",
				}),
			},
		}),
	});
	try {
		for (const [source, bound] of [
			["cd pkg && cargo test && pwd", true],
			["cd pkg && cargo test || pwd", false],
			["cd pkg && cargo test; pwd", false],
			["cd pkg | pwd", false],
			["cd pkg && pushd .. && pwd", false],
		] as const) {
			await authorize({ cwd: root, source, origin: "parent_agent" }, (admit) =>
				admit(),
			);
			const request = inputs.get(source);
			if (!request) throw new Error("Expected shell review");
			const evidence = buildLocalShellEvidence(request, root, intent);
			expect(evidence?.operation.cwd).toBe(".");
			expect(evidence?.operation.reviewedDirectory).toBe(
				bound ? "pkg" : undefined,
			);
			const referenced = {
				...request,
				input: JSON.stringify({
					...JSON.parse(request.input),
					reviewHistory: { user_message_id: "m1" },
				}),
			};
			if (bound) {
				expect(requestedReviewHistory(referenced)?.cwd).toBe(pkg);
			} else {
				expect(evidence?.operation.limitation).toBe(
					"unbound_working_directory",
				);
				expect(() => requestedReviewHistory(referenced)).toThrow(
					"review_evidence_history_unavailable",
				);
			}
		}
		// An ordinary glob has uncertain arguments but the same launch cwd.
		// A later branch after that glob can change directory.
		for (const source of [
			"printf '%s' ./*.json",
			"printf '%s' ./*.json || cd pkg",
		]) {
			await authorize({ cwd: root, source, origin: "parent_agent" }, (admit) =>
				admit(),
			);
			const request = inputs.get(source);
			if (!request) throw new Error("Expected shell review");
			const referenced = {
				...request,
				input: JSON.stringify({
					...JSON.parse(request.input),
					reviewHistory: { user_message_id: "m1" },
				}),
			};
			if (source.includes("||")) {
				expect(() => requestedReviewHistory(referenced)).toThrow(
					"review_evidence_history_unavailable",
				);
			} else {
				expect(requestedReviewHistory(referenced)?.cwd).toBe(root);
			}
		}
		const source = "cd pkg && cat private-file || pwd";
		await authorize({ cwd: root, source, origin: "parent_agent" }, (admit) =>
			admit(),
		);
		const request = inputs.get(source);
		if (!request) throw new Error("Expected shell review");
		const privateRequest = {
			...request,
			input: JSON.stringify({
				...JSON.parse(request.input),
				reviewPrivatePaths: [path.join(pkg, "private-file")],
			}),
		};
		expect(buildLocalShellEvidence(privateRequest, root, intent)).toBeNull();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a complete program is reviewed once under its actual profile and a human-only operation never sends evidence", async () => {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-shell-review-")),
	);
	const pkg = path.join(root, "pkg");
	mkdirSync(pkg);
	const reviewed: string[] = [];
	const decisions: Confirmation[] = [];
	const launches: string[] = [];
	const adapter = (categories: ReviewAdapter["categories"]): ReviewAdapter => ({
		categories,
		buildEvidence: async (request) => {
			const { invocation, protection, reviewedDirectory } = JSON.parse(
				request.input,
			);
			if (invocation.source.startsWith("git ")) {
				expect(
					buildLocalShellEvidence(request, root, {
						original: "Inspect the current changes and plans.",
						corrections: [],
					}),
				).not.toBeNull();
			}
			reviewed.push(
				[
					invocation.source,
					protection.profile,
					path.relative(root, reviewedDirectory ?? protection.cwd),
				].join("|"),
			);
			return "Review the complete local operation.";
		},
		review: async (packet, _, request) => {
			const { category } = JSON.parse(packet);
			expect(categories).toContain(category);
			return {
				request_id: request.id,
				decision: "allow_once",
				reason: "Within the delegated scope.",
			};
		},
	});
	const authorize = (
		categories: ReviewAdapter["categories"],
		sandboxMode:
			| "workspace-write"
			| "readonly"
			| "full-access" = "workspace-write",
	) =>
		createShellAuthorizer({
			root,
			sandboxMode,
			shellPath: "/usr/bin:/bin",
			...(sandboxMode === "full-access"
				? {
						autoReviewEnabled: () => {
							throw new Error(
								"Confined Auto approve cannot control full-access",
							);
						},
					}
				: {}),
			resolveSource: fixedBash,
			authority: {
				investigation: true,
				workspaceWrite: "granted",
				stdinPipe: "forbid",
			},
			backend: {
				supportsReadOnlyPaths: true,
				supportsCommandBinding: true,
				supports: () => true,
				launch: (invocation) => {
					if (invocation.kind === "source") launches.push(invocation.source);
					return {} as ShellChild;
				},
			},
			dispatcher: new ApprovalDispatcher({
				review: adapter(categories),
				confirmation: {
					confirm: async (request) => {
						decisions.push(request);
						return { requestId: request.requestId, choice: "deny_continue" };
					},
				},
			}),
		});
	const call = (
		source: string,
		cwd = root,
		gate = authorize(["local_shell"]),
	) => gate({ cwd, source, origin: "parent_agent" }, (admit) => admit());
	try {
		for (const [command, cwd, effective] of [
			["bun test ./tests/parser.test.ts", root, ""],
			["cargo test -p parser", pkg, "pkg"],
			["npm run build", root, ""],
			["./ci/project-check", root, ""],
			["cd pkg && cargo test", root, "pkg"],
			['for suite in one two; do cargo test "$suite"; done', root, ""],
		] as const) {
			await call(command, cwd);
			expect(reviewed.at(-1)).toBe(
				[command, "development", effective].join("|"),
			);
			expect(launches.at(-1)).toBe(command);
		}
		expect(decisions).toHaveLength(0);
		expect(launches).toHaveLength(6);
		await call(
			"project-inspector --version",
			root,
			authorize(["local_shell"], "readonly"),
		);
		expect(reviewed.at(-1)).toBe("project-inspector --version|investigation|");
		await call("uname -s", root, authorize(["local_shell"], "full-access"));
		expect(reviewed.at(-1)).toBe("uname -s|full-access|");
		for (const [command, reason] of [
			["git push", "external_mutation"],
			["cargo clean", "destructive"],
			["cd .. && cargo test", "unbound_working_directory"],
			["bash -c 'pwd'", "indirect_execution"],
			["echo ok > output", "opaque_invocation"],
		]) {
			await expect(call(command)).rejects.toThrow("user_denied");
			expect(decisions.at(-1)?.route.reason).toBe(reason);
		}
		await expect(
			call(
				"./ci/project-check",
				root,
				authorize(["local_shell"], "full-access"),
			),
		).rejects.toThrow("user_denied");
		expect(decisions.at(-1)?.route.reason).toBe("unrestricted_program");
		await expect(
			call("cargo test", root, authorize(["local_test"])),
		).rejects.toThrow("user_denied");
		expect(decisions.at(-1)?.reviewFallback).toBe("review_not_delegated");
		expect(launches).toHaveLength(8);
		expect(reviewed).toHaveLength(8);

		for (const command of [
			"git status --short --branch; printf '\\n--- recent ---\\n'; git log -7 --date=short --format='%h %ad %d %s'; git worktree list; ls -1t plan | head -18",
			`git diff --cached --shortstat; git diff --shortstat; for f in plan/{approval,runtime,git}.md; do printf '\\n--- %s ---\\n' "$f"; grep -nE '^#{1,4} |Windows' "$f" | tail -33; done`,
			"sed -n '1,105p' docs/spec.md; tail -43 plan/approval.md; git diff --cached --check",
		]) {
			await call(command);
			expect(reviewed.at(-1)).toBe(`${command}|investigation|`);
			expect(launches.at(-1)).toBe(command);
		}
		await call("sed -n '1,105p' docs/spec.md; tail -43 plan/approval.md");
		expect(reviewed).toHaveLength(11);
		expect(launches).toHaveLength(12);
		expect(decisions).toHaveLength(7);
		for (const [command, reason] of [
			['git log --format="$FORMAT"', "opaque_invocation"],
			['for f in plan/{a,$b}.md; do wc -l "$f"; done', "opaque_invocation"],
			["sed -n '1w output' docs/spec.md", "indirect_execution"],
			["git worktree prune", "destructive"],
		]) {
			await expect(call(command)).rejects.toThrow("user_denied");
			expect(decisions.at(-1)?.route.reason).toBe(reason);
		}
		expect(reviewed).toHaveLength(11);
		expect(launches).toHaveLength(12);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
