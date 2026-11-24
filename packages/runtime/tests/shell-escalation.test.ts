import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PermissionRule } from "@codelia/config";
import { resolveRuntimeEnvironment } from "../src/environment";
import {
	type ApprovalChoice,
	ApprovalDispatcher,
	type Confirmation,
} from "../src/permissions/dispatch";
import { LaunchRuleStore } from "../src/permissions/launch-rules";
import { buildLocalShellEvidence } from "../src/permissions/review-evidence";
import {
	authorizeRuntimeShell,
	supportsRuntimeShellEscalation,
} from "../src/permissions/runtime-approval";
import {
	createShellAuthorizer,
	type ShellApprovalInput,
	type ShellAuthority,
} from "../src/permissions/shell-approval";
import {
	fixedBash,
	type ProtectedShellBackend,
	type ShellChild,
	type ShellProtection,
} from "../src/permissions/shell-backend";
import { RuntimeState } from "../src/runtime-state";
import {
	fixtureShellAuthority,
	fixtureShellBackend,
} from "./fixtures/approval";

type Decision = "allow_once" | "deny";

const recordingBackend = (name: string, launches: string[]) =>
	({
		supportsReadOnlyPaths: true,
		supportsCommandBinding: true,
		supports: () => true,
		launch: (_invocation, protection: ShellProtection) => {
			launches.push(`${name}:${protection.profile}`);
			return {} as ShellChild;
		},
	}) satisfies ProtectedShellBackend;

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "codelia-escalation-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const setup = ({
	sandboxMode = "workspace-write",
	autoReview = false,
	decision = "allow_once",
	userChoice = "allow_once",
	confirmation = true,
	escalationBackend = true,
	workspaceWrite,
	deny,
	extraProtectedPaths,
}: {
	sandboxMode?: "readonly" | "workspace-write" | "full-access";
	autoReview?: boolean;
	decision?: Decision;
	userChoice?: ApprovalChoice;
	confirmation?: boolean;
	escalationBackend?: boolean;
	workspaceWrite?: ShellAuthority["workspaceWrite"];
	deny?: readonly PermissionRule[];
	extraProtectedPaths?: readonly string[];
} = {}) => {
	const launches: string[] = [];
	const reviews: Record<string, unknown>[] = [];
	const prompts: Confirmation[] = [];
	const dispatcher = new ApprovalDispatcher({
		review: {
			categories: ["local_shell"],
			buildEvidence: async (request) =>
				buildLocalShellEvidence(request, root, {
					original: "Read the failed CI log with gh.",
					corrections: [],
				}),
			review: async (packet, _signal, request) => {
				reviews.push(JSON.parse(packet).evidence.operation);
				return { request_id: request.id, decision, reason: "Fixture." };
			},
		},
		...(confirmation
			? {
					confirmation: {
						confirm: async (request: Confirmation) => {
							prompts.push(request);
							return { requestId: request.requestId, choice: userChoice };
						},
					},
				}
			: {}),
	});
	const authorize = createShellAuthorizer({
		root,
		sandboxMode,
		authority: {
			investigation: true,
			workspaceWrite:
				workspaceWrite ?? (sandboxMode === "readonly" ? "forbid" : "granted"),
			stdinPipe: "granted",
		},
		policy: () => ({ ...(deny ? { deny } : {}) }),
		...(extraProtectedPaths ? { extraProtectedPaths } : {}),
		autoReviewEnabled: autoReview ? () => true : undefined,
		resolveSource: fixedBash,
		backend: recordingBackend("confined", launches),
		...(escalationBackend
			? { escalationBackend: recordingBackend("user", launches) }
			: {}),
		dispatcher,
	});
	const run = (overrides: Partial<ShellApprovalInput> = {}) =>
		authorize(
			{
				cwd: root,
				source: "gh run view 1 --log-failed",
				origin: "parent_agent",
				escalation: "unsandboxed",
				...overrides,
			} as ShellApprovalInput,
			(admit) => {
				admit();
				return "admitted";
			},
		);
	return { run, launches, reviews, prompts };
};

