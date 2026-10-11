import { createHash } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
	WorktreeCreateParams,
	WorktreeCreateResult,
	WorktreeInfo,
	WorktreeListResult,
	WorktreeOperation,
} from "@codelia/protocol";
import { resolveStoragePaths } from "@codelia/storage";
import { type CommandRunner, runCommand } from "../lanes/command";
import { addGitWorktree, hasCheckoutFilters } from "./git";

type Project = {
	root: string;
	common: string;
	id: string;
	storage: string;
	checkout: string;
	repository: string;
};
const isMissing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT";

/** A runtime is bound to one real checkout; client cwd is never authority. */
export class WorktreeService {
	private readonly runner: CommandRunner;
	private readonly storageRoot: string;
	private scope?: { root: string; common: string; checkout: string };
	private readonly activeOperations = new Set<string>();
	constructor(
		private readonly workingDir: string,
		options: { runner?: CommandRunner; storageRoot?: string } = {},
	) {
		this.runner = options.runner ?? runCommand;
		this.storageRoot =
			options.storageRoot ?? path.join(resolveStoragePaths().root, "worktrees");
	}
	private async git(root: string, args: string[]): Promise<string> {
		return (
			await this.runner("git", [
				"-c",
				"core.fsmonitor=false",
				"-C",
				root,
				...args,
			])
		).stdout;
	}
	private async project(): Promise<Project> {
		const root = await realpath(
			(
				await this.git(this.workingDir, ["rev-parse", "--show-toplevel"])
			).trim(),
		);
		const common = await realpath(
			(
				await this.git(root, [
					"rev-parse",
					"--path-format=absolute",
					"--git-common-dir",
				])
			).trim(),
		);
		const id = createHash("sha256").update(common).digest("hex").slice(0, 24);
		const [rootStat, commonStat] = await Promise.all([
			stat(root, { bigint: true }),
			stat(common, { bigint: true }),
		]);
		const repository = createHash("sha256")
			.update(`${common}:${commonStat.dev}:${commonStat.ino}`)
			.digest("hex")
			.slice(0, 24);
		const checkout = createHash("sha256")
			.update(`${root}:${rootStat.dev}:${rootStat.ino}:${repository}`)
			.digest("hex")
			.slice(0, 24);
		if (
			this.scope &&
			(this.scope.root !== root ||
				this.scope.common !== common ||
				this.scope.checkout !== checkout)
		)
			throw new Error(
				"Workspace repository changed; reconnect and inspect before another operation",
			);
		this.scope ??= { root, common, checkout };
		return {
			root,
			common,
			id,
			checkout,
			repository,
			storage: path.join(this.storageRoot, id),
		};
	}
	private async readOperation(file: string): Promise<WorktreeOperation | null> {
		try {
			const bytes = await readFile(file);
			if (bytes.length > 32768) throw new Error("Oversized record");
			const op = JSON.parse(bytes.toString("utf8")) as WorktreeOperation;
			if (
				!op ||
				![
					"awaiting_confirmation",
					"creating",
					"ready",
					"failed",
					"cancelled",
				].includes(op.phase) ||
				![
					op.operation_id,
					op.title,
					op.base_ref,
					op.base_commit,
					op.thread_id,
					op.source_path,
					op.path,
					op.branch,
				].every((field) => typeof field === "string" && field.length <= 8192)
			)
				throw new Error("Malformed record");
			return op;
		} catch (error) {
			if (isMissing(error)) return null;
			throw new Error(
				"Worktree operation record is unreadable; automatic replay is blocked",
			);
		}
	}
	private reconcile(
		op: WorktreeOperation,
		worktrees: WorktreeInfo[],
	): WorktreeOperation {
		const pending =
			op.phase === "awaiting_confirmation" || op.phase === "creating";
		const present = worktrees.find((item) => item.path === op.path);
		if (
			(pending && !this.activeOperations.has(op.operation_id)) ||
			(op.phase === "ready" && !present?.available)
		) {
			return {
				...op,
				recorded_phase: op.phase as WorktreeOperation["recorded_phase"],
				phase: "unknown",
				error: pending
					? "An earlier runtime recorded an incomplete operation; inspect before making any new intent. Nothing is replayed."
					: "Recorded creation no longer matches an available Git worktree; inspect the preserved files and Git registration.",
			};
		}
		return op;
	}
	private async save(
		file: string,
		operation: WorktreeOperation,
	): Promise<void> {
		const temp = `${file}.tmp`;
		await writeFile(temp, `${JSON.stringify(operation)}\n`, { flag: "w" });
		await rename(temp, file);
	}
	private async listProject(project: Project): Promise<WorktreeListResult> {
		const raw = await this.git(project.root, [
			"worktree",
			"list",
			"--porcelain",
			"-z",
		]);
		const entries: Record<string, string>[] = [];
		let entry: Record<string, string> = {};
		for (const token of raw.split("\0")) {
			if (!token) {
				if (entry.worktree) entries.push(entry);
				entry = {};
				continue;
			}
			const split = token.indexOf(" ");
			entry[split < 0 ? token : token.slice(0, split)] =
				split < 0 ? "" : token.slice(split + 1);
		}
		if (entry.worktree) entries.push(entry);
		let operationDirs: string[] = [];
		try {
			operationDirs = await readdir(path.join(project.storage, "operations"));
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		// Bound response and IO. Older operations remain on disk, never removed.
		const operations: WorktreeOperation[] = [];
		for (const id of operationDirs.sort().slice(-100)) {
			if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) continue;
			try {
				const op = await this.readOperation(
					path.join(project.storage, "operations", id, "record.json"),
				);
				if (
					!op ||
					op.operation_id !== id ||
					op.path !== path.join(await realpath(project.storage), "trees", id) ||
					op.branch !== `codelia/worktree/${id}`
				)
					throw new Error("Invalid reservation");
				operations.push(op);
			} catch {
				operations.push({
					operation_id: id,
					title: "Unreadable operation",
					base_ref: "unknown",
					base_commit: "",
					thread_id: "unknown",
					source_path: project.root,
					path: path.join(project.storage, "trees", id),
					branch: `codelia/worktree/${id}`,
					phase: "unknown",
					error:
						"Operation record missing or unreadable; automatic replay is blocked",
				});
			}
		}
		const worktrees: WorktreeInfo[] = [];
		for (const entry of entries.slice(0, 100)) {
			const item: WorktreeInfo = {
				path: entry.worktree,
				branch: entry.branch?.replace(/^refs\/heads\//, "") ?? null,
				head: entry.HEAD ?? "",
				current: entry.worktree === project.root,
				available: false,
				dirty: null,
				changed_files: null,
				locked: "locked" in entry,
				prunable: "prunable" in entry,
				managed: operations.some((op) => op.path === entry.worktree),
			};
			try {
				const physical = await realpath(item.path);
				const common = await realpath(
					(
						await this.git(physical, [
							"rev-parse",
							"--path-format=absolute",
							"--git-common-dir",
						])
					).trim(),
				);
				if (common !== project.common)
					throw new Error("Checkout belongs to another repository");
				item.available = true;
				if (
					hasCheckoutFilters(
						await this.git(physical, ["config", "--name-only", "--list"]),
					)
				) {
					item.error =
						"Dirty status requires checkout filters; automatic scripts are disabled";
					worktrees.push(item);
					continue;
				}
				const status = await this.git(physical, [
					"status",
					"--porcelain=v1",
					"-z",
					"--untracked-files=normal",
				]);
				const records = status.split("\0").filter(Boolean);
				let count = 0;
				for (let i = 0; i < records.length; i++) {
					count++;
					if (records[i].slice(0, 2).match(/[RC]/)) i++;
				}
				item.available = true;
				item.dirty = count > 0;
				item.changed_files = count;
			} catch (error) {
				item.error = isMissing(error)
					? "Worktree folder is missing"
					: "Worktree status unavailable";
			}
			worktrees.push(item);
		}
		return {
			project_id: project.id,
			checkout_id: project.checkout,
			project_root: entries[0]?.worktree ?? project.root,
			current_path: project.root,
			worktrees,
			operations: operations.map((op) => this.reconcile(op, worktrees)),
		};
	}
	async list(): Promise<WorktreeListResult> {
		return this.listProject(await this.project());
	}
	async identity(): Promise<{
		project_id: string;
		checkout_id: string;
		root: string;
	}> {
		const project = await this.project();
		return {
			project_id: project.id,
			checkout_id: project.checkout,
			root: project.root,
		};
	}
	async create(
		input: WorktreeCreateParams,
		confirm: (operation: WorktreeOperation) => Promise<boolean>,
	): Promise<WorktreeCreateResult> {
		if (
			!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.operation_id) ||
			!input.title?.trim() ||
			[...input.title].length > 80 ||
			!input.thread_id ||
			Buffer.byteLength(input.thread_id, "utf8") > 256
		) {
			throw new Error(
				"Use a stable operation ID (1–64 lowercase letters/digits/hyphens), a 1–80 character title and an exact thread ID (1–256 bytes)",
			);
		}
		const base = input.base_ref?.trim() || "HEAD";
		if (base.length > 256 || base.startsWith("-") || /[\r\n\0]/.test(base))
			throw new Error("Invalid base ref");
		const project = await this.project();
		await mkdir(project.storage, { recursive: true });
		project.storage = await realpath(project.storage);
		const dir = path.join(project.storage, "operations", input.operation_id);
		const file = path.join(dir, "record.json");
		const repeat = async (
			existing: WorktreeOperation,
		): Promise<WorktreeCreateResult> => {
			if (
				existing.title !== input.title.trim() ||
				existing.base_ref !== base ||
				existing.thread_id !== input.thread_id ||
				existing.source_path !== project.root
			)
				throw new Error(
					"Operation ID already belongs to a different worktree request",
				);
			const worktree = (await this.listProject(project)).worktrees.find(
				(item) => item.path === existing.path,
			);
			return {
				operation: this.reconcile(existing, worktree ? [worktree] : []),
				...(worktree ? { worktree } : {}),
			};
		};
		const existing = await this.readOperation(file);
		if (existing) return repeat(existing);
		// Name-only config read: never log configuration values/credentials or run checkout scripts.
		const keys = await this.git(project.root, [
			"config",
			"--name-only",
			"--list",
		]);
		if (hasCheckoutFilters(keys))
			throw new Error(
				"Worktree creation requires repository checkout filters; automatic setup is disabled",
			);
		const commit = (
			await this.git(project.root, [
				"rev-parse",
				"--verify",
				"--end-of-options",
				`${base}^{commit}`,
			])
		).trim();
		const operation: WorktreeOperation = {
			operation_id: input.operation_id,
			title: input.title.trim(),
			base_ref: base,
			base_commit: commit,
			thread_id: input.thread_id,
			source_path: project.root,
			path: path.join(project.storage, "trees", input.operation_id),
			branch: `codelia/worktree/${input.operation_id}`,
			phase: "awaiting_confirmation",
		};
		await mkdir(path.dirname(dir), { recursive: true });
		try {
			await mkdir(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const raced = await this.readOperation(file);
			if (raced) return repeat(raced);
			throw new Error(
				"Worktree operation is being recorded; retry this same operation ID",
			);
		}
		await this.save(file, operation);
		this.activeOperations.add(operation.operation_id);
		try {
			if (!(await confirm(operation))) {
				operation.phase = "cancelled";
				await this.save(file, operation);
				return { operation };
			}
			operation.phase = "creating";
			// Source could have been replaced while the user inspected confirmation.
			await this.project();
			await this.save(file, operation);
			await mkdir(path.dirname(operation.path), { recursive: true });
			await addGitWorktree(this.runner, {
				root: project.root,
				branch: operation.branch,
				path: operation.path,
				base: commit,
				safeCheckout: true,
			});
			operation.phase = "ready";
			await this.save(file, operation);
		} catch {
			operation.phase = "failed";
			operation.error =
				"Creation failed; existing branches and files are preserved. Inspect this operation before making a new request.";
			await this.save(file, operation);
		} finally {
			this.activeOperations.delete(operation.operation_id);
		}
		return {
			operation,
			worktree: (await this.listProject(project)).worktrees.find(
				(item) => item.path === operation.path,
			),
		};
	}
}
