import { describe, expect, test } from "bun:test";
import {
	buildSystemPermissions,
	PermissionService,
} from "../src/permissions/service";

const bashArgs = (command: string): string => JSON.stringify({ command });
const skillLoadArgs = (input: { name?: string; path?: string }): string =>
	JSON.stringify(input);

describe("PermissionService", () => {
	test("deny wins over allow for bash", () => {
		const service = new PermissionService({
			user: {
				allow: [{ tool: "bash", command: "rm" }],
				deny: [{ tool: "bash", command: "rm" }],
			},
		});

		const result = service.evaluate("bash", bashArgs("rm -rf /"));
		expect(result.decision).toBe("deny");
	});

	test("system allowlist includes read-only git commands", () => {
		const service = new PermissionService({
			system: buildSystemPermissions(),
			user: { allow: [] },
		});

		expect(
			service.evaluate("bash", bashArgs("git status --short")).decision,
		).toBe("allow");
		expect(service.evaluate("bash", bashArgs("git diff --stat")).decision).toBe(
			"allow",
		);
		expect(
			service.evaluate("bash", bashArgs("git log --oneline")).decision,
		).toBe("allow");
			expect(service.evaluate("bash", bashArgs("jj st")).decision).toBe(
				"confirm",
			);
			expect(service.evaluate("bash", bashArgs("cd /tmp")).decision).toBe(
				"confirm",
			);
			expect(service.evaluate("skill_search", "{}").decision).toBe("allow");
			expect(service.evaluate("skill_load", "{}").decision).toBe("allow");
			expect(service.evaluate("lane_list", "{}").decision).toBe("allow");
			expect(
				service.evaluate("lane_status", JSON.stringify({ lane_id: "lane_1" }))
					.decision,
			).toBe("allow");
			expect(
				service.evaluate("lane_create", JSON.stringify({ task_id: "t1" })).decision,
			).toBe("confirm");
		});

	test("skill_load deny rule can block a specific skill name", () => {
		const service = new PermissionService({
			system: buildSystemPermissions(),
			user: {
				deny: [{ tool: "skill_load", skill_name: "dangerous-skill" }],
			},
		});

		expect(
			service.evaluate("skill_load", skillLoadArgs({ name: "dangerous-skill" }))
				.decision,
		).toBe("deny");
		expect(
			service.evaluate("skill_load", skillLoadArgs({ name: "safe-skill" }))
				.decision,
		).toBe("allow");
	});

	test("skill_load skill_name rules match by path input", () => {
		const service = new PermissionService({
			user: {
				allow: [{ tool: "skill_load", skill_name: "repo-review" }],
			},
		});

		expect(
			service.evaluate(
				"skill_load",
				skillLoadArgs({
					path: "/repo/.agents/skills/repo-review/SKILL.md",
				}),
			).decision,
		).toBe("allow");
		expect(
			service.evaluate(
				"skill_load",
				skillLoadArgs({
					path: "/repo/.agents/skills/release-notes/SKILL.md",
				}),
			).decision,
		).toBe("confirm");
	});

	test("allows cd only when target stays in sandbox", () => {
		const service = new PermissionService({
			system: buildSystemPermissions(),
			user: { allow: [] },
			bashPathGuard: {
				rootDir: "/repo",
				workingDir: "/repo",
			},
		});

		expect(service.evaluate("bash", bashArgs("cd packages")).decision).toBe(
			"allow",
		);
		expect(
			service.evaluate("bash", bashArgs("cd /repo/packages")).decision,
		).toBe("allow");
		expect(service.evaluate("bash", bashArgs("cd /tmp")).decision).toBe(
			"confirm",
		);
		expect(service.evaluate("bash", bashArgs("cd ..")).decision).toBe(
			"confirm",
		);
	});

	test("allows when all split segments are allowed", () => {
		const service = new PermissionService({
			user: {
				allow: [
					{ tool: "bash", command: "rg" },
					{ tool: "bash", command: "cat" },
				],
			},
		});

		const result = service.evaluate("bash", bashArgs("rg foo | cat"));
		expect(result.decision).toBe("allow");
	});

	test("confirms when a segment is not allowed", () => {
		const service = new PermissionService({
			user: {
				allow: [{ tool: "bash", command: "rg" }],
			},
		});

		const result = service.evaluate("bash", bashArgs("rg foo | cat"));
		expect(result.decision).toBe("confirm");
	});

	test("redirect target is not treated as a command", () => {
		const service = new PermissionService({
			user: {
				allow: [{ tool: "bash", command: "rg" }],
			},
		});

		const result = service.evaluate("bash", bashArgs("rg foo > /dev/null"));
		expect(result.decision).toBe("allow");
	});

	test("command_glob can match full command", () => {
		const service = new PermissionService({
			user: {
				allow: [{ tool: "bash", command_glob: "rg* > /dev/null" }],
			},
		});

		const result = service.evaluate("bash", bashArgs("rg foo > /dev/null"));
		expect(result.decision).toBe("allow");
	});

	test("rememberAllow adds allow rule", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const initial = service.evaluate("bash", bashArgs("rg foo"));
		expect(initial.decision).toBe("confirm");
		const rules = service.rememberAllow("bash", bashArgs("rg foo"));
		expect(rules).toEqual([{ tool: "bash", command: "rg" }]);
		const after = service.evaluate("bash", bashArgs("rg foo"));
		expect(after.decision).toBe("allow");
	});

	test("rememberAllow stores skill_name for skill_load", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const initial = service.evaluate(
			"skill_load",
			skillLoadArgs({ name: "repo-review" }),
		);
		expect(initial.decision).toBe("confirm");
		const rules = service.rememberAllow(
			"skill_load",
			skillLoadArgs({ name: "repo-review" }),
		);
		expect(rules).toEqual([{ tool: "skill_load", skill_name: "repo-review" }]);
		const after = service.evaluate(
			"skill_load",
			skillLoadArgs({ path: "/repo/.agents/skills/repo-review/SKILL.md" }),
		);
		expect(after.decision).toBe("allow");
	});

	test("rememberAllow uses command prefix for simple commands", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const rules = service.rememberAllow("bash", bashArgs("jj st --no-pager"));
		expect(rules).toEqual([{ tool: "bash", command: "jj st" }]);
		const after = service.evaluate("bash", bashArgs("jj st -r @"));
		expect(after.decision).toBe("allow");
	});

	test("rememberAllow narrows launcher commands to three-token prefixes", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const rules = service.rememberAllow(
			"bash",
			bashArgs("npx skills find trending"),
		);
		expect(rules).toEqual([{ tool: "bash", command: "npx skills find" }]);
		expect(
			service.evaluate("bash", bashArgs("npx skills find latest")).decision,
		).toBe("allow");
		expect(service.evaluate("bash", bashArgs("npx skills list")).decision).toBe(
			"confirm",
		);
	});

	test("rememberAllow narrows npm exec commands to three-token prefixes", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const rules = service.rememberAllow(
			"bash",
			bashArgs("npm exec skills find"),
		);
		expect(rules).toEqual([{ tool: "bash", command: "npm exec skills" }]);
		expect(
			service.evaluate("bash", bashArgs("npm exec skills search")).decision,
		).toBe("allow");
		expect(
			service.evaluate("bash", bashArgs("npm exec prettier --check ."))
				.decision,
		).toBe("confirm");
	});

	test("rememberAllow keeps one-token command for non-subcommand tools", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const rules = service.rememberAllow(
			"bash",
			bashArgs("node scripts/task.js"),
		);
		expect(rules).toEqual([{ tool: "bash", command: "node" }]);
		const after = service.evaluate("bash", bashArgs("node scripts/other.js"));
		expect(after.decision).toBe("allow");
	});

	test("rememberAllow stores split rules for multi segment commands", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const rules = service.rememberAllow(
			"bash",
			bashArgs("git status && git diff --stat"),
		);
		expect(rules).toEqual([
			{ tool: "bash", command: "git status" },
			{ tool: "bash", command: "git diff" },
		]);
		const after = service.evaluate(
			"bash",
			bashArgs("git status && git diff --name-only"),
		);
		expect(after.decision).toBe("allow");
	});

	test("rememberAllow skips cd segments", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const rules = service.rememberAllow(
			"bash",
			bashArgs("cd packages && git status"),
		);
		expect(rules).toEqual([{ tool: "bash", command: "git status" }]);
	});

	test("rememberAllow skips duplicate rules", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const first = service.rememberAllow("bash", bashArgs("git status"));
		const second = service.rememberAllow("bash", bashArgs("git status"));
		expect(first).toEqual([{ tool: "bash", command: "git status" }]);
		expect(second).toEqual([]);
	});

	test("getConfirmPrompt includes remember preview for bash rules", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const prompt = service.getConfirmPrompt(
			"bash",
			bashArgs("git status && git diff --stat"),
		);
		expect(prompt.title).toBe("Run command?");
		expect(prompt.message).toContain("git status && git diff --stat");
		expect(prompt.message).toContain("Remember (don't ask again):");
		expect(prompt.message).toContain("- bash: git status");
		expect(prompt.message).toContain("- bash: git diff");
	});

	test("getConfirmPrompt preview excludes already allowed bash rules", () => {
		const service = new PermissionService({
			user: {
				allow: [{ tool: "bash", command: "jj new" }],
			},
		});
		const prompt = service.getConfirmPrompt(
			"bash",
			bashArgs("jj new && jj st"),
		);
		expect(prompt.message).toContain("Remember (don't ask again):");
		expect(prompt.message).not.toContain("- bash: jj new");
		expect(prompt.message).toContain("- bash: jj st");
	});

	test("getConfirmPrompt omits preview when all candidates are already allowed", () => {
		const service = new PermissionService({
			user: {
				allow: [
					{ tool: "bash", command: "git status" },
					{ tool: "bash", command: "git diff" },
				],
			},
		});
		const prompt = service.getConfirmPrompt(
			"bash",
			bashArgs("git status && git diff --stat"),
		);
		expect(prompt.message).toBe("git status && git diff --stat");
	});

	test("getConfirmPrompt omits remember preview when no rules are derivable", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const prompt = service.getConfirmPrompt("bash", bashArgs("cd packages"));
		expect(prompt.message).toBe("cd packages");
	});

	test("rememberAllow skips environment-assignment prefixes", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const rules = service.rememberAllow(
			"bash",
			bashArgs("FOO=bar rg -n foo ."),
		);
		expect(rules).toEqual([]);
	});

	test("rememberAllow skips wrapper commands", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const rules = service.rememberAllow(
			"bash",
			bashArgs("env FOO=bar rg -n foo ."),
		);
		expect(rules).toEqual([]);
	});

	test("rememberAllow normalizes absolute command paths", () => {
		const service = new PermissionService({ user: { allow: [] } });
		const rules = service.rememberAllow(
			"bash",
			bashArgs("/usr/bin/git status"),
		);
		expect(rules).toEqual([{ tool: "bash", command: "git status" }]);
	});

	test("operators inside quotes are ignored", () => {
		const service = new PermissionService({
			user: {
				allow: [{ tool: "bash", command: "echo" }],
			},
		});

		const result = service.evaluate("bash", bashArgs("echo 'a | b'"));
		expect(result.decision).toBe("allow");
	});
});
