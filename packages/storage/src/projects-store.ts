import { promises as fs } from "node:fs";
import path from "node:path";
import type { StoragePaths } from "@codelia/core";
import {
	parseApprovalMode,
	type ApprovalMode,
} from "@codelia/shared-types";
import { ensureStorageDirs, resolveStoragePaths } from "./paths";

export type ProjectsPolicyFile = {
	version: 1;
	default?: {
		approval_mode?: ApprovalMode;
	};
	projects?: Record<
		string,
		{
			approval_mode?: ApprovalMode;
		}
	>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const parseApprovalModeField = (
	fieldPath: string,
	value: unknown,
): ApprovalMode => {
	const parsed = parseApprovalMode(value);
	if (!parsed) {
		throw new Error(`${fieldPath} is invalid`);
	}
	return parsed;
};

const normalizeProjectsPolicyFile = (value: unknown): ProjectsPolicyFile => {
	if (!isRecord(value)) {
		throw new Error("projects policy must be an object");
	}
	if (value.version !== 1) {
		throw new Error("projects policy version must be 1");
	}

	const normalized: ProjectsPolicyFile = { version: 1 };
	const defaultValue = value.default;
	if (defaultValue !== undefined) {
		if (!isRecord(defaultValue)) {
			throw new Error("projects policy default must be an object");
		}
		if (defaultValue.approval_mode !== undefined) {
			normalized.default = {
				approval_mode: parseApprovalModeField(
					"projects policy default.approval_mode",
					defaultValue.approval_mode,
				),
			};
		}
	}

	const projectsValue = value.projects;
	if (projectsValue !== undefined) {
		if (!isRecord(projectsValue)) {
			throw new Error("projects policy projects must be an object");
		}
		const entries: Record<string, { approval_mode?: ApprovalMode }> = {};
		for (const [key, projectValue] of Object.entries(projectsValue)) {
			if (!isRecord(projectValue)) {
				throw new Error(`projects policy projects['${key}'] must be an object`);
			}
			if (projectValue.approval_mode !== undefined) {
				entries[key] = {
					approval_mode: parseApprovalModeField(
						`projects policy projects['${key}'].approval_mode`,
						projectValue.approval_mode,
					),
				};
			}
		}
		if (Object.keys(entries).length > 0) {
			normalized.projects = entries;
		}
	}
	return normalized;
};

const atomicWriteFile = async (filePath: string, content: string): Promise<void> => {
	const dirPath = path.dirname(filePath);
	const fileName = path.basename(filePath);
	const tempPath = path.join(
		dirPath,
		`.${fileName}.${process.pid}.${Date.now()}.tmp`,
	);
	await fs.writeFile(tempPath, content, { mode: 0o600 });
	await fs.rename(tempPath, filePath);
	if (process.platform !== "win32") {
		await fs.chmod(filePath, 0o600);
	}
};

export class ProjectsPolicyStore {
	private readonly paths: StoragePaths;

	constructor(paths?: StoragePaths) {
		this.paths = paths ?? resolveStoragePaths();
	}

	getFilePath(): string {
		return this.paths.projectsFile;
	}

	async load(): Promise<ProjectsPolicyFile | null> {
		try {
			const raw = await fs.readFile(this.paths.projectsFile, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			return normalizeProjectsPolicyFile(parsed);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return null;
			}
			throw error;
		}
	}

	async save(data: ProjectsPolicyFile): Promise<void> {
		if (data.version !== 1) {
			throw new Error("projects policy version must be 1");
		}
		await ensureStorageDirs(this.paths);
		const content = `${JSON.stringify(data, null, 2)}\n`;
		await atomicWriteFile(this.paths.projectsFile, content);
	}
}

