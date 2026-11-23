import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { resolveStoragePaths } from "@codelia/storage";
import {
	homeDotDirectory,
	homeDotLinkTargets,
	isHomeDotTarget,
} from "../src/permissions/home-dot-paths";
import {
	LinuxRunscBackend,
	linuxRunscMountArgs,
} from "../src/permissions/linux-shell-backend";
import { runtimeLocalAutoReview } from "../src/permissions/local-reviewer";
import { authorizeRuntimeShell } from "../src/permissions/runtime-approval";
import {
	createMacMxcShellBackend,
	fixedBash,
	MacSeatbeltBackend,
	type ShellProtection,
	supportsProtectedShell,
	workspacePathProtection,
} from "../src/permissions/shell-backend";
import { RuntimeState } from "../src/runtime-state";
import { SandboxContext } from "../src/sandbox/context";
import { createDirectoryMutationBroker } from "../src/sandbox/file-mutations";
import { createWorkspaceFiles } from "../src/subagents/workspace-files";
import { fixtureShellBackend } from "./fixtures/approval";

let fixture: string;
let homeDir: string;
let restoreHome: () => void;

beforeEach(() => {
	fixture = realpathSync(mkdtempSync(path.join(tmpdir(), "codelia-dot-")));
	homeDir = path.join(fixture, "user.dir+[sample]");
	for (const dir of ["project", ".settings", "Library"])
		mkdirSync(path.join(homeDir, dir), { recursive: true });
	writeFileSync(path.join(homeDir, ".existing"), "data");
	const home = spyOn(os, "homedir").mockReturnValue(homeDir);
	restoreHome = () => home.mockRestore();
});
afterEach(() => {
	restoreHome();
	rmSync(fixture, { recursive: true, force: true });
});

const protectionFor = (
	root: string,
	extraWriteRoots: readonly string[] = [],
): ShellProtection => ({
	root,
	cwd: homeDir,
	writeRoots: [root, ...extraWriteRoots],
	protectedPaths: [],
	stdin: "closed",
	profile: "development",
	homeDotDirectory: homeDotDirectory([root]),
	readOnlyPaths: homeDotLinkTargets(homeDir),
});

test("only write grants containing the real home trigger a top-level exclusion", () => {
	expect(homeDotDirectory([fixture])).toBe(homeDir);
	expect(homeDotDirectory([homeDir])).toBe(homeDir);
	expect(homeDotDirectory([path.join(homeDir, ".settings")])).toBeUndefined();
	expect(
		workspacePathProtection(fixture, [], [homeDir], "readonly")
			.homeDotDirectory,
	).toBeUndefined();
	expect(
		workspacePathProtection(path.join(homeDir, "project"), [], [homeDir])
			.homeDotDirectory,
	).toBeUndefined();
	expect(
		workspacePathProtection(
			path.join(homeDir, "project"),
			[],
			[],
			"workspace-write",
			false,
			[],
			{ writeRoots: [homeDir] },
		).homeDotDirectory,
	).toBe(homeDir);
	expect(isHomeDotTarget(homeDir, path.join(homeDir, "project", ".env"))).toBe(
		false,
	);
	expect(isHomeDotTarget(homeDir, path.join(homeDir, ".future", "f"))).toBe(
		true,
	);
	const library = path.join(homeDir, "Library", "f");
	expect(isHomeDotTarget(homeDir, library, "darwin")).toBe(true);
	expect(isHomeDotTarget(homeDir, library, "linux")).toBe(false);
	const backend = {
		supports: () => true,
		supportsReadOnlyPaths: true as const,
		launch: () => {
			throw new Error("unexpected launch");
		},
	};
	expect(
		supportsProtectedShell(backend, {
			...protectionFor(homeDir),
			profile: "full-access",
		}),
	).toBe(true);
	expect(supportsProtectedShell(backend, protectionFor(homeDir))).toBe(false);
	expect(
		supportsProtectedShell(
			{ ...backend, supportsHomeDotProtection: true },
			protectionFor(homeDir),
		),
	).toBe(true);
});

