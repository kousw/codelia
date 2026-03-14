import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { createViewImageTool } from "../src/tools/view-image";

const createTempDir = async (): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), "codelia-view-image-tool-"));

const createToolContext = (): ToolContext => {
	const cache = new Map<string, unknown>();
	const deps: Record<string, unknown> = Object.create(null);
	return {
		deps,
		resolve: async <T>(key: DependencyKey<T>): Promise<T> => {
			if (cache.has(key.id)) {
				return cache.get(key.id) as T;
			}
			const value = await key.create();
			cache.set(key.id, value);
			return value;
		},
	};
};

const MINIMAL_PNG = Buffer.from(
	"89504E470D0A1A0A0000000D4948445200000001000000010802000000907753DE0000000C49444154789C6360000002000154A24F5D0000000049454E44AE426082",
	"hex",
);

describe("view_image tool", () => {
	test("returns a multimodal image result for local files", async () => {
		const tempRoot = await createTempDir();
		try {
			await fs.writeFile(path.join(tempRoot, "pixel.png"), MINIMAL_PNG);
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createViewImageTool(createSandboxKey(sandbox));
			const result = await tool.executeRaw(
				JSON.stringify({
					file_path: "pixel.png",
					detail: "high",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("parts");
			if (result.type !== "parts") {
				throw new Error("unexpected result type");
			}
			expect(result.parts[0]).toEqual({
				type: "text",
				text: "Image loaded: pixel.png\n",
			});
			expect(result.parts[1]).toEqual({
				type: "image_url",
				image_url: {
					url: expect.stringMatching(/^data:image\/png;base64,/),
					media_type: "image/png",
					detail: "high",
				},
			});
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("blocks paths outside the sandbox", async () => {
		const tempRoot = await createTempDir();
		try {
			const sandbox = await SandboxContext.create(tempRoot);
			const tool = createViewImageTool(createSandboxKey(sandbox));
			await expect(
				tool.executeRaw(
					JSON.stringify({
						file_path: "../outside.png",
					}),
					createToolContext(),
				),
			).rejects.toThrow("Security error");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
