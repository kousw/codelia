import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectsPolicyStore, resolveStoragePaths } from "../src";

describe("ProjectsPolicyStore", () => {
	test("resolveStoragePaths includes projects file", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-storage-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			expect(paths.projectsFile).toBe(path.join(root, "projects.json"));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("save/load roundtrip keeps valid approval policy entries", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-projects-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const store = new ProjectsPolicyStore(paths);
			await store.save({
				version: 1,
				default: { approval_mode: "minimal" },
				projects: {
					"/repo/a": { approval_mode: "trusted" },
				},
			});
			const loaded = await store.load();
			expect(loaded).toEqual({
				version: 1,
				default: { approval_mode: "minimal" },
				projects: {
					"/repo/a": { approval_mode: "trusted" },
				},
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("load throws for invalid approval mode entries", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-projects-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			await fs.mkdir(path.dirname(paths.projectsFile), { recursive: true });
			await fs.writeFile(
				paths.projectsFile,
				JSON.stringify(
					{
						version: 1,
						default: { approval_mode: "not-valid" },
						projects: {
							"/repo/a": { approval_mode: "trusted" },
						},
					},
					null,
					2,
				),
				"utf8",
			);
			const store = new ProjectsPolicyStore(paths);
			await expect(store.load()).rejects.toThrow(
				"projects policy default.approval_mode is invalid",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("load throws for invalid JSON", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-projects-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			await fs.mkdir(path.dirname(paths.projectsFile), { recursive: true });
			await fs.writeFile(paths.projectsFile, '{"version":1', "utf8");
			const store = new ProjectsPolicyStore(paths);
			await expect(store.load()).rejects.toThrow();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
