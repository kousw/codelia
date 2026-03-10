import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ViewerConfigResolved } from "../shared/types";

const viewerConfigSchema = z.object({
	jobs_dir: z.string().min(1),
});

type ViewerConfigFile = z.infer<typeof viewerConfigSchema>;

const resolveToolRoot = () => path.resolve(import.meta.dir, "../..");

const loadConfigFile = async (
	filePath: string,
	required: boolean,
): Promise<ViewerConfigFile | null> => {
	try {
		const raw = await readFile(filePath, "utf8");
		return viewerConfigSchema.parse(JSON.parse(raw));
	} catch (error) {
		if (!required) {
			return null;
		}
		throw new Error(
			`failed to load ${path.basename(filePath)}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
};

const fileExists = async (filePath: string) => {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
};

const resolveJobsDir = (filePath: string, jobsDir: string) =>
	path.isAbsolute(jobsDir)
		? jobsDir
		: path.resolve(path.dirname(filePath), jobsDir);

export const loadViewerConfig = async (
	toolRoot = resolveToolRoot(),
): Promise<ViewerConfigResolved> => {
	const configPath = path.join(toolRoot, "config.json");
	const localConfigPath = path.join(toolRoot, "config.local.json");
	const base = await loadConfigFile(configPath, true);
	const local = (await fileExists(localConfigPath))
		? await loadConfigFile(localConfigPath, false)
		: null;

	const effective = local ?? base;
	if (!effective) {
		throw new Error("no viewer config could be resolved");
	}
	const effectiveSourcePath = local ? localConfigPath : configPath;

	return {
		jobsDir: resolveJobsDir(effectiveSourcePath, effective.jobs_dir),
		configFiles: local ? [configPath, localConfigPath] : [configPath],
	};
};