test("built-in and delegated writes reserve current and future home entries and allow reads", async () => {
	const context = await SandboxContext.create(homeDir, {
		protectResources: true,
		sandboxMode: "workspace-write",
	});
	const files = createWorkspaceFiles(homeDir);
	expect(context.selectFile(".existing", "read").identity).toBeTruthy();
	for (const name of [
		".existing",
		".future",
		".settings/settings",
		...(process.platform === "darwin" ? ["Library/settings"] : []),
	]) {
		expect(() => context.selectFile(name, "write")).toThrow(/read-only/);
		await expect(
			files.update(name, "missing", () => "changed"),
		).rejects.toThrow(/read-only/);
	}
	expect(context.selectFile("project/.future", "write").identity).toBeNull();
	await files.update("project/.future", "missing", () => "ok");
	expect(readFileSync(path.join(homeDir, "project/.future"), "utf8")).toBe(
		"ok",
	);
	const scoped = await SandboxContext.create(path.join(homeDir, ".settings"), {
		protectResources: true,
		sandboxMode: "workspace-write",
	});
	expect(scoped.selectFile("settings", "write").identity).toBeNull();
	const selected = scoped.selectFile("settings", "write");
	if (selected.identity !== null)
		throw new Error("expected a missing destination");
	const broker = createDirectoryMutationBroker({
		backend: {
			supports: () => true,
			launch: () => {
				throw new Error("unexpected launch");
			},
		},
		resolveProtection: () => protectionFor(homeDir),
	});
	await expect(
		broker.run({ kind: "create", destination: selected, content: "test" }),
	).rejects.toThrow("directory_mutation_readonly_path");
});

test.skipIf(process.platform === "win32")(
	"reserved dotfile links cover both existing and dangling destinations",
	async () => {
		const realFile = path.join(homeDir, "project", "settings");
		const future = path.join(homeDir, "project", "future");
		writeFileSync(realFile, "ok");
		symlinkSync("project/settings", path.join(homeDir, ".linked"));
		symlinkSync("project/future", path.join(homeDir, ".pending"));
		const alias = path.join(fixture, "home-link");
		symlinkSync(homeDir, alias);
		expect(homeDotDirectory([alias])).toBe(homeDir);
		expect(homeDotLinkTargets(homeDir).sort()).toEqual(
			[future, realFile].sort(),
		);
		const context = await SandboxContext.create(alias, {
			protectResources: true,
			sandboxMode: "workspace-write",
		});
		expect(context.selectFile(".linked", "read").target).toBe(realFile);
		for (const operand of [".linked", realFile, future])
			expect(() => context.selectFile(operand, "write")).toThrow(/read-only/);
		expect(() => context.bindFiles([]).resolvePath(".future", "write")).toThrow(
			/read-only/,
		);
	},
);

test.skipIf(process.platform === "win32")(
	"closed cycles of protected home links leave ordinary writes available",
	async () => {
		symlinkSync(".self", path.join(homeDir, ".self"));
		symlinkSync("./.second", path.join(homeDir, ".first"));
		symlinkSync(path.join(homeDir, ".first"), path.join(homeDir, ".second"));
		const file = path.join(homeDir, "project", "ordinary");
		writeFileSync(file, "initial");
		const pending = path.join(homeDir, "project", "pending");
		symlinkSync(pending, path.join(homeDir, ".pending"));

		const policy = workspacePathProtection(homeDir);
		expect(policy.readOnlyPaths).toContain(pending);
		const context = await SandboxContext.create(homeDir, {
			protectResources: true,
			sandboxMode: "workspace-write",
		});
		const delegated = createWorkspaceFiles(homeDir);
		await context.writeSelectedFile(file, "updated");
		await delegated.update("project/created", "missing", () => "delegated");
		expect(readFileSync(file, "utf8")).toBe("updated");
		expect(() => context.selectFile(".first", "write")).toThrow(/read-only/);
		expect(() => context.selectFile(pending, "write")).toThrow(/read-only/);
	},
);

test.skipIf(process.platform === "win32")(
	"an unresolved home link that traverses an ordinary directory still fails closed",
	async () => {
		symlinkSync("project/return", path.join(homeDir, ".cycle"));
		symlinkSync("../.cycle", path.join(homeDir, "project", "return"));
		const context = await SandboxContext.create(homeDir, {
			protectResources: true,
			sandboxMode: "workspace-write",
		});

		expect(context.selectFile(".existing", "read").identity).toBeTruthy();
		expect(() => workspacePathProtection(homeDir)).toThrow(/ELOOP/);
		expect(() => context.selectFile("project/ordinary", "write")).toThrow(
			/ELOOP/,
		);
	},
);

