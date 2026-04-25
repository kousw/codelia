import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electrobun/bun";
import { resolveStoragePaths } from "../../../storage/src/index";

export type WindowFrame = {
	x: number;
	y: number;
	width: number;
	height: number;
};

type WindowStateFile = {
	version: 1;
	frame: WindowFrame;
	maximized: boolean;
};

const SAVE_DEBOUNCE_MS = 400;
const MIN_WINDOW_WIDTH = 800;
const MIN_WINDOW_HEIGHT = 600;

const windowStateFilePath = (): string => {
	const paths = resolveStoragePaths();
	return path.join(paths.configDir, "desktop", "window-state.json");
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

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const normalizeFrame = (
	frame: Partial<WindowFrame> | undefined,
	fallback: WindowFrame,
): WindowFrame => {
	if (!frame) {
		return fallback;
	}
	const width =
		isFiniteNumber(frame.width) && frame.width >= MIN_WINDOW_WIDTH
			? frame.width
			: fallback.width;
	const height =
		isFiniteNumber(frame.height) && frame.height >= MIN_WINDOW_HEIGHT
			? frame.height
			: fallback.height;
	return {
		x: isFiniteNumber(frame.x) ? frame.x : fallback.x,
		y: isFiniteNumber(frame.y) ? frame.y : fallback.y,
		width,
		height,
	};
};

const normalizeWindowState = (
	value: unknown,
	fallbackFrame: WindowFrame,
): WindowStateFile => {
	const parsed = value as Partial<WindowStateFile> | null | undefined;
	return {
		version: 1,
		frame: normalizeFrame(parsed?.frame, fallbackFrame),
		maximized: parsed?.maximized === true,
	};
};

export class DesktopWindowStateStore {
	private readonly filePath = windowStateFilePath();
	private pendingTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingWrite: Promise<void> | null = null;
	private latestState: WindowStateFile;

	constructor(private readonly fallbackFrame: WindowFrame) {
		this.latestState = {
			version: 1,
			frame: fallbackFrame,
			maximized: false,
		};
	}

	async load(): Promise<WindowStateFile> {
		try {
			const raw = await fs.readFile(this.filePath, "utf8");
			this.latestState = normalizeWindowState(
				JSON.parse(raw) as unknown,
				this.fallbackFrame,
			);
			return this.latestState;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn("failed to read desktop window state", error);
			}
			this.latestState = {
				version: 1,
				frame: this.fallbackFrame,
				maximized: false,
			};
			return this.latestState;
		}
	}

	attach(mainWindow: BrowserWindow): void {
		const scheduleSave = () => {
			if (this.pendingTimer) {
				clearTimeout(this.pendingTimer);
			}
			this.pendingTimer = setTimeout(() => {
				this.pendingTimer = null;
				this.pendingWrite = this.persistFromWindow(mainWindow);
			}, SAVE_DEBOUNCE_MS);
		};

		mainWindow.on("move", () => {
			scheduleSave();
		});
		mainWindow.on("resize", () => {
			scheduleSave();
		});
		mainWindow.on("close", () => {
			void this.flush(mainWindow);
		});
	}

	async flush(mainWindow: BrowserWindow): Promise<void> {
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
		await this.persistFromWindow(mainWindow);
		if (this.pendingWrite) {
			await this.pendingWrite;
		}
	}

	private capture(mainWindow: BrowserWindow): WindowStateFile {
		const maximized = mainWindow.isMaximized();
		if (!maximized) {
			this.latestState = {
				version: 1,
				frame: normalizeFrame(mainWindow.getFrame(), this.fallbackFrame),
				maximized: false,
			};
			return this.latestState;
		}
		this.latestState = {
			...this.latestState,
			version: 1,
			maximized: true,
		};
		return this.latestState;
	}

	private async persistFromWindow(mainWindow: BrowserWindow): Promise<void> {
		const next = this.capture(mainWindow);
		try {
			await fs.mkdir(path.dirname(this.filePath), { recursive: true });
			await atomicWriteFile(
				this.filePath,
				`${JSON.stringify(next, null, 2)}\n`,
			);
		} catch (error) {
			console.warn("failed to persist desktop window state", error);
		}
	}
}
