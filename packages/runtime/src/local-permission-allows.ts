import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
	CONFIG_VERSION,
	normalizePermissionRule,
	type PermissionRule,
} from "@codelia/config";
import {
	isSameConfigFilePath,
	isTrustedGlobalConfigLocationSync,
	ProjectsPolicyStore,
	resolveStoragePaths,
} from "@codelia/storage";
import { resolveConfigPath, resolveProjectConfigPath } from "./config";
import type { RuntimeState } from "./runtime-state";

// Approval is opt-in. A malformed or unknown restriction must never be
// normalized away and accidentally turn a scoped rule into a blanket allow.
function parseAllow(entry: unknown): PermissionRule | undefined {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
	const rule = normalizePermissionRule(entry);
	if (!rule || !Object.keys(entry).every((key) => Object.hasOwn(rule, key)))
		return;
	return Object.freeze(rule);
}

function fileRevision(file: string): string {
	const stat = statSync(file, { bigint: true, throwIfNoEntry: false });
	return stat
		? [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join(":")
		: "missing";
}

function parseAllows(text: string): PermissionRule[] {
	try {
		const config = JSON.parse(text);
		if (
			config?.version !== CONFIG_VERSION ||
			!Array.isArray(config?.permissions?.allow)
		)
			return [];
		return config.permissions.allow
			.map(parseAllow)
			.filter((entry: PermissionRule | undefined) => entry !== undefined);
	} catch {
		return [];
	}
}

function projectAllows(file: string): PermissionRule[] {
	try {
		return statSync(file, { throwIfNoEntry: false })?.isFile()
			? parseAllows(readFileSync(file, "utf8"))
			: [];
	} catch {
		return [];
	}
}

function isLocal(state: RuntimeState): boolean {
	const env = state.effectiveEnvironment;
	return (
		env.sourcePreset === "tui-local" && env.config.source === "runtime-default"
	);
}

export const configurableToolInvocations: ReadonlySet<string> = new Set([
	"webfetch",
	"search",
	"view_image",
	"image_export",
	"task_cancel_all",
]);

function inheritedTrust(
	state: RuntimeState,
	storedMode: string | undefined,
): boolean {
	const mode = state.sandboxMode;
	const legacy =
		mode.source === "cli" || mode.source === "env"
			? (mode.legacy ?? storedMode)
			: storedMode;
	return legacy === "trusted";
}

// File contents are already versioned by policy-index. This binding also
// invalidates permission when a path stops meeting the private-directory checks.
function privateLocationRevision(file: string): string {
	try {
		const entry = lstatSync(file, { bigint: true, throwIfNoEntry: false });
		if (!entry) return "missing";
		const dirs = new Set<string>();
		const parent = path.dirname(file);
		for (let dir of [parent, realpathSync(parent)]) {
			while (!dirs.has(dir)) {
				dirs.add(dir);
				dir = path.dirname(dir);
			}
		}
		const stamps = Array.from(dirs, (dir) => {
			const st = statSync(dir, { bigint: true });
			return [dir, st.dev, st.ino, st.uid, st.mode].join(":");
		});
		return JSON.stringify([
			String(entry.dev),
			String(entry.ino),
			String(entry.ctimeNs),
			...stamps,
		]);
	} catch {
		return "unavailable";
	}
}

const bindings = new WeakMap<PermissionRule, () => boolean>();
export const localAllowStillCurrent = (rule: PermissionRule): boolean =>
	bindings.get(rule)?.() ?? true;

export function localPermissionAllowRevision(
	state: RuntimeState,
	root: string,
): string {
	if (!isLocal(state)) return "";
	const store = resolveStoragePaths().projectsFile;
	return JSON.stringify([
		root,
		store,
		fileRevision(store),
		state.sandboxMode.source,
		state.sandboxMode.legacy,
	]);
}

function projectRevision(state: RuntimeState, root: string): string {
	const canonical = realpathSync(root);
	const dir = statSync(canonical, { bigint: true });
	return createHash("sha256")
		.update(
			JSON.stringify([
				canonical,
				String(dir.dev),
				String(dir.ino),
				fileRevision(resolveProjectConfigPath(canonical)),
				localPermissionAllowRevision(state, canonical),
				privateLocationRevision(resolveStoragePaths().projectsFile),
			]),
		)
		.digest("hex");
}

export async function getProjectAllowTrust(state: RuntimeState, root: string) {
	if (!isLocal(state)) throw new Error("project_allow_trust_unavailable");
	const canonical = realpathSync(root);
	const revision = projectRevision(state, canonical);
	const store = new ProjectsPolicyStore();
	const policy = await store.loadUserOwned(canonical);
	const project = policy?.projects?.[canonical];
	const trustworthyStore =
		policy !== null || fileRevision(store.getFilePath()) === "missing";
	const trusted =
		trustworthyStore &&
		(project?.trust_project_allows ??
			inheritedTrust(
				state,
				project?.approval_mode ?? policy?.default?.approval_mode,
			));
	const projectFile = resolveProjectConfigPath(canonical);
	const globalFile = resolveConfigPath();
	const sharedTrustedGlobal =
		isSameConfigFilePath(globalFile, projectFile) &&
		isTrustedGlobalConfigLocationSync(canonical, globalFile);
	const rules = sharedTrustedGlobal ? [] : projectAllows(projectFile);
	if (projectRevision(state, root) !== revision)
		throw new Error("project_allow_trust_changed");
	const remembered = (project?.remembered_tool_allows ?? []).filter(
		({ tool }) => configurableToolInvocations.has(tool),
	);
	return { trusted, rules, revision, remembered };
}

export async function setProjectAllowTrust(
	state: RuntimeState,
	root: string,
	trusted: boolean,
	expectedRevision: string,
): Promise<void> {
	if (!isLocal(state)) throw new Error("project_allow_trust_unavailable");
	const canonical = realpathSync(root);
	const verify = () => {
		if (projectRevision(state, root) !== expectedRevision)
			throw new Error("project_allow_trust_changed");
	};
	verify();
	await new ProjectsPolicyStore().writeProjectAllowTrust(
		canonical,
		trusted,
		verify,
	);
}

export async function resolveLocalPermissionAllows(
	state: RuntimeState,
	root: string,
): Promise<readonly PermissionRule[]> {
	if (!isLocal(state)) return [];
	const canonical = realpathSync(root);
	const file = resolveConfigPath();
	const store = new ProjectsPolicyStore();
	const projectBinding = privateLocationRevision(store.getFilePath());
	const personalBinding = privateLocationRevision(file);
	const projectCurrent = () =>
		privateLocationRevision(store.getFilePath()) === projectBinding;
	const personalCurrent = () =>
		privateLocationRevision(file) === personalBinding;
	let personal: PermissionRule[] = [];
	if (personalBinding !== "missing" && process.geteuid) {
		try {
			const text = await store.readUserConfig(canonical, file);
			if (text !== undefined && personalCurrent()) personal = parseAllows(text);
		} catch {
			/* An unverified personal config conveys no authority. */
		}
	}
	const project = await getProjectAllowTrust(state, canonical);
	const projectRules = [
		...project.remembered,
		...(project.trusted ? project.rules : []),
	];
	if (!projectCurrent()) throw new Error("project_allow_trust_changed");
	for (const rule of personal) bindings.set(rule, personalCurrent);
	for (const rule of projectRules) bindings.set(rule, projectCurrent);
	return [...personal, ...projectRules];
}
