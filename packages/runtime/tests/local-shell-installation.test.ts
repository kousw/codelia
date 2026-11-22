import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApprovalDispatcher } from "../src/permissions/dispatch";
import {
	localShellInstallPaths,
	protectsAdditionalWritePaths,
} from "../src/permissions/local-shell-installation";
import { createShellAuthorizer } from "../src/permissions/shell-approval";
import type { ShellChild } from "../src/permissions/shell-backend";

test.skipIf(process.platform === "win32")(
	"extra writes reserve installed release paths and the MXC launcher before approval",
	async () => {
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-release-write-")),
		);
		try {
			const workspace = path.join(root, "workspace");
			const checkout = path.join(
				workspace,
				"packages",
				"runtime",
				"src",
				"permissions",
			);
			const prefix = path.join(root, "prefix");
			const packageScope = path.join(prefix, "node_modules", "@codelia");
			const cli = path.join(packageScope, "cli");
			const runtime = path.join(cli, "node_modules", "@codelia", "runtime");
			const dist = path.join(runtime, "dist");
			const storage = path.join(cli, "node_modules", "@codelia", "storage");
			const thirdParty = path.join(cli, "node_modules", "third-party");
			const alias = path.join(root, "release-link");
			const launcherDir = path.join(root, "local-build", "release");
			const launcher = path.join(launcherDir, "codelia-mxc-launcher");
			const unrelated = path.join(root, "notes");
			for (const directory of [
				checkout,
				dist,
				storage,
				thirdParty,
				launcherDir,
				unrelated,
			])
				mkdirSync(directory, { recursive: true });
			writeFileSync(
				path.join(runtime, "package.json"),
				JSON.stringify({ dependencies: { "@codelia/storage": "1.0.0" } }),
			);
			writeFileSync(path.join(storage, "package.json"), "{}");
			writeFileSync(path.join(thirdParty, "package.json"), "{}");
			writeFileSync(launcher, "fixture");
			symlinkSync(dist, alias);
			expect(localShellInstallPaths(dist)).toEqual([cli]);
			expect(localShellInstallPaths(checkout)).toEqual([]);

			let confirmations = 0;
			let reviews = 0;
			let autoReview = true;
			const launches: (readonly string[])[] = [];
			const authorize = createShellAuthorizer({
				root: workspace,
				autoReviewEnabled: () => autoReview,
				allowsAdditionalWrite: (_protection, additional) =>
					protectsAdditionalWritePaths(additional, [
						...localShellInstallPaths(dist),
						launcher,
					]),
				authority: {
					investigation: true,
					workspaceWrite: "granted",
					stdinPipe: "forbid",
					extraWriteCeiling: [root],
				},
				backend: {
					supportsReadOnlyPaths: true,
					supportsHomeDotProtection: true,
					supports: () => true,
					launch: (_invocation, protection) => {
						launches.push(protection.writeRoots);
						return {} as ShellChild;
					},
				},
				dispatcher: new ApprovalDispatcher({
					confirmation: {
						confirm: async ({ requestId }) => {
							confirmations++;
							return { requestId, choice: "allow_once" };
						},
					},
					review: {
						categories: ["local_shell"],
						buildEvidence: async () => {
							reviews++;
							return "Allow the notes fixture.";
						},
						review: async (_packet, _signal, { id }) => ({
							request_id: id,
							decision: "allow_once",
							reason: "Matches the notes fixture.",
						}),
					},
				}),
			});
			const request = (additional: string) =>
				authorize(
					{
						argv: [process.execPath, "--version"],
						cwd: workspace,
						origin: "parent_agent",
						additionalWriteRoots: [additional],
					},
					(admit) => admit(),
				);
			for (const additional of [
				runtime,
				dist,
				prefix,
				storage,
				thirdParty,
				alias,
				launcherDir,
			])
				await expect(request(additional)).rejects.toThrow(
					"outside_authority_ceiling",
				);
			expect({ confirmations, reviews, launches }).toEqual({
				confirmations: 0,
				reviews: 0,
				launches: [],
			});

			await request(unrelated);
			expect(reviews).toBe(1);
			expect(confirmations).toBe(0);
			autoReview = false;
			await request(unrelated);
			expect(confirmations).toBe(1);
			expect(launches).toEqual([
				[workspace, unrelated],
				[workspace, unrelated],
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a flat pnpm installation covers both dependency names and their store paths",
	() => {
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-flat-install-")),
		);
		try {
			const modules = path.join(root, "node_modules");
			const store = path.join(modules, ".pnpm");
			const runtime = path.join(
				store,
				"@codelia+runtime@1.0.0",
				"node_modules",
				"@codelia",
				"runtime",
			);
			const dist = path.join(runtime, "dist");
			const dependency = path.join(
				store,
				"third-party@1.0.0",
				"node_modules",
				"third-party",
			);
			const alias = path.join(modules, "third-party");
			mkdirSync(dist, { recursive: true });
			mkdirSync(dependency, { recursive: true });
			writeFileSync(path.join(runtime, "package.json"), "{}");
			symlinkSync(dependency, alias);
			const reserved = localShellInstallPaths(dist);
			expect(reserved).toEqual([modules]);
			expect(
				protectsAdditionalWritePaths([realpathSync(alias)], reserved),
			).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