test.skipIf(process.platform === "win32")(
	"file tools revalidate new home links before updating a selected destination",
	async () => {
		const file = path.join(homeDir, "project", "current");
		writeFileSync(file, "initial");
		const old = path.join(homeDir, "project", "old");
		writeFileSync(old, "previous");
		const link = path.join(homeDir, ".user-settings");
		symlinkSync(old, link);
		const ctx = await SandboxContext.create(homeDir, {
			protectResources: true,
			sandboxMode: "workspace-write",
		});
		const bound = ctx.bindFiles([ctx.selectFile(file, "write")]);
		const delegated = createWorkspaceFiles(homeDir);
		expect(() => ctx.selectFile(old, "write")).toThrow(/read-only/);
		unlinkSync(link);
		symlinkSync(file, link);
		await ctx.writeSelectedFile(old, "ordinary");
		expect(readFileSync(old, "utf8")).toBe("ordinary");
		expect(bound.fileBindingsCurrent()).toBe(false);
		await expect(bound.writeSelectedFile(file, "changed")).rejects.toThrow(
			/read-only/,
		);
		await expect(
			delegated.update(file, "missing", () => "changed"),
		).rejects.toThrow(/read-only/);
		expect((await ctx.readSelectedFile(file)).toString()).toBe("initial");
	},
);

test.skipIf(process.platform === "win32")(
	"Linux home mount arguments keep dot directories and XDG ancestors read-only while exposing ordinary children",
	() => {
		const xdgConfig = path.join(homeDir, ".config", "codelia");
		const secret = path.join(xdgConfig, "credentials");
		const project = path.join(homeDir, "project");
		const state = path.join(fixture, "runsc-state");
		const external = path.join(fixture, "external");
		const projectLink = path.join(homeDir, "project-link");
		const externalLink = path.join(homeDir, "external-link");
		mkdirSync(secret, { recursive: true });
		mkdirSync(state, { recursive: true });
		mkdirSync(external);
		symlinkSync(project, projectLink);
		symlinkSync(external, externalLink);
		const args = linuxRunscMountArgs(
			{
				profile: "development",
				root: homeDir,
				cwd: homeDir,
				writeRoots: [homeDir],
				homeDotDirectory: homeDir,
				protectedPaths: [secret],
				readOnlyPaths: [xdgConfig],
				stdin: "closed",
			},
			state,
			[secret],
		);
		const mountIndex = (mode: string, target: string) =>
			args.findIndex(
				(arg, idx) =>
					arg === mode && args[idx + 1] === target && args[idx + 2] === target,
			);
		expect(mountIndex("--ro-bind", homeDir)).toBeGreaterThan(-1);
		expect(mountIndex("--bind", project)).toBeGreaterThan(-1);
		expect(mountIndex("--bind", projectLink)).toBe(-1);
		expect(mountIndex("--bind", externalLink)).toBe(-1);
		expect(mountIndex("--bind", external)).toBe(-1);
		expect(mountIndex("--bind", homeDir)).toBe(-1);
		expect(mountIndex("--bind", path.join(homeDir, ".config"))).toBe(-1);
		expect(mountIndex("--bind", path.join(homeDir, ".settings"))).toBe(-1);

		const approvedArgs = linuxRunscMountArgs(
			{
				profile: "development",
				root: homeDir,
				cwd: homeDir,
				writeRoots: [homeDir, path.join(homeDir, ".settings"), external],
				homeDotDirectory: homeDir,
				protectedPaths: [secret],
				readOnlyPaths: [xdgConfig],
				stdin: "closed",
			},
			state,
			[secret],
		);
		const approvedMountIndex = (mode: string, target: string) =>
			approvedArgs.findIndex(
				(arg, idx) =>
					arg === mode &&
					approvedArgs[idx + 1] === target &&
					approvedArgs[idx + 2] === target,
			);
		expect(
			approvedMountIndex("--bind", path.join(homeDir, ".settings")),
		).toBeGreaterThan(-1);
		expect(approvedMountIndex("--bind", external)).toBeGreaterThan(-1);
		expect(approvedMountIndex("--bind", externalLink)).toBe(-1);
		expect(approvedMountIndex("--bind", path.join(homeDir, ".config"))).toBe(
			-1,
		);
	},
);