describe("one-command unsandboxed escalation", () => {
	test("always asks a person even with Auto approve active and restores confinement next", async () => {
		const { run, launches, reviews, prompts } = setup({ autoReview: true });
		await expect(run()).resolves.toBe("admitted");
		expect(reviews).toHaveLength(0);
		expect(prompts).toHaveLength(1);
		expect(prompts[0].route.kind).toBe("human");
		expect(prompts[0].choices).toEqual(["allow_once", "deny_continue"]);
		expect(prompts[0].route.additional).toEqual([
			{ operation: "invoke", target: "shell.unsandboxed" },
		]);
		expect(launches).toEqual(["user:full-access"]);

		await expect(run({ source: "ls", escalation: undefined })).resolves.toBe(
			"admitted",
		);
		expect(launches).toEqual(["user:full-access", "confined:investigation"]);
	});

	test("without Auto approve a person decides, and declining keeps it unstarted", async () => {
		const { run, launches, reviews, prompts } = setup({
			userChoice: "deny_continue",
		});
		await expect(run()).rejects.toThrow();
		expect(reviews).toHaveLength(0);
		expect(prompts).toHaveLength(1);
		expect(prompts[0].route.kind).toBe("human");
		expect(launches).toEqual([]);
	});

	test("readonly sessions always ask a person, even with Auto approve", async () => {
		const { run, reviews, prompts, launches } = setup({
			sandboxMode: "readonly",
			autoReview: true,
		});
		await expect(run()).resolves.toBe("admitted");
		expect(reviews).toHaveLength(0);
		expect(prompts).toHaveLength(1);
		expect(launches).toEqual(["user:full-access"]);
	});

	test("respects workspaceWrite forbid/confirm authority in workspace-write mode", async () => {
		const forbidden = setup({
			sandboxMode: "workspace-write",
			workspaceWrite: "forbid",
			autoReview: true,
		});
		await expect(forbidden.run()).rejects.toThrow("outside_authority_ceiling");
		expect(forbidden.reviews).toHaveLength(0);
		expect(forbidden.prompts).toHaveLength(0);
		expect(forbidden.launches).toEqual([]);

		const confirm = setup({
			sandboxMode: "workspace-write",
			workspaceWrite: "confirm",
			autoReview: true,
		});
		await expect(confirm.run()).resolves.toBe("admitted");
		expect(confirm.reviews).toHaveLength(0);
		expect(confirm.prompts).toHaveLength(1);
		expect(confirm.prompts[0].route.kind).toBe("human");
		expect(confirm.launches).toEqual(["user:full-access"]);
	});

	test("explicit deny rules block escalation for parsed and opaque commands", async () => {
		const parsed = setup({
			autoReview: true,
			deny: [{ tool: "shell", command: "gh" }],
		});
		await expect(parsed.run()).rejects.toThrow("legacy_deny_rule");
		expect(parsed.reviews).toHaveLength(0);
		expect(parsed.prompts).toHaveLength(0);
		expect(parsed.launches).toEqual([]);

		const opaque = setup({
			autoReview: true,
			deny: [{ tool: "shell", command: "rm" }],
		});
		await expect(
			opaque.run({ source: "cat <<EOF\nhello\nEOF" }),
		).rejects.toThrow("deny_rule_unverifiable");
		expect(opaque.reviews).toHaveLength(0);
		expect(opaque.prompts).toHaveLength(0);
		expect(opaque.launches).toEqual([]);
	});

	test("warns in the confirmation preview when configured protected paths are present", async () => {
		const secret = path.join(root, "secret.txt");
		writeFileSync(secret, "top-secret");
		const { run, prompts } = setup({
			extraProtectedPaths: [secret],
		});
		await expect(run()).resolves.toBe("admitted");
		expect(prompts).toHaveLength(1);
		expect(prompts[0].preview).toContain(
			"Configured protected paths are not enforced for this unsandboxed command.",
		);
	});

	test("runtime-approval disables escalation for operator protected paths, custom shell backends, services, and non-tui-local presets", async () => {
		const secret = path.join(root, "operator-secret");
		mkdirSync(secret);
		const localEnv = resolveRuntimeEnvironment({
			environment: { preset: "tui-local" },
		});
		expect(supportsRuntimeShellEscalation(localEnv, false, [])).toBe(true);
		expect(supportsRuntimeShellEscalation(localEnv, true, [])).toBe(false);
		expect(supportsRuntimeShellEscalation(localEnv, false, [secret])).toBe(
			false,
		);
		expect(
			supportsRuntimeShellEscalation(
				{ ...localEnv, sourcePreset: undefined },
				false,
				[],
			),
		).toBe(false);

		const customBackendEnv = resolveRuntimeEnvironment({
			environment: { preset: "tui-local" },
			adapters: { shellProtectionBackend: recordingBackend("custom", []) },
		});
		expect(supportsRuntimeShellEscalation(customBackendEnv, false, [])).toBe(
			false,
		);

		const state = new RuntimeState();
		state.runtimeSandboxRoot = root;
		state.effectiveEnvironment = customBackendEnv;
		state.sandboxMode = { value: "workspace-write", source: "default" };
		const authorize = authorizeRuntimeShell(state);
		await expect(
			authorize(
				{
					cwd: root,
					source: "gh run view 1 --log-failed",
					origin: "parent_agent",
					escalation: "unsandboxed",
				},
				(admit) => admit(),
			),
		).rejects.toThrow("escalation_unavailable");
	});

	test.skipIf(process.platform === "win32")(
		"saved and configured allows never grant unsandboxed execution",
		async () => {
			const base = realpathSync(
				mkdtempSync(path.join(tmpdir(), "codelia-escalation-allow-")),
			);
			try {
				const bin = path.join(base, "bin");
				mkdirSync(bin);
				writeFileSync(path.join(bin, "cargo"), "fixture", { mode: 0o700 });
				const launches: string[] = [];
				let prompts = 0;
				const record =
					(name: string) =>
					(_invocation: unknown, protection: ShellProtection) => {
						launches.push(`${name}:${protection.profile}`);
						return {} as ShellChild;
					};
				const authorize = createShellAuthorizer({
					root,
					shellPath: bin,
					backend: { ...fixtureShellBackend, launch: record("confined") },
					escalationBackend: { ...fixtureShellBackend, launch: record("user") },
					launchRules: new LaunchRuleStore(path.join(base, "rules")),
					authority: fixtureShellAuthority,
					policy: () => ({ allow: [{ tool: "shell", command: "cargo test" }] }),
					dispatcher: new ApprovalDispatcher({
						confirmation: {
							confirm: async ({ requestId }) => {
								prompts++;
								return { requestId, choice: "allow_once" };
							},
						},
					}),
				});
				const run = (escalation?: "unsandboxed") =>
					authorize(
						{
							cwd: root,
							origin: "parent_agent",
							source: "cargo test",
							escalation,
						},
						(admit) => admit(),
					);
				await run();
				expect([prompts, launches]).toEqual([0, ["confined:development"]]);
				await run("unsandboxed");
				expect([prompts, launches]).toEqual([
					1,
					["confined:development", "user:full-access"],
				]);
			} finally {
				rmSync(base, { recursive: true, force: true });
			}
		},
	);

	test("without a confirmation channel the command stays unstarted", async () => {
		const { run, launches } = setup({ confirmation: false });
		await expect(run()).rejects.toThrow("confirmation_required");
		expect(launches).toEqual([]);
	});

	test("rejects requests the escalation contract does not allow", async () => {
		const { run, launches } = setup({ autoReview: true });
		await expect(run({ origin: "child_agent" })).rejects.toThrow(
			"escalation_not_permitted",
		);
		await expect(run({ additionalWriteRoots: [root] })).rejects.toThrow(
			"escalation_with_additional_write_roots",
		);
		await expect(run({ stdin: "pipe" })).rejects.toThrow(
			"escalation_requires_closed_stdin",
		);
		await expect(setup({ escalationBackend: false }).run()).rejects.toThrow(
			"escalation_unavailable",
		);
		expect(launches).toEqual([]);
	});

	test("a full-access session treats escalation as a no-op", async () => {
		const { run, launches, prompts } = setup({ sandboxMode: "full-access" });
		await expect(run()).resolves.toBe("admitted");
		expect(launches).toEqual(["confined:full-access"]);
		expect(prompts[0]?.route.additional ?? []).toEqual([]);
	});
});
