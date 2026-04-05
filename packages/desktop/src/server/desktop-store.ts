import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStoragePaths } from "../../../storage/src/index";
import type { DesktopWorkspace } from "../shared/types";

type WorkspaceEntry = {
	path: string;
	last_opened_at: string;
	last_session_id?: string;
};

type SessionEntry = {
	workspace_path: string;
	title?: string;
	archived?: boolean;
	last_opened_at?: string;
};

type DesktopMetadataFile = {
	version: 1;
	workspaces: WorkspaceEntry[];
	sessions: Record<string, SessionEntry>;
};

const DEFAULT_DATA: DesktopMetadataFile = {
	version: 1,
	workspaces: [],
	sessions: {},
};

const nowIso = (): string => new Date().toISOString();

const normalizePath = (value: string): string => path.resolve(value.trim());

const dataFilePath = (): string => {
	const paths = resolveStoragePaths();
	return path.join(paths.configDir, "desktop.json");
};

const atomicWriteFile = async (
	filePath: string,
	content: string,
): Promise<void> => {
	const dirPath = path.dirname(filePath);
	const tempPath = path.join(
		dirPath,
		`.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
	);
	await fs.writeFile(tempPath, content, "utf8");
	await fs.rename(tempPath, filePath);
};

export class DesktopMetadataStore {
	private readonly filePath = dataFilePath();

	private async loadFile(): Promise<DesktopMetadataFile> {
		try {
			const raw = await fs.readFile(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as DesktopMetadataFile;
			if (
				parsed &&
				parsed.version === 1 &&
				Array.isArray(parsed.workspaces) &&
				parsed.sessions &&
				typeof parsed.sessions === "object"
			) {
				return parsed;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { ...DEFAULT_DATA };
			}
		}
		return { ...DEFAULT_DATA };
	}

	private async saveFile(data: DesktopMetadataFile): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		await atomicWriteFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
	}

	async listWorkspaces(): Promise<DesktopWorkspace[]> {
		const data = await this.loadFile();
		return data.workspaces
			.slice()
			.sort((a, b) => b.last_opened_at.localeCompare(a.last_opened_at))
			.map((entry) => ({
				path: entry.path,
				name: path.basename(entry.path) || entry.path,
				last_opened_at: entry.last_opened_at,
				last_session_id: entry.last_session_id,
			}));
	}

	async touchWorkspace(workspacePath: string): Promise<DesktopWorkspace> {
		const normalized = normalizePath(workspacePath);
		const data = await this.loadFile();
		const existing = data.workspaces.find((item) => item.path === normalized);
		const next: WorkspaceEntry = {
			path: normalized,
			last_opened_at: nowIso(),
			last_session_id: existing?.last_session_id,
		};
		data.workspaces = [
			next,
			...data.workspaces.filter((item) => item.path !== normalized),
		];
		await this.saveFile(data);
		return {
			path: next.path,
			name: path.basename(next.path) || next.path,
			last_opened_at: next.last_opened_at,
			last_session_id: next.last_session_id,
		};
	}

	async rememberLastSession(
		workspacePath: string,
		sessionId: string | undefined,
	): Promise<void> {
		if (!sessionId) return;
		const normalized = normalizePath(workspacePath);
		const data = await this.loadFile();
		const existing = data.workspaces.find((item) => item.path === normalized);
		const next: WorkspaceEntry = {
			path: normalized,
			last_opened_at: existing?.last_opened_at ?? nowIso(),
			last_session_id: sessionId,
		};
		data.workspaces = [
			next,
			...data.workspaces.filter((item) => item.path !== normalized),
		];
		await this.saveFile(data);
	}

	async readSessionEntry(sessionId: string): Promise<SessionEntry | undefined> {
		const data = await this.loadFile();
		return data.sessions[sessionId];
	}

	async writeSessionEntry(
		sessionId: string,
		update: Partial<SessionEntry>,
	): Promise<SessionEntry> {
		const data = await this.loadFile();
		const next: SessionEntry = {
			...(data.sessions[sessionId] ?? {}),
			...update,
			last_opened_at: nowIso(),
		};
		data.sessions[sessionId] = next;
		await this.saveFile(data);
		return next;
	}

	async listSessionEntries(): Promise<Record<string, SessionEntry>> {
		const data = await this.loadFile();
		return { ...data.sessions };
	}
}
