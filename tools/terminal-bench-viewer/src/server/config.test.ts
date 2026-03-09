import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadViewerConfig } from "./config";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("loadViewerConfig", () => {
	it("resolves jobs_dir relative to the config file", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tbv-config-"));
		tempDirs.push(tempRoot);
		await writeFile(
			path.join(tempRoot, "config.json"),
			JSON.stringify({ jobs_dir: "../../jobs" }),
			"utf8",
		);

		const config = await loadViewerConfig(tempRoot);
		expect(config.jobsDir).toBe(path.resolve(tempRoot, "../../jobs"));
		expect(config.configFiles).toEqual([path.join(tempRoot, "config.json")]);
	});

	it("prefers config.local.json when present", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tbv-config-local-"));
		tempDirs.push(tempRoot);
		await mkdir(path.join(tempRoot, "data"), { recursive: true });
		await writeFile(
			path.join(tempRoot, "config.json"),
			JSON.stringify({ jobs_dir: "./data/base" }),
			"utf8",
		);
		await writeFile(
			path.join(tempRoot, "config.local.json"),
			JSON.stringify({ jobs_dir: "./data/local" }),
			"utf8",
		);

		const config = await loadViewerConfig(tempRoot);
		expect(config.jobsDir).toBe(path.join(tempRoot, "data/local"));
		expect(config.configFiles).toEqual([
			path.join(tempRoot, "config.json"),
			path.join(tempRoot, "config.local.json"),
		]);
	});
});
