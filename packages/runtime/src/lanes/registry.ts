import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStoragePaths } from "@codelia/storage";
import type { LaneRecord } from "./types";

type LaneRegistryFile = {
	version: 1;
	lanes: LaneRecord[];
};

const REGISTRY_DIRNAME = "lanes";
const REGISTRY_FILENAME = "registry.json";

const nowIso = (): string => new Date().toISOString();

const sortByUpdatedDesc = (lanes: LaneRecord[]): LaneRecord[] =>
	[...lanes].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

const readJsonFile = async (
	filePath: string,
): Promise<LaneRegistryFile | null> => {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as Partial<LaneRegistryFile>;
		if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.lanes)) {
			return null;
		}
		return {
			version: 1,
			lanes: parsed.lanes as LaneRecord[],
		};
	} catch {
		return null;
	}
};

const atomicWrite = async (
	filePath: string,
	payload: string,
): Promise<void> => {
	const dir = path.dirname(filePath);
	const base = path.basename(filePath);
	const tmp = path.join(
		dir,
		`${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	await fs.writeFile(tmp, payload, "utf8");
	await fs.rename(tmp, filePath);
};

export class LaneRegistryStore {
	private readonly registryPath: string;

	constructor(registryPath?: string) {
		if (registryPath) {
			this.registryPath = registryPath;
			return;
		}
		const root = resolveStoragePaths().root;
		this.registryPath = path.join(root, REGISTRY_DIRNAME, REGISTRY_FILENAME);
	}

	private async ensureDir(): Promise<void> {
		await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
	}

	private async readAll(): Promise<LaneRecord[]> {
		await this.ensureDir();
		const data = await readJsonFile(this.registryPath);
		if (!data) return [];
		return sortByUpdatedDesc(data.lanes);
	}

	private async writeAll(lanes: LaneRecord[]): Promise<void> {
		await this.ensureDir();
		const payload: LaneRegistryFile = {
			version: 1,
			lanes: sortByUpdatedDesc(lanes),
		};
		await atomicWrite(
			this.registryPath,
			`${JSON.stringify(payload, null, 2)}\n`,
		);
	}

	async list(): Promise<LaneRecord[]> {
		return this.readAll();
	}

	async get(laneId: string): Promise<LaneRecord | null> {
		const lanes = await this.readAll();
		return lanes.find((lane) => lane.lane_id === laneId) ?? null;
	}

	async upsert(record: LaneRecord): Promise<void> {
		const lanes = await this.readAll();
		const idx = lanes.findIndex((lane) => lane.lane_id === record.lane_id);
		const next = {
			...record,
			updated_at: nowIso(),
		};
		if (idx >= 0) {
			lanes[idx] = next;
		} else {
			lanes.push(next);
		}
		await this.writeAll(lanes);
	}

	async patch(
		laneId: string,
		patch: Partial<Omit<LaneRecord, "lane_id" | "created_at">>,
	): Promise<LaneRecord | null> {
		const lanes = await this.readAll();
		const idx = lanes.findIndex((lane) => lane.lane_id === laneId);
		if (idx < 0) return null;
		const current = lanes[idx];
		const next: LaneRecord = {
			...current,
			...patch,
			lane_id: current.lane_id,
			created_at: current.created_at,
			updated_at: nowIso(),
		};
		lanes[idx] = next;
		await this.writeAll(lanes);
		return next;
	}
}
