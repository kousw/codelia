import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectsPolicyStore } from "@codelia/storage";
import {
	getProjectAllowTrust,
	localAllowStillCurrent,
	resolveLocalPermissionAllows,
	setProjectAllowTrust,
} from "../src/local-permission-allows";
import { RuntimeState } from "../src/runtime-state";

let base: string;
let workspace: string;
let config: string;
let state: RuntimeState;
let store: ProjectsPolicyStore;
let savedEnv: Record<string, string | undefined>;
const projectRule = { tool: "shell", command: "cargo test" };
const personalRule = { tool: "webfetch" };
const configWith = (...allow: unknown[]) =>
	JSON.stringify({ version: 1, permissions: { allow } });

beforeEach(async () => {
	base = await realpath(
		await mkdtemp(path.join(os.tmpdir(), "codelia-trust-")),
	);
	workspace = path.join(base, "workspace");
	config = path.join(workspace, ".codelia", "config.json");
	await mkdir(path.dirname(config), { recursive: true });
	savedEnv = {};
	for (const [key, value] of Object.entries({
		CODELIA_LAYOUT: "xdg",
		XDG_CONFIG_HOME: path.join(base, "config"),
		CODELIA_CONFIG_PATH: path.join(base, "personal.json"),
	})) {
		savedEnv[key] = process.env[key];
		process.env[key] = value;
	}
	state = new RuntimeState();
	store = new ProjectsPolicyStore();
	await writeFile(
		path.join(base, "personal.json"),
		configWith(
			personalRule,
			{ tool: "shell", command: 2 },
			{ tool: "webfetch", url: "example.org" },
		),
	);
	await writeFile(config, configWith(projectRule));
});
afterEach(async () => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(base, { recursive: true, force: true });
});

test.skipIf(!process.geteuid)(
	"old project trust is inherited, scoped and explicitly revocable",
	async () => {
		const rules = () => resolveLocalPermissionAllows(state, workspace);
		expect(await rules()).toEqual([personalRule]);
		await store.writeProjectMode(workspace, "workspace-write");
		expect(await rules()).toEqual([personalRule]);
		await writeFile(
			store.getFilePath(),
			JSON.stringify({
				version: 1,
				projects: {
					[workspace]: {
						approval_mode: "trusted",
						protected_paths: [path.join(base, "private")],
					},
				},
			}),
		);
		expect(await rules()).toEqual([personalRule, projectRule]);
		const other = path.join(base, "sibling");
		await mkdir(path.join(other, ".codelia"), { recursive: true });
		await writeFile(
			path.join(other, ".codelia", "config.json"),
			configWith(projectRule),
		);
		expect(await resolveLocalPermissionAllows(state, other)).toEqual([
			personalRule,
		]);
		const previous = await getProjectAllowTrust(state, workspace);
		await setProjectAllowTrust(state, workspace, false, previous.revision);
		expect(await rules()).toEqual([personalRule]);
		expect((await store.load())?.projects?.[workspace]).toMatchObject({
			approval_mode: "trusted",
			trust_project_allows: false,
			protected_paths: [path.join(base, "private")],
		});
		const next = await getProjectAllowTrust(state, workspace);
		await writeFile(config, configWith(projectRule, { tool: "search" }));
		await expect(
			setProjectAllowTrust(state, workspace, true, next.revision),
		).rejects.toThrow("project_allow_trust_changed");
		await setProjectAllowTrust(
			state,
			workspace,
			true,
			(await getProjectAllowTrust(state, workspace)).revision,
		);
		await writeFile(config, configWith({ tool: "view_image" }));
		expect(
			await resolveLocalPermissionAllows(new RuntimeState(), workspace),
		).toEqual([personalRule, { tool: "view_image" }]);
	},
);

