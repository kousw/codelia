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
import {
	type ApprovalChoice,
	ApprovalDispatcher,
	type Confirmation,
} from "../src/permissions/dispatch";
import { LaunchRuleStore } from "../src/permissions/launch-rules";
import { buildLocalShellEvidence } from "../src/permissions/review-evidence";
import {
	createShellAuthorizer,
	type ShellApprovalInput,
} from "../src/permissions/shell-approval";
import {
	fixedBash,
	type ProtectedShellBackend,
	type ShellChild,
	type ShellProtection,
} from "../src/permissions/shell-backend";
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
}: {
	sandboxMode?: "readonly" | "workspace-write" | "full-access";
	autoReview?: boolean;
	decision?: Decision;
	userChoice?: ApprovalChoice;
	confirmation?: boolean;
	escalationBackend?: boolean;
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
			workspaceWrite: sandboxMode === "readonly" ? "forbid" : "granted",
			stdinPipe: "granted",
		},
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
	test("Auto approve reviews first and launches only this command as the user", async () => {
		const { run, launches, reviews, prompts } = setup({ autoReview: true });
		await expect(run()).resolves.toBe("admitted");
		expect(launches).toEqual(["user:full-access"]);
		expect(prompts).toHaveLength(0);
		expect(reviews[0]).toMatchObject({
			profile: "full-access",
			escalation: "unsandboxed_once",
			coverage: "parsed",
			network: "user_account",
		});
		expect(reviews[0]).not.toHaveProperty("limitation");

		await expect(run({ source: "ls", escalation: undefined })).resolves.toBe(
			"admitted",
		);
		expect(launches).toEqual(["user:full-access", "confined:investigation"]);
	});

	test("a review denial falls back to a person without allowance choices", async () => {
		const { run, launches, prompts } = setup({
			autoReview: true,
			decision: "deny",
		});
		await expect(run()).resolves.toBe("admitted");
		expect(prompts).toHaveLength(1);
		expect(prompts[0].choices).toEqual(["allow_once", "deny_continue"]);
		expect(prompts[0].route.additional).toEqual([
			{ operation: "invoke", target: "shell.unsandboxed" },
		]);
		expect(launches).toEqual(["user:full-access"]);
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