test.skipIf(
	process.platform !== "linux" ||
		process.env.CODELIA_APPROVAL_LINUX_LIVE !== "1",
)("Linux home symlinks retain the write scope of their targets", async () => {
	const external = path.join(fixture, "external");
	mkdirSync(external);
	symlinkSync("project", path.join(homeDir, "workspace-link"));
	symlinkSync(external, path.join(homeDir, "external-link"));
	symlinkSync(".settings", path.join(homeDir, "settings-link"));
	const backend = new LinuxRunscBackend();
	const policy = protectionFor(homeDir);
	const child = backend.launch(
		fixedBash(`printf local > workspace-link/local || exit 2
if (printf outside > external-link/outside); then exit 3; fi
if (printf locked > settings-link/locked); then exit 4; fi
exit 0`),
		policy,
	);
	child.stdout.resume();
	child.stderr.resume();
	expect((await once(child, "close"))[0]).toBe(0);
	expect(readFileSync(path.join(homeDir, "project/local"), "utf8")).toBe(
		"local",
	);
	expect(existsSync(path.join(external, "outside"))).toBe(false);
	expect(existsSync(path.join(homeDir, ".settings/locked"))).toBe(false);

	const approved = backend.launch(
		fixedBash("printf approved > external-link/outside"),
		protectionFor(homeDir, [external]),
	);
	approved.stdout.resume();
	approved.stderr.resume();
	expect((await once(approved, "close"))[0]).toBe(0);
	expect(readFileSync(path.join(external, "outside"), "utf8")).toBe("approved");
});

const drivers = [
	"Seatbelt",
	...(process.env.CODELIA_APPROVAL_MXC_LIVE === "1" ? ["MXC"] : []),
];
test.skipIf(process.platform !== "darwin").each(drivers)(
	"%s enforces home exclusion by default and allows an explicitly approved dot write root",
	async (driver) => {
		const backend =
			driver === "MXC" ? createMacMxcShellBackend() : new MacSeatbeltBackend();
		symlinkSync("project/settings", path.join(homeDir, ".linked"));
		symlinkSync(".stale", path.join(homeDir, ".stale"));
		writeFileSync(path.join(homeDir, "project/settings"), "initial");
		const protection = protectionFor(fixture);
		expect(supportsProtectedShell(backend, protection)).toBe(true);
		const child = backend.launch(
			fixedBash(`test "$(cat .existing)" = data && echo yes > project/.allowed || exit 2
for target in .existing .future .settings/new Library/new project/settings; do
  if (echo no > "$target"); then exit 3; fi
done
exit 0`),
			protection,
		);
		child.stdout.resume();
		child.stderr.resume();
		expect((await once(child, "close"))[0]).toBe(0);
		expect(readFileSync(path.join(homeDir, "project/.allowed"), "utf8")).toBe(
			"yes\n",
		);
		expect(readFileSync(path.join(homeDir, ".existing"), "utf8")).toBe("data");
		expect(existsSync(path.join(homeDir, ".future"))).toBe(false);

		// Explicitly approved extra write root (.settings) is writable while other dot paths remain read-only.
		const approvedSettings = path.join(homeDir, ".settings");
		const withApprovedDot = protectionFor(homeDir, [approvedSettings]);
		const child2 = backend.launch(
			fixedBash(
				`echo approved > .settings/ok && if (echo no > .existing); then exit 4; fi`,
			),
			withApprovedDot,
		);
		child2.stdout.resume();
		child2.stderr.resume();
		expect((await once(child2, "close"))[0]).toBe(0);
		expect(readFileSync(path.join(approvedSettings, "ok"), "utf8")).toBe(
			"approved\n",
		);
		expect(readFileSync(path.join(homeDir, ".existing"), "utf8")).toBe("data");
	},
);