test.skipIf(!process.geteuid)(
	"old defaults and flags retain scope, explicit project untrust wins",
	async () => {
		await store.writeProjectMode(workspace, "readonly");
		await writeFile(
			store.getFilePath(),
			JSON.stringify({ version: 1, default: { approval_mode: "trusted" } }),
		);
		const status = () => getProjectAllowTrust(state, workspace);
		expect((await status()).trusted).toBe(true);
		state.sandboxMode = {
			value: "workspace-write",
			source: "cli",
			legacy: "full-access",
		};
		expect((await status()).trusted).toBe(false);
		state.sandboxMode = { value: "readonly", source: "env", legacy: "minimal" };
		expect((await status()).trusted).toBe(false);
		state.sandboxMode = {
			value: "workspace-write",
			source: "cli",
			legacy: "trusted",
		};
		expect((await status()).trusted).toBe(true);
		await setProjectAllowTrust(
			state,
			workspace,
			false,
			(await status()).revision,
		);
		expect((await status()).trusted).toBe(false);
	},
);

test.skipIf(!process.geteuid)(
	"redirecting personal config into checkout does not activate shared allows",
	async () => {
		const alias = path.join(base, "personal-alias");
		await symlink(config, alias);
		process.env.CODELIA_CONFIG_PATH = alias;
		expect(await resolveLocalPermissionAllows(state, workspace)).toEqual([]);
		process.env.CODELIA_CONFIG_PATH = config;
		expect(await resolveLocalPermissionAllows(state, workspace)).toEqual([]);
	},
);

test.skipIf(!process.geteuid)(
	"cached positive rules lose authority if their private directory becomes writable by others",
	async () => {
		const privateDir = path.join(base, "private-config");
		await mkdir(privateDir, { mode: 0o700 });
		const personal = path.join(privateDir, "config.json");
		process.env.CODELIA_CONFIG_PATH = personal;
		await writeFile(personal, configWith(personalRule));
		const initial = await getProjectAllowTrust(state, workspace);
		await setProjectAllowTrust(state, workspace, true, initial.revision);
		const [user, project] = await resolveLocalPermissionAllows(
			state,
			workspace,
		);
		expect(localAllowStillCurrent(user)).toBe(true);
		expect(localAllowStillCurrent(project)).toBe(true);
		await chmod(privateDir, 0o770);
		expect(localAllowStillCurrent(user)).toBe(false);
		expect(await resolveLocalPermissionAllows(state, workspace)).toEqual([
			projectRule,
		]);
		await chmod(path.dirname(store.getFilePath()), 0o770);
		expect(localAllowStillCurrent(project)).toBe(false);
		expect(await resolveLocalPermissionAllows(state, workspace)).toEqual([]);
	},
);

test.skipIf(!process.geteuid)(
	"a home workspace reads its reserved personal config once and rejects redirects",
	async () => {
		const home = path.join(base, "home");
		const dir = path.join(home, ".codelia");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		// Bun captures os.homedir() at startup. Exercise an isolated real home.
		const read = () => {
			const child = Bun.spawnSync(
				[
					process.execPath,
					"-e",
					`
				import { RuntimeState } from "./src/runtime-state";
				import { resolveLocalPermissionAllows } from "./src/local-permission-allows";
				const state = new RuntimeState();
				state.sandboxMode = {value:"workspace-write", source:"cli", legacy:"trusted"};
				console.log(JSON.stringify(await resolveLocalPermissionAllows(state, process.env.HOME)));
			`,
				],
				{
					cwd: path.resolve(import.meta.dir, ".."),
					env: {
						...process.env,
						HOME: home,
						CODELIA_LAYOUT: "home",
						CODELIA_CONFIG_PATH: "",
					},
				},
			);
			expect(child.exitCode).toBe(0);
			return JSON.parse(child.stdout.toString());
		};
		const standard = path.join(dir, "config.json");
		await writeFile(standard, configWith(personalRule), { mode: 0o600 });
		expect(read()).toEqual([personalRule]);
		await rm(standard);
		await symlink(config, standard);
		expect(read()).toEqual([]);
	},
);
