import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "@codelia/core";
import type { RpcRequest, RpcResponse } from "@codelia/protocol";
import type { ResolvedSkillsConfig } from "../src/config";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";
import { SkillsResolver } from "../src/skills";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const captureResponse = async (
	run: () => void,
	id: string,
): Promise<RpcResponse> => {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let buffer = "";
	const responses: RpcResponse[] = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		const text =
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		buffer += text;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line) {
				try {
					const parsed = JSON.parse(line) as unknown;
					if (isRecord(parsed) && typeof parsed.id === "string") {
						responses.push(parsed as RpcResponse);
					}
				} catch {
					// ignore
				}
			}
			index = buffer.indexOf("\n");
		}
		return true;
	}) as typeof process.stdout.write;
	try {
		run();
		const deadline = Date.now() + 1_000;
		while (Date.now() < deadline) {
			const response = responses.find((entry) => entry.id === id);
			if (response) return response;
			await Bun.sleep(10);
		}
		throw new Error("response timeout");
	} finally {
		process.stdout.write = originalWrite;
	}
};

const writeText = async (
	targetPath: string,
	content: string,
): Promise<void> => {
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await fs.writeFile(targetPath, content, "utf8");
};

const skillDoc = (name: string, description: string) =>
	[
		"---",
		`name: ${name}`,
		`description: ${description}`,
		"---",
		"",
		"body",
	].join("\n");

const baseConfig: ResolvedSkillsConfig = {
	enabled: true,
	initial: {
		maxEntries: 200,
		maxBytes: 32 * 1024,
	},
	search: {
		defaultLimit: 8,
		maxLimit: 50,
	},
};

describe("skills.list rpc", () => {
	test("returns skills catalog and context.inspect includes skills snapshot", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-rpc-"));
		const homeDir = path.join(tempRoot, "home");
		const repoDir = path.join(tempRoot, "repo");
		await writeText(path.join(repoDir, ".git"), "");
		await writeText(
			path.join(repoDir, ".agents", "skills", "repo-review", "SKILL.md"),
			skillDoc("repo-review", "Review with a risk-first checklist."),
		);

		try {
			const resolver = await SkillsResolver.create({
				workingDir: repoDir,
				config: baseConfig,
				env: {
					...process.env,
					HOME: homeDir,
					CODELIA_AGENTS_MARKERS: ".git",
				},
			});
			const state = new RuntimeState();
			state.skillsResolver = resolver;
			state.runtimeWorkingDir = repoDir;
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => ({}) as Agent,
				log: () => {},
			});

			const listResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "skills-1",
					method: "skills.list",
				} satisfies RpcRequest);
			}, "skills-1");
			expect(listResponse.error).toBeUndefined();
			expect(listResponse.result).toEqual({
				skills: [
					expect.objectContaining({
						name: "repo-review",
						scope: "repo",
					}),
				],
				errors: [],
				truncated: false,
			});

			state.skillsResolver = null;
			const cachedResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "skills-cache",
					method: "skills.list",
				} satisfies RpcRequest);
			}, "skills-cache");
			expect(cachedResponse.error).toBeUndefined();
			expect(cachedResponse.result).toEqual(listResponse.result);

			const contextResponse = await captureResponse(() => {
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "skills-ctx",
					method: "context.inspect",
					params: {
						include_agents: false,
						include_skills: true,
					},
				} satisfies RpcRequest);
			}, "skills-ctx");
			expect(contextResponse.error).toBeUndefined();
			expect(contextResponse.result).toEqual(
				expect.objectContaining({
					skills: expect.objectContaining({
						catalog: expect.objectContaining({
							skills: expect.arrayContaining([
								expect.objectContaining({
									name: "repo-review",
								}),
							]),
						}),
					}),
				}),
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
