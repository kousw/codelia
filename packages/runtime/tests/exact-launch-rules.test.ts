import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ApprovalDispatcher,
	type Confirmation,
} from "../src/permissions/dispatch";
import {
	bindSuggestedLaunch,
	buildExactLaunchCandidate,
	fileIdentity,
	LaunchRuleStore,
} from "../src/permissions/launch-rules";
import { createShellAuthorizer } from "../src/permissions/shell-approval";
import {
	MacSeatbeltBackend,
	type ProtectedShellBackend,
	type ShellChild,
} from "../src/permissions/shell-backend";
import { fixtureShellAuthority } from "./fixtures/approval";

function fixture() {
	const base = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-exact-rule-")),
	);
	const root = path.join(base, "workspace");
	const bin = path.join(base, "bin");
	const directory = path.join(base, "rules");
	mkdirSync(root);
	mkdirSync(bin);
	const executable = path.join(bin, "fixture-tool");
	writeFileSync(executable, "ordinary fixture", { mode: 0o700 });
	return { base, root, bin, directory, executable };
}

test("prefix rules survive restart and match complete argument tokens under the approved authority", () => {
	const { base, root, executable, directory } = fixture();
	try {
		const store = new LaunchRuleStore(directory);
		const make = (args: string[], authority = "scope") => {
			const candidate = buildExactLaunchCandidate(
				{
					args,
					project: root,
					cwd: root,
					argv0: "fixture-tool",
					origin: "parent_agent",
					profile: "development",
					executable,
					authority,
				},
				{ kind: "argv", executable, args },
			);
			if (!candidate) throw Error("Expected fixture candidate");
			return candidate;
		};
		const candidate = make(["test", "--release"]);
		const proposal = bindSuggestedLaunch(candidate, {
			kind: "prefix",
			words: ["fixture-tool", "test"],
		});
		if (!proposal) throw Error("Expected a bound test proposal");
		expect(proposal.rule).toMatchObject({
			args: ["test"],
			template: "argv-prefix/v1",
		});
		expect(proposal.description).toContain("any trailing arguments");
		expect(
			bindSuggestedLaunch(make(["test", "\u202e\n"]), { kind: "exact" })
				?.description,
		).toContain("\\u202e\\n");
		expect(
			bindSuggestedLaunch(make(["run", "suite"]), {
				kind: "prefix",
				words: ["fixture-tool", "run", "suite"],
			})?.rule.args,
		).toEqual(["run", "suite"]);
		expect(
			bindSuggestedLaunch(make(["--version"]), { kind: "exact" })?.rule
				.template,
		).toBe("exact-argv/v2");
		for (const invalid of [
			{ kind: "default" },
			{ kind: "exact", cwd: root },
			{ kind: "prefix", words: ["fixture-tool"] },
			{ kind: "prefix", words: ["fixture-tool", "buil"] },
			{ kind: "prefix", words: ["fixture-tool", "tes"] },
			{ kind: "prefix", words: ["other-tool", "test"] },
			{ kind: "prefix", words: ["fixture-tool", "test", "--release"] },
			{ kind: "prefix", words: ["fixture-tool", "test"], scope: "project" },
		])
			expect(bindSuggestedLaunch(candidate, invalid)).toBeUndefined();
		store.save(proposal.rule, "session", "first");
		expect(store.match(make(["test"]).rule, "first")?.id).toBe(
			proposal.rule.id,
		);
		expect(store.match(make(["test"]).rule, "second")).toBeUndefined();
		store.save(proposal.rule, "project", "first");
		const reopened = new LaunchRuleStore(directory);
		expect(reopened.match(make(["test", "a", "b"]).rule, "second")?.id).toBe(
			proposal.rule.id,
		);
		expect(reopened.match(make(["testing"]).rule, "second")).toBeUndefined();
		expect(
			reopened.match(make(["test"], "other").rule, "second"),
		).toBeUndefined();
		const exact = make(["run", "suite"]);
		reopened.save(exact.rule, "project", "second");
		expect(
			reopened.match(make(["run", "suite", "--watch"]).rule, "second"),
		).toBeUndefined();
		expect(reopened.remove(root, "second", proposal.rule.id, "project")).toBe(
			true,
		);
		expect(reopened.match(make(["test"]).rule, "second")).toBeUndefined();
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "win32")(
	"confirming a Cargo test prefix saves it and reuses it for other test filters",
	async () => {
		const { base, root, bin, directory } = fixture();
		try {
			writeFileSync(path.join(bin, "cargo"), "ordinary fixture", {
				mode: 0o700,
			});
			const store = new LaunchRuleStore(directory);
			let firstChoice: "allow_once" | "setup_allowance" = "allow_once";
			let autoReview = false;
			let suggestions = 0;
			let launches = 0;
			const order: string[] = [];
			const authorize = createShellAuthorizer({
				root,
				shellPath: bin,
				authority: fixtureShellAuthority,
				launchRules: store,
				autoReviewEnabled: () => autoReview,
				extraReviewPrivatePaths: [path.join(root, "private")],
				backend: {
					supportsReadOnlyPaths: true,
					supports: () => true,
					exactLaunchBindingId: "fixture/1",
					supportsExactLaunchBinding: () => true,
					launch: () => {
						launches++;
						return {} as ShellChild;
					},
				},
				proposeLaunchRule: async (request, words) => {
					order.push("proposal");
					expect(words).toEqual(["cargo", "test", "test_release", "--release"]);
					expect(JSON.parse(request.input).reviewPrivatePaths).toContain(
						path.join(root, "private"),
					);
					suggestions++;
					return { kind: "prefix", words: words.slice(0, 2) };
				},
				dispatcher: new ApprovalDispatcher({
					review: {
						categories: ["local_shell"],
						buildEvidence: async () => {
							throw new Error("Saved test prefix should skip review evidence");
						},
						review: async () => {
							throw new Error("Saved test prefix should skip Auto review");
						},
					},
					confirmation: {
						confirm: async (prompt) => {
							order.push(prompt.shellStage ?? "unknown");
							if (prompt.shellStage === "initial") {
								expect(prompt.choices).not.toContain("save_project");
								return { requestId: prompt.requestId, choice: firstChoice };
							}
							expect(store.list(root, "runtime")).toEqual([]);
							expect(prompt.saveDescription).toContain(
								'["cargo","test"] with any trailing arguments',
							);
							return { requestId: prompt.requestId, choice: "save_project" };
						},
					},
				}),
			});
			const run = (source: string) =>
				authorize({ cwd: root, origin: "parent_agent", source }, (admit) =>
					admit(),
				);
			await run("cargo test test_release --release");
			expect(suggestions).toBe(0);
			firstChoice = "setup_allowance";
			await run("cargo test test_release --release");
			autoReview = true;
			await run("cargo test test_remove --quiet");
			await run("cargo test -- --skip delete --config=test_release");
			expect(suggestions).toBe(1);
			expect(launches).toBe(4);
			expect(order).toEqual(["initial", "initial", "proposal", "rule"]);
			expect(store.list(root, "runtime")).toMatchObject([
				{
					template: "argv-prefix/v1",
					args: ["test"],
					cwd: root,
					origin: "parent_agent",
				},
			]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"exact save preserves source, argv, cwd, profile, authority and executable across restarts",
	async () => {
		const { base, root, bin, directory, executable } = fixture();
		try {
			const sub = path.join(root, "sub");
			mkdirSync(sub);
			let choice: "save_project" | "allow_once" = "save_project";
			const prompts: Confirmation[] = [];
			const launches: string[] = [];
			const backend: ProtectedShellBackend = {
				supportsReadOnlyPaths: true,
				supports: () => true,
				exactLaunchBindingId: "fixture/1",
				supportsExactLaunchBinding: () => true,
				launch(invocation) {
					launches.push(invocation.kind);
					return {} as ShellChild;
				},
			};
			const bind = (
				options: Partial<Parameters<typeof createShellAuthorizer>[0]> = {},
			) =>
				createShellAuthorizer({
					root,
					shellPath: bin,
					backend,
					authority: fixtureShellAuthority,
					launchRules: new LaunchRuleStore(directory),
					dispatcher: new ApprovalDispatcher({
						confirmation: {
							confirm: async (request) => {
								prompts.push(request);
								return { requestId: request.requestId, choice };
							},
						},
					}),
					...options,
				});
			const source = "fixture-tool check 'two words'";
			const input = {
				cwd: root,
				source,
				origin: "parent_agent" as const,
				owner: "first",
			};
			await bind()(input, (admit) => admit());
			expect(prompts).toHaveLength(1);
			expect(prompts[0].saveDescription).toContain("effects can change");
			const reopened = new LaunchRuleStore(directory);
			const [rule] = reopened.list(root, "second");
			expect(rule).toMatchObject({
				scope: "project",
				template: "exact-argv/v2",
				source,
				launchKind: "source",
				argv0: "fixture-tool",
				executable,
				args: ["check", "two words"],
				cwd: root,
			});
			choice = "allow_once";
			await bind()({ ...input, owner: "second" }, (admit) => admit());
			expect(prompts).toHaveLength(1);
			for (const changed of [
				{ ...input, source: "fixture-tool check other" },
				{ ...input, cwd: sub },
				{ ...input, origin: "operator" as const },
				{
					cwd: root,
					origin: "parent_agent" as const,
					argv: [executable, "check", "two words"],
				},
			])
				await bind()(changed, (admit) => admit());
			await bind({ sandboxMode: "readonly" })(input, (admit) => admit());
			await bind({ extraReadOnlyPaths: [sub] })(input, (admit) => admit());
			await bind({
				backend: { ...backend, exactLaunchBindingId: "fixture/2" },
			})(input, (admit) => admit());
			expect(prompts).toHaveLength(8);
			const count = launches.length;
			await expect(
				bind()(
					{ ...input, deny: [{ tool: "shell", command: "fixture-tool" }] },
					(admit) => admit(),
				),
			).rejects.toThrow("legacy_deny_rule");
			expect(launches).toHaveLength(count);
			expect(launches.slice(0, 2)).toEqual(["source", "source"]);
			writeFileSync(executable, "replaced executable");
			await bind()(input, (admit) => admit());
			expect(prompts).toHaveLength(9);
			expect(reopened.remove(root, "second", rule.id, "project")).toBe(true);
			expect(new LaunchRuleStore(directory).list(root, "second")).toEqual([]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"an expired unconsumed save leaves no rule; ordinary one-shot and constrained requests stay unsaved",
	async () => {
		const { base, root, bin, directory } = fixture();
		try {
			const rules = new LaunchRuleStore(directory);
			let saving = true;
			let context = "first";
			const choices: boolean[] = [];
			const authorize = createShellAuthorizer({
				root,
				shellPath: bin,
				launchRules: rules,
				authority: fixtureShellAuthority,
				context: () => context,
				backend: {
					supportsReadOnlyPaths: true,
					supports: () => true,
					exactLaunchBindingId: "fixture/1",
					supportsExactLaunchBinding: () => true,
					launch: () => ({}) as ShellChild,
				},
				dispatcher: new ApprovalDispatcher({
					confirmation: {
						confirm: async (req) => {
							choices.push(req.choices.includes("save_project"));
							return {
								requestId: req.requestId,
								choice: saving ? "save_project" : "allow_once",
							};
						},
					},
				}),
			});
			const input = {
				cwd: root,
				origin: "parent_agent" as const,
				source: "fixture-tool check",
			};
			await expect(
				authorize(input, (admit) => {
					context = "changed";
					return admit();
				}),
			).rejects.toThrow("approval_expired");
			expect(rules.list(root, "runtime")).toEqual([]);
			saving = false;
			await authorize(input, (admit) => admit());
			expect(rules.list(root, "runtime")).toEqual([]);
			for (const changed of [
				{ ...input, source: "fixture-tool one && fixture-tool two" },
				{ ...input, source: "fixture-tool check | fixture-tool check" },
				{ ...input, source: "fixture-tool *.txt" },
				{ ...input, source: "for a in one; do fixture-tool check; done" },
				{ ...input, source: "echo arbitrary" },
				{ ...input, source: "fixture-tool publish" },
				{ ...input, stdin: "pipe" as const },
			])
				await authorize(changed, (admit) => admit());
			expect(choices).toEqual([
				true,
				true,
				false,
				false,
				false,
				false,
				false,
				false,
				false,
			]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	},
);

test
	.skipIf(
		process.platform !== "darwin" ||
			process.env.CODELIA_APPROVAL_MAC_LIVE !== "1",
	)
	.each(["exact", "prefix"] as const)(
	"native Seatbelt reuses a saved %s rule from a fresh project store",
	async (mode) => {
		const { base, root, directory } = fixture();
		try {
			let prompts = 0;
			const call = (source: string) =>
				createShellAuthorizer({
					root,
					backend: new MacSeatbeltBackend(),
					authority: fixtureShellAuthority,
					launchRules: new LaunchRuleStore(directory),
					proposeLaunchRule: async (_request, words) =>
						mode === "prefix" ? { kind: "prefix", words } : { kind: "exact" },
					dispatcher: new ApprovalDispatcher({
						confirmation: {
							confirm: async ({ requestId, choices }) => {
								if (choices.includes("setup_allowance"))
									return { requestId, choice: "setup_allowance" };
								expect(choices).toContain("save_project");
								prompts++;
								return { requestId, choice: "save_project" };
							},
						},
					}),
				})(
					{
						cwd: root,
						origin: "parent_agent",
						source,
					},
					async (admit) => {
						const child = admit();
						child.stdout.resume();
						child.stderr.resume();
						expect((await once(child, "close"))[0]).toBe(0);
					},
				);
			const operand = mode === "prefix" ? "marker" : "ordinary.txt";
			const source = `/usr/bin/touch ${operand}`;
			await call(source);
			const target = path.join(root, operand);
			expect(existsSync(target)).toBe(true);
			rmSync(target);
			await call(mode === "prefix" ? `${source} second.txt` : source);
			expect(existsSync(target)).toBe(true);
			expect(existsSync(path.join(root, "second.txt"))).toBe(mode === "prefix");
			expect(prompts).toBe(1);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"removing a saved rule during the final backend probe cancels dispatch",
	async () => {
		const { base, root, bin, directory } = fixture();
		try {
			const store = new LaunchRuleStore(directory);
			const otherRuntime = new LaunchRuleStore(directory);
			let revokeDuringProbe = false;
			let launches = 0;
			const authorize = createShellAuthorizer({
				root,
				shellPath: bin,
				authority: fixtureShellAuthority,
				launchRules: store,
				backend: {
					supportsReadOnlyPaths: true,
					exactLaunchBindingId: "fixture/1",
					supportsExactLaunchBinding: () => true,
					supports: () => {
						if (revokeDuringProbe) {
							const [rule] = otherRuntime.list(root, "runtime");
							expect(
								otherRuntime.remove(root, "runtime", rule.id, "project"),
							).toBe(true);
							revokeDuringProbe = false;
						}
						return true;
					},
					launch: () => {
						launches++;
						return {} as ShellChild;
					},
				},
				dispatcher: new ApprovalDispatcher({
					confirmation: {
						confirm: async ({ requestId }) => ({
							requestId,
							choice: "save_project",
						}),
					},
				}),
			});
			const input = {
				cwd: root,
				origin: "parent_agent" as const,
				source: "fixture-tool check",
			};
			await authorize(input, (admit) => admit());
			await expect(
				authorize(input, (admit) => {
					revokeDuringProbe = true;
					return admit();
				}),
			).rejects.toThrow("approval_expired");
			expect(launches).toBe(1);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	},
);

test("invalid legacy project entries stay removable and cannot authorize, even alongside malformed files", () => {
	const { base, root, directory, executable } = fixture();
	try {
		const store = new LaunchRuleStore(directory);
		const legacy = {
			id: "a".repeat(64),
			template: "bun-typecheck/v1",
			project: root,
			executable,
			executableIdentity: "old",
			origin: "parent_agent",
			profile: "development",
			stdin: "closed",
		} as const;
		store.save(legacy, "project", "runtime");
		const projectDirectory = path.join(
			directory,
			createHash("sha256").update(root).digest("hex"),
		);
		writeFileSync(path.join(projectDirectory, "b".repeat(64)), "{", {
			mode: 0o600,
		});
		const reopened = new LaunchRuleStore(directory);
		expect(reopened.list(root, "runtime")).toHaveLength(1);
		expect(reopened.hasLegacy(legacy, "runtime")).toBe(false);
		expect(reopened.remove(root, "runtime", legacy.id, "project")).toBe(true);
		store.save(legacy, "session", "runtime");
		expect(store.remove(base, "runtime", legacy.id, "session")).toBe(false);
		expect(store.remove(root, "runtime", legacy.id, "session")).toBe(true);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

function saveLegacyTypecheck(
	root: string,
	directory: string,
	executable: string,
): void {
	const body = {
		template: "bun-typecheck/v1",
		project: root,
		executable,
		executableIdentity: fileIdentity(executable),
		origin: "parent_agent",
		profile: "development",
		stdin: "closed",
	} as const;
	const id = createHash("sha256").update(JSON.stringify(body)).digest("hex");
	new LaunchRuleStore(directory).save({ id, ...body }, "project", "first");
}

test.skipIf(
	process.platform !== "darwin" ||
		process.env.CODELIA_APPROVAL_MAC_LIVE !== "1",
)(
	"native Seatbelt dispatch accepts an existing v1 Bun typecheck rule on its original target",
	async () => {
		const { base, root, directory } = fixture();
		try {
			const executable = realpathSync(process.execPath);
			writeFileSync(
				path.join(root, "package.json"),
				JSON.stringify({ scripts: { typecheck: "true" } }),
			);
			saveLegacyTypecheck(root, directory, executable);
			const authorize = createShellAuthorizer({
				root,
				backend: new MacSeatbeltBackend(),
				authority: fixtureShellAuthority,
				launchRules: new LaunchRuleStore(directory),
				dispatcher: new ApprovalDispatcher({
					confirmation: {
						confirm: async () => {
							throw new Error("Expected stored v1 rule");
						},
					},
				}),
			});
			await authorize(
				{ cwd: root, source: "bun run typecheck", origin: "parent_agent" },
				async (admit) => {
					const child = admit();
					child.stdout.resume();
					child.stderr.resume();
					expect((await once(child, "close"))[0]).toBe(0);
				},
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a persisted v1 Bun rule applies only when the backend verifies both its original target and the current launch",
	async () => {
		const { base, root, directory } = fixture();
		try {
			const executable = realpathSync(process.execPath);
			writeFileSync(
				path.join(root, "package.json"),
				JSON.stringify({ scripts: { typecheck: "true" } }),
			);
			saveLegacyTypecheck(root, directory, executable);
			let prompts = 0;
			let launches = 0;
			for (const [legacyBinding, modernBinding, expectPrompts] of [
				[true, true, 0],
				[false, true, 1],
				[true, false, 2],
			] as const) {
				const authorize = createShellAuthorizer({
					root,
					shellPath: path.dirname(executable),
					authority: fixtureShellAuthority,
					launchRules: new LaunchRuleStore(directory),
					backend: {
						supportsReadOnlyPaths: true,
						supports: () => true,
						exactLaunchBindingId: "fixture",
						supportsLaunchBinding: () => legacyBinding,
						supportsExactLaunchBinding: () => modernBinding,
						launch: () => {
							launches++;
							return {} as ShellChild;
						},
					},
					dispatcher: new ApprovalDispatcher({
						confirmation: {
							confirm: async ({ requestId }) => {
								prompts++;
								return { requestId, choice: "allow_once" };
							},
						},
					}),
				});
				await authorize(
					{ cwd: root, source: "bun run typecheck", origin: "parent_agent" },
					(admit) => admit(),
				);
				expect(prompts).toBe(expectPrompts);
			}
			expect(launches).toBe(3);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"the legacy SDK local_test reviewer and exact saved launches require separate capabilities",
	async () => {
		const { base, root, directory } = fixture();
		try {
			writeFileSync(path.join(root, "package.json"), "{}");
			const cases: Array<{
				legacy?: () => boolean;
				expectedReviews: number;
				canSave: boolean;
			}> = [
				{ legacy: () => true, expectedReviews: 1, canSave: false },
				{ expectedReviews: 0, canSave: true },
				{
					legacy: () => {
						throw new Error("fixture unavailable");
					},
					expectedReviews: 0,
					canSave: true,
				},
			];
			for (const scenario of cases) {
				let reviews = 0;
				const authorize = createShellAuthorizer({
					root,
					authority: fixtureShellAuthority,
					launchRules: new LaunchRuleStore(directory),
					backend: {
						supportsReadOnlyPaths: true,
						supports: () => true,
						supportsLaunchBinding: scenario.legacy,
						...(scenario.canSave
							? {
									exactLaunchBindingId: "fixture/1",
									supportsExactLaunchBinding: () => true,
								}
							: {}),
						launch: () => ({}) as ShellChild,
					},
					dispatcher: new ApprovalDispatcher({
						review: {
							categories: ["local_test"],
							buildEvidence: async () => {
								reviews++;
								return null;
							},
							review: async () => null,
						},
						confirmation: {
							confirm: async ({ requestId, choices }) => {
								expect(choices.includes("save_project")).toBe(scenario.canSave);
								return { requestId, choice: "allow_once" };
							},
						},
					}),
				});
				await authorize(
					{ cwd: root, source: "bun run typecheck", origin: "parent_agent" },
					(admit) => admit(),
				);
				expect(reviews).toBe(scenario.expectedReviews);
			}
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	},
);