test.skipIf(typeof process.geteuid !== "function")(
	"Auto approve reviews additional_write_roots outside workspace and in home dot dirs, while blocking Codelia configDir",
	async () => {
		const prev = new Map<string, string | undefined>();
		const setEnv = (k: string, v: string | undefined) => {
			prev.set(k, process.env[k]);
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		};
		const fetcher = globalThis.fetch;
		const externalDir = path.join(fixture, "external-notes");
		const settingsDir = path.join(homeDir, ".settings");
		mkdirSync(externalDir, { recursive: true });
		try {
			setEnv("CODELIA_LAYOUT", "xdg");
			setEnv("XDG_CONFIG_HOME", path.join(fixture, "xdg-config"));
			setEnv("OPENAI_API_KEY", "fixture-review-key");
			const storage = resolveStoragePaths();
			mkdirSync(storage.configDir, { recursive: true, mode: 0o700 });
			writeFileSync(
				path.join(storage.configDir, "auto-review.json"),
				JSON.stringify({
					version: 3,
					enabled: true,
					mode: "pin",
					categories: ["local_shell"],
				}),
				{ mode: 0o600 },
			);

			const packets: Array<Record<string, unknown>> = [];
			const launches: ShellProtection[] = [];
			globalThis.fetch = Object.assign(
				async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
					const body = JSON.parse(String(init?.body));
					const packet = JSON.parse(body.input);
					packets.push(packet);
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
											decision: "allow_once",
											reason: "Matches user instruction",
										}),
									},
								],
							},
						],
					});
				},
				{ preconnect: fetcher.preconnect },
			) as typeof fetch;

			const state = new RuntimeState();
			state.setRuntimeEnvironment({
				environment: { preset: "tui-local" },
				adapters: {
					shellProtectionBackend: {
						...fixtureShellBackend,
						launch(invocation, protection) {
							launches.push(protection);
							return fixtureShellBackend.launch(invocation, protection);
						},
					},
				},
			});
			state.runtimeSandboxRoot = homeDir;
			state.runtimeWorkingDir = homeDir;
			state.sessionId = state.nextSessionId();
			runtimeLocalAutoReview(state).configuration(homeDir).enable();
			state.beginRun(
				"extra-write-review",
				null,
				"Update .settings/app.conf and write a note in ../external-notes.",
			);
			const authorize = authorizeRuntimeShell(state);

			// 1. Writing to a home dot-directory via additional_write_roots goes through Auto Review and succeeds.
			await authorize(
				{
					cwd: homeDir,
					origin: "parent_agent",
					source: "printf ok > .settings/app.conf",
					additionalWriteRoots: [settingsDir],
				},
				async (admit) => {
					const child = admit();
					child.stdout.resume();
					child.stderr.resume();
					expect((await once(child, "close"))[0]).toBe(0);
				},
			);
			expect(packets).toHaveLength(1);
			expect(
				(
					packets[0] as {
						evidence: {
							operation: { writeScope: { workspaceRelativeRoots: string[] } };
						};
					}
				).evidence.operation.writeScope.workspaceRelativeRoots,
			).toEqual([".", ".settings"]);

			// 2. Writing outside workspace via additional_write_roots goes through Auto Review and succeeds.
			await authorize(
				{
					cwd: homeDir,
					origin: "parent_agent",
					source: `printf note > ${path.join(externalDir, "note.txt")}`,
					additionalWriteRoots: [externalDir],
				},
				async (admit) => {
					const child = admit();
					child.stdout.resume();
					child.stderr.resume();
					expect((await once(child, "close"))[0]).toBe(0);
				},
			);
			expect(packets).toHaveLength(2);
			expect(launches).toHaveLength(2);

			// 3. Requesting Codelia's own configDir via additional_write_roots is hard-rejected before Auto Review.
			await expect(
				authorize(
					{
						cwd: homeDir,
						origin: "parent_agent",
						source: "touch config.json",
						additionalWriteRoots: [storage.configDir],
					},
					() => {
						throw new Error("unexpected launch");
					},
				),
			).rejects.toThrow("outside_authority_ceiling");
			expect(packets).toHaveLength(2);
		} finally {
			globalThis.fetch = fetcher;
			for (const [k, v] of prev) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	},
);
