import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { ApprovalDispatcher } from "../src/permissions/dispatch";
import { LinuxRunscBackend } from "../src/permissions/linux-shell-backend";
import { createShellAuthorizer } from "../src/permissions/shell-approval";
import {
	MacSeatbeltBackend,
	type ProtectedShellBackend,
	workspacePathProtection,
} from "../src/permissions/shell-backend";
import { approveFixture, fixtureShellAuthority } from "./fixtures/approval";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
		.toString()
		.trim();

const initRepository = (directory: string) => {
	git(directory, "init", "-q");
	git(directory, "config", "user.name", "Fixture");
	git(directory, "config", "user.email", "fixture@example.invalid");
	git(directory, "config", "commit.gpgsign", "false");
	writeFileSync(path.join(directory, "a.txt"), "1\n");
	git(directory, "add", "a.txt");
	git(directory, "commit", "-qm", "initial");
};

let temp: string;

beforeEach(() => {
	// Like the existing Linux live fixture, keep Linux workspaces under HOME.
	const base = process.platform === "linux" ? homedir() : tmpdir();
	temp = realpathSync(mkdtempSync(path.join(base, "codelia-git-scope-")));
});

afterEach(() => {
	rmSync(temp, { recursive: true, force: true });
});

const protectionFor = (workspace: string) =>
	workspacePathProtection(
		workspace,
		[],
		[workspace],
		"workspace-write",
		false,
		[],
		{ writeRoots: [workspace], gitWrites: true },
	);

describe("Git write scope", () => {
	test("an ordinary repository opens .git except redirecting and executable entries", () => {
		initRepository(temp);
		const gitDirectory = path.join(temp, ".git");
		const protection = protectionFor(temp);
		expect(protection.readOnlyPaths).not.toContain(gitDirectory);
		expect(protection.gitWriteRoots).toBeUndefined();
		for (const name of [
			"config",
			"config.worktree",
			"hooks",
			"commondir",
			"objects/info/alternates",
			"objects/info/http-alternates",
			"remotes",
			"branches",
			"modules",
		])
			expect(protection.readOnlyPaths).toContain(path.join(gitDirectory, name));
		expect(protection.gitProtectedPaths).toContain(
			path.join(gitDirectory, "commondir"),
		);
		// Built-in file tools keep the whole Git directory read-only.
		expect(workspacePathProtection(temp, [], [temp]).readOnlyPaths).toContain(
			gitDirectory,
		);
	});

	test("a linked worktree opens its metadata and the common directory outside the workspace", () => {
		const main = path.join(temp, "main");
		execFileSync("mkdir", [main]);
		initRepository(main);
		const worktree = path.join(temp, "wt");
		git(main, "worktree", "add", "-q", "-b", "wt", worktree);
		const common = path.join(main, ".git");
		const metadata = path.join(common, "worktrees", "wt");
		const protection = protectionFor(worktree);
		expect(protection.gitWriteRoots).toEqual([common, metadata].sort());
		for (const entry of [
			path.join(worktree, ".git"),
			path.join(metadata, "gitdir"),
			path.join(metadata, "commondir"),
			path.join(common, "config"),
			path.join(common, "hooks"),
		])
			expect(protection.readOnlyPaths).toContain(entry);
		expect(protection.readOnlyPaths).not.toContain(common);
		expect(protection.readOnlyPaths).not.toContain(metadata);
	});
});

const liveBackends: [string, () => ProtectedShellBackend][] = [];
if (
	process.platform === "darwin" &&
	process.env.CODELIA_APPROVAL_MAC_LIVE === "1"
)
	liveBackends.push(["Seatbelt", () => new MacSeatbeltBackend()]);
if (
	process.platform === "linux" &&
	process.env.CODELIA_APPROVAL_LINUX_LIVE === "1"
)
	liveBackends.push(["gVisor", () => new LinuxRunscBackend()]);

describe.skipIf(liveBackends.length === 0).each(liveBackends)(
	"%s confined development shell",
	(_name, createBackend) => {
		const shell = async (workspace: string, source: string) => {
			const authorize = createShellAuthorizer({
				root: workspace,
				backend: createBackend(),
				authority: fixtureShellAuthority,
				dispatcher: new ApprovalDispatcher({ confirmation: approveFixture }),
			});
			return authorize(
				{ cwd: workspace, origin: "parent_agent", source },
				async (admit) => {
					const child = admit();
					let output = "";
					child.stdout.on("data", (value) => {
						output += value.toString();
					});
					child.stderr.on("data", (value) => {
						output += value.toString();
					});
					const [code] = await once(child, "close");
					return { code: code as number, output: output.trim() };
				},
			);
		};

		test("runs ordinary local Git writes and keeps redirecting entries read-only", async () => {
			initRepository(temp);
			writeFileSync(path.join(temp, "b.txt"), "2\n");
			expect(
				await shell(
					temp,
					"git add b.txt && git commit -qm second && git switch -qc feature && git stash list && git rev-list --count HEAD",
				),
			).toEqual({ code: 0, output: "2" });
			const config = readFileSync(path.join(temp, ".git/config"), "utf8");
			for (const source of [
				"echo '[core]' >> .git/config",
				"echo 'exit 0' > .git/hooks/pre-commit",
				"echo /tmp > .git/commondir",
				"mkdir -p .git/objects/info && echo /tmp > .git/objects/info/alternates",
				"mkdir .git/remotes",
			])
				await shell(temp, source);
			expect(readFileSync(path.join(temp, ".git/config"), "utf8")).toBe(config);
			for (const name of [
				"hooks/pre-commit",
				"commondir",
				"objects/info/alternates",
				"remotes",
			])
				expect(existsSync(path.join(temp, ".git", name))).toBe(false);
		});

		test("commits in a linked worktree whose common directory is outside the workspace", async () => {
			const main = path.join(temp, "main");
			execFileSync("mkdir", [main]);
			initRepository(main);
			const worktree = path.join(temp, "wt");
			git(main, "worktree", "add", "-q", "-b", "wt", worktree);
			writeFileSync(path.join(worktree, "c.txt"), "3\n");
			expect(
				await shell(
					worktree,
					"git add c.txt && git commit -qm linked && git rev-list --count HEAD",
				),
			).toEqual({ code: 0, output: "2" });
			expect(git(main, "rev-list", "--count", "wt")).toBe("2");
		});

		test("uses the login HOME and can allocate a pseudo-terminal", async () => {
			const result = await shell(
				temp,
				`printf '%s\\n' "$HOME" && python3 -c 'import os; m, s = os.openpty(); print(os.isatty(s))'`,
			);
			expect(result).toEqual({ code: 0, output: `${homedir()}\nTrue` });
		});
	},
);
