import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OPENAI_IMAGE_MODELS } from "@codelia/config";
import type {
	AttachmentUploadBeginResult,
	AttachmentUploadFinishResult,
} from "@codelia/protocol";
import { ImageArtifactStore, resolveStoragePaths } from "@codelia/storage";
import { createAgentFactory } from "../src/agent-factory";
import { createRuntimeAttachmentService } from "../src/attachments/local";
import { AuthStore } from "../src/auth/store";
import { createLocalImageStore } from "../src/image-generation/local-store";
import { runtimeWorkspaceGrant } from "../src/permissions/runtime-approval";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";
import { VolatileSessionStateStore } from "../src/volatile-stores";
import { fixtureShellBackend } from "./fixtures/approval";

let root = "";
const env = new Map<string, string | undefined>();
let originalFetch: typeof fetch;
let state: RuntimeState;
const png64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=";
const setEnv = (key: string, value: string) => {
	env.set(key, process.env[key]);
	process.env[key] = value;
};
beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "codelia-image-rpc-"));
	for (const key of [
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_STATE_HOME",
		"XDG_DATA_HOME",
	])
		setEnv(key, path.join(root, key));
	setEnv("CODELIA_LAYOUT", "xdg");
	setEnv("CODELIA_CONFIG_PATH", path.join(root, "global.json"));
	setEnv("CODELIA_SANDBOX_ROOT", root);
	env.set("CODELIA_APPROVAL_MODE", process.env.CODELIA_APPROVAL_MODE);
	delete process.env.CODELIA_APPROVAL_MODE;
	setEnv("OPENAI_API_KEY", "image-test-key");
	await writeFile(
		path.join(root, "global.json"),
		JSON.stringify({
			version: 1,
			model: { provider: "openai", name: "gpt-6-astra" },
			execution_environment: { startup_checks: { enabled: false } },
			skills: { enabled: false },
		}),
	);
	await new AuthStore().save({
		version: 1,
		providers: {
			openai: {
				method: "oauth",
				oauth: {
					access_token: "oauth-fixture",
					refresh_token: "refresh-fixture",
					expires_at: Date.now() + 3600000,
				},
			},
		},
	});
	state = new RuntimeState();
	state.runtimeWorkingDir = root;
	state.runtimeSandboxRoot = root;
	state.approvalMode = "full-access";
	state.setUiCapabilities({
		supports_pick: true,
		supports_confirm: true,
		supports_structured_approval: true,
	});
	originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (String(url) === "https://models.dev/api.json")
				return Response.json({
					openai: {
						models: {
							"gpt-6-astra": {
								id: "gpt-6-astra",
								name: "GPT",
								limit: { context: 128000, output: 16384 },
							},
						},
					},
				});
			if (String(url) === "https://api.openai.com/v1/images/generations") {
				expect(new Headers(init?.headers).get("Authorization")).toBe(
					"Bearer image-test-key",
				);
				return Response.json({ data: [{ b64_json: png64 }] });
			}
			throw new Error(`Unexpected test request: ${String(url)}`);
		},
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
});
afterEach(async () => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of env) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	env.clear();
	await rm(root, { recursive: true, force: true });
});

async function capture(run: () => void, picks: string[] = [], confirm = true) {
	const original = process.stdout.write;
	const messages: Record<string, unknown>[] = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		for (const line of String(chunk).trim().split("\n")) {
			const m = JSON.parse(line) as Record<string, unknown>;
			messages.push(m);
			if (m.method === "ui.pick.request") {
				const params = m.params as { items: Array<{ id: string }> };
				const choice = params.items.find((item) =>
					item.id.endsWith(confirm ? "/allow_once" : "/deny_continue"),
				);
				queueMicrotask(() =>
					state.resolveUiResponse({
						jsonrpc: "2.0",
						id: String(m.id),
						result: { ids: [choice?.id ?? picks.shift()] },
					}),
				);
			}
			if (m.method === "ui.confirm.request")
				queueMicrotask(() =>
					state.resolveUiResponse({
						jsonrpc: "2.0",
						id: String(m.id),
						result: { ok: confirm },
					}),
				);
		}
		return true;
	}) as typeof process.stdout.write;
	try {
		run();
		const deadline = Date.now() + 4000;
		while (!messages.some((m) => "result" in m || "error" in m)) {
			if (Date.now() > deadline) throw new Error("Image RPC did not settle");
			await Bun.sleep(10);
		}
		return messages;
	} finally {
		process.stdout.write = original;
	}
}

test("copied image preview and inspection follow the owner across real session switches", async () => {
	const sessions = new VolatileSessionStateStore();
	const owner = state.nextSessionId();
	const other = state.nextSessionId();
	for (const session_id of [owner, other]) {
		await sessions.save({
			schema_version: 1,
			session_id,
			updated_at: new Date().toISOString(),
			messages: [],
		});
	}
	const service = createRuntimeAttachmentService(state);
	if (!service) throw new Error("Expected the local attachment adapter");
	state.attachments = service;
	const handlers = createRuntimeHandlers({
		state,
		getAgent: createAgentFactory(state),
		sessionStateStore: sessions,
		log: () => {},
	});
	let sequence = 0;
	const call = async (method: string, params: Record<string, unknown>) => {
		const id = `${method}-${++sequence}`;
		return (
			await capture(() =>
				handlers.processMessage({ jsonrpc: "2.0", id, method, params }),
			)
		).find((message) => message.id === id);
	};
	const preview = (artifact_id: string) =>
		call("image.artifact.get", { artifact_id });
	const inspect = (artifact_id: string) =>
		call("tool.call", {
			name: "image_inspect",
			arguments: { artifact_id },
		});
	try {
		const bytes = Buffer.from(png64, "base64");
		// Inline images created through the pre-upload path retain workspace scope.
		const legacy = await createLocalImageStore(root).saveAttachment(
			bytes,
			"image/png",
		);
		expect(await call("session.open", { session_id: owner })).toMatchObject({
			result: { session_id: owner },
		});
		const begin = await call("attachment.upload.begin", {
			upload_key: "pasted-image",
			display_name: "copied.png",
			byte_size: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			session_id: owner,
		});
		const upload_id = (begin?.result as AttachmentUploadBeginResult | undefined)
			?.upload_id;
		if (!upload_id) throw new Error("Expected the upload to begin");
		expect(
			await call("attachment.upload.chunk", {
				upload_id,
				offset: 0,
				data: png64,
			}),
		).toMatchObject({
			result: { offset: bytes.length },
		});
		const finish = await call("attachment.upload.finish", { upload_id });
		const attachment_id = (
			finish?.result as AttachmentUploadFinishResult | undefined
		)?.attachment_id;
		if (!attachment_id) throw new Error("Expected the upload to finish");
		await service.claim([attachment_id], owner);
		const [owned] = await service.resolveForAdmission([attachment_id], owner);
		if (!owned?.imageRef) throw new Error("Expected a copied image reference");
		const { artifact_id } = owned.imageRef;
		const firstPreview = await preview(artifact_id);
		expect(firstPreview).toMatchObject({
			result: {
				metadata: { artifact_id, kind: "attachment" },
				data_url: `data:image/png;base64,${png64}`,
			},
		});
		expect(firstPreview).not.toHaveProperty("result.metadata.owner_session_id");
		expect(await inspect(artifact_id)).toMatchObject({
			result: {
				ok: true,
				result: expect.arrayContaining([
					expect.objectContaining({ type: "image_ref" }),
				]),
			},
		});
		expect(await call("session.open", { session_id: other })).toMatchObject({
			result: { session_id: other },
		});
		const deniedPreview = await preview(artifact_id);
		const deniedInspect = await inspect(artifact_id);
		expect(deniedPreview?.error).toBeDefined();
		expect(deniedInspect?.error).toBeDefined();
		expect(JSON.stringify([deniedPreview, deniedInspect])).not.toContain(root);
		expect(JSON.stringify([deniedPreview, deniedInspect])).not.toContain(owner);
		expect(deniedPreview?.error).toEqual(
			(await preview(`codelia-image-${state.nextRunId()}`))?.error,
		);
		expect(await preview(legacy.artifact_id)).toHaveProperty("result.data_url");
		expect(await inspect(legacy.artifact_id)).toHaveProperty("result.ok", true);
		expect(await call("session.open", { session_id: owner })).toMatchObject({
			result: { session_id: owner },
		});
		expect(await preview(artifact_id)).toHaveProperty("result.data_url");
		expect(await service.resolveImage?.(owned.imageRef)).toMatchObject({
			image_url: { url: `data:image/png;base64,${png64}` },
		});
	} finally {
		await service.close();
	}
});

test("direct decision RPC confirms before reading and sending a local image", async () => {
	state.approvalMode = "minimal";
	await writeFile(path.join(root, "input.png"), Buffer.from(png64, "base64"));
	const before = await readFile(resolveStoragePaths().authFile, "utf8");
	let requests = 0;
	const fallback = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (String(url) !== "https://api.openai.com/v1/decisions")
				return fallback(url, init);
			requests++;
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				"Bearer image-test-key",
			);
			expect(JSON.parse(String(init?.body))).toMatchObject({
				model: "gpt-6-luna",
				input: [
					{
						role: "user",
						content: [
							{
								type: "input_image",
								image_url: `data:image/png;base64,${png64}`,
							},
						],
					},
				],
			});
			return Response.json({
				answers: [{ name: "damage", type: "predicate", probability: 0.9 }],
			});
		},
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
	const handlers = createRuntimeHandlers({
		state,
		getAgent: createAgentFactory(state),
		log: () => {},
	});
	const call = (confirm: boolean) =>
		capture(
			() =>
				handlers.processMessage({
					jsonrpc: "2.0",
					id: confirm ? "decision-allow" : "decision",
					method: "tool.call",
					params: {
						name: "decision",
						arguments: {
							provider: "openai",
							images: [{ type: "file", file_path: "input.png" }],
							questions: [
								{
									name: "damage",
									type: "predicate",
									instructions: "Is there damage?",
								},
							],
						},
					},
				}),
			[],
			confirm,
		);
	const denied = await call(false);
	const prompt = denied.filter((m) => m.method === "ui.pick.request");
	expect(prompt).toHaveLength(1);
	expect(JSON.stringify(prompt)).toContain("gpt-6-luna");
	expect(JSON.stringify(prompt)).toContain("input.png");
	expect(denied.find((m) => m.id === "decision")).toHaveProperty("error");
	expect(requests).toBe(0);
	const allowed = await call(true);
	expect(allowed.filter((m) => m.method === "ui.pick.request")).toHaveLength(1);
	expect(allowed.find((m) => m.id === "decision-allow")).toMatchObject({
		result: {
			result: {
				provider: "openai",
				answers: [{ name: "damage", type: "predicate", probability: 0.9 }],
			},
		},
	});
	expect(requests).toBe(1);
	expect(await readFile(resolveStoragePaths().authFile, "utf8")).toBe(before);
});

test("image-model picker persists independently; factory executes selection with API key while chat OAuth survives; artifact RPC returns bytes", async () => {
	const before = await readFile(resolveStoragePaths().authFile, "utf8");
	const getAgent = createAgentFactory(state);
	const handlers = createRuntimeHandlers({ state, getAgent, log: () => {} });
	const selected = await capture(
		() =>
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "choose",
				method: "image.model.configure",
				params: {},
			}),
		["custom", "openai", "gpt-image-2.6-sunburst"],
	);
	expect(selected.find((m) => m.id === "choose")).toMatchObject({
		result: { state: "available", requested_model: "gpt-image-2.6-sunburst" },
	});
	const project = JSON.parse(
		await readFile(path.join(root, ".codelia/config.json"), "utf8"),
	);
	expect(project.image_generation).toMatchObject({
		mode: "custom",
		model: "gpt-image-2.6-sunburst",
	});
	expect(project.model).toBeUndefined();
	expect(await readFile(resolveStoragePaths().authFile, "utf8")).toBe(before);
	const called = await capture(() =>
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "generate",
			method: "tool.call",
			params: {
				name: "image_generate",
				arguments: { prompt: "Draw a red square" },
			},
		}),
	);
	const result = called.find((m) => m.id === "generate") as
		| {
				result?: {
					result?: Array<{ type: string; image_ref?: { artifact_id: string } }>;
				};
		  }
		| undefined;
	const ref = result?.result?.result?.find(
		(p) => p.type === "image_ref",
	)?.image_ref;
	expect(ref?.artifact_id).toStartWith("codelia-image-");
	expect(await readFile(resolveStoragePaths().authFile, "utf8")).toBe(before);
	const preview = await capture(() =>
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "preview",
			method: "image.artifact.get",
			params: { artifact_id: ref?.artifact_id },
		}),
	);
	expect(preview.find((m) => m.id === "preview")).toMatchObject({
		result: { data_url: `data:image/png;base64,${png64}` },
	});
	expect(JSON.stringify(selected)).not.toContain("image-test-key");
});

test("image export rechecks the admitted destination parent after the artifact read", async () => {
	state.setRuntimeEnvironment({
		adapters: { shellProtectionBackend: fixtureShellBackend },
	});
	await mkdir(path.join(root, "output"));
	const { artifact_id } = await createLocalImageStore(root).saveAttachment(
		Buffer.from(png64, "base64"),
		"image/png",
	);
	const handlers = createRuntimeHandlers({
		state,
		getAgent: createAgentFactory(state),
		log: () => {},
	});
	const read = ImageArtifactStore.prototype.read;
	const changingParent = spyOn(
		ImageArtifactStore.prototype,
		"read",
	).mockImplementation(async function (this: ImageArtifactStore, id, owner) {
		const result = await read.call(this, id, owner);
		await rename(path.join(root, "output"), path.join(root, "displaced"));
		await mkdir(path.join(root, "output"));
		return result;
	});
	try {
		const result = await capture(
			() =>
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "export-fixture",
					method: "tool.call",
					params: {
						name: "image_export",
						arguments: { artifact_id, output_path: "output/example.png" },
					},
				}),
			[],
			true,
		);
		expect(changingParent).toHaveBeenCalledTimes(1);
		expect(
			result.find((message) => message.id === "export-fixture"),
		).toHaveProperty("error");
		expect(
			await Bun.file(path.join(root, "output", "example.png")).exists(),
		).toBe(false);
		expect(
			await Bun.file(path.join(root, "displaced", "example.png")).exists(),
		).toBe(false);
	} finally {
		changingParent.mockRestore();
	}
});

test("workspace write grants never authorize paid Decisions or image generation with or without local images", async () => {
	await mkdir(path.join(root, ".codelia"), { recursive: true });
	await writeFile(
		path.join(root, ".codelia/config.json"),
		JSON.stringify({
			version: 1,
			image_generation: {
				mode: "custom",
				provider: "openai",
				model: "gpt-image-2.6-sunburst",
			},
		}),
	);
	await writeFile(path.join(root, "input.png"), Buffer.from(png64, "base64"));
	runtimeWorkspaceGrant(state, await realpath(root), "operator").commit();
	let sends = 0;
	const fallback = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			switch (String(url)) {
				case "https://api.openai.com/v1/decisions":
					sends++;
					return Response.json({
						answers: [{ name: "color", type: "predicate", probability: 0.9 }],
					});
				case "https://api.openai.com/v1/images/generations":
				case "https://api.openai.com/v1/images/edits":
					sends++;
					return Response.json({ data: [{ b64_json: png64 }] });
				default:
					return fallback(url, init);
			}
		},
		{ preconnect: fallback.preconnect },
	) as typeof fetch;
	const handlers = createRuntimeHandlers({
		state,
		getAgent: createAgentFactory(state),
		log: () => {},
	});
	let id = 0;
	for (const name of ["decision", "image_generate"]) {
		for (const attach of [false, true]) {
			const args =
				name === "decision"
					? {
							provider: "openai",
							input_text: "The square is red.",
							questions: [
								{
									name: "color",
									type: "predicate",
									instructions: "Is it red?",
								},
							],
						}
					: { prompt: "Draw a red square" };
			const call = (confirm: boolean) =>
				capture(
					() =>
						handlers.processMessage({
							jsonrpc: "2.0",
							id: `paid-fixture-${++id}`,
							method: "tool.call",
							params: {
								name,
								arguments: {
									...args,
									...(attach
										? { images: [{ type: "file", file_path: "input.png" }] }
										: {}),
								},
							},
						}),
					[],
					confirm,
				);
			const before = sends;
			const denied = await call(false);
			const prompt = denied.filter((m) => m.method === "ui.pick.request");
			expect(prompt).toHaveLength(1);
			expect(JSON.stringify(prompt)).toContain("Once only: network openai:");
			expect(denied.find((m) => m.id === `paid-fixture-${id}`)).toHaveProperty(
				"error",
			);
			expect(sends).toBe(before);
			const approved = await call(true);
			expect(
				approved.filter((m) => m.method === "ui.pick.request"),
			).toHaveLength(1);
			expect(
				approved.find((m) => m.id === `paid-fixture-${id}`),
			).toHaveProperty("result");
			expect(sends).toBe(before + 1);
		}
	}
});

test("scoped image-provider logout rebuilds agent and direct tool caches without resetting chat", async () => {
	delete process.env.OPENAI_API_KEY;
	setEnv("ANTHROPIC_API_KEY", "chat-test-key");
	await writeFile(
		path.join(root, "global.json"),
		JSON.stringify({
			version: 1,
			model: { provider: "anthropic", name: "claude-sonnet-5-5" },
			image_generation: {
				mode: "custom",
				provider: "openai",
				model: OPENAI_IMAGE_MODELS[0],
			},
			execution_environment: { startup_checks: { enabled: false } },
			skills: { enabled: false },
		}),
	);
	const store = new AuthStore();
	const chatAuth = { method: "api_key" as const, api_key: "chat-test-key" };
	await store.save({
		version: 1,
		providers: {
			anthropic: chatAuth,
			openai: { method: "api_key", api_key: "image-test-key" },
		},
	});
	let imageRequests = 0;
	const fixtureFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (String(url).includes("/images/generations")) imageRequests++;
			return fixtureFetch(url, init);
		},
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
	const getAgent = createAgentFactory(state);
	const handlers = createRuntimeHandlers({ state, getAgent, log: () => {} });
	const agent = await getAgent();
	state.sessionId = "keep-chat";
	state.sessionMeta = { marker: "keep" };
	state.sessionModelOverride = {
		provider: "anthropic",
		name: "claude-sonnet-5-5",
	};
	const sessionOverride = state.sessionModelOverride;
	const generate = () =>
		capture(() =>
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "generate",
				method: "tool.call",
				params: {
					name: "image_generate",
					arguments: { prompt: "Draw a square" },
				},
			}),
		);
	await generate();
	expect(imageRequests).toBe(1);
	const logout = (confirm: boolean) =>
		capture(
			() =>
				handlers.processMessage({
					jsonrpc: "2.0",
					id: "logout",
					method: "auth.logout",
					params: { provider: "openai" },
				}),
			[],
			confirm,
		);
	await logout(false);
	expect(state.agent).toBe(agent);
	expect((await store.load()).providers.openai).toBeDefined();
	const loggedOut = await logout(true);
	expect(loggedOut.find((m) => m.id === "logout")).toMatchObject({
		result: { auth_cleared: true, session_cleared: false },
	});
	expect((await store.load()).providers).toEqual({ anthropic: chatAuth });
	expect(state.agent).toBeNull();
	expect(state.tools).toBeNull();
	expect(state.toolDefinitions).toBeNull();
	expect(state.sessionId).toBe("keep-chat");
	expect(state.sessionMeta).toEqual({ marker: "keep" });
	expect(state.sessionModelOverride).toBe(sessionOverride);
	const after = await generate();
	expect(imageRequests).toBe(1);
	expect(after.find((m) => m.id === "generate")).toMatchObject({
		error: { code: -32602, message: "unknown tool: image_generate" },
	});
	expect(state.agent).not.toBe(agent);
	expect(state.agent).not.toBeNull();
});

test("cancel, active run, malformed settings and unsupported host never mutate configuration", async () => {
	const handlers = createRuntimeHandlers({
		state,
		getAgent: createAgentFactory(state),
		log: () => {},
	});
	await capture(
		() =>
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "cancel",
				method: "image.model.configure",
				params: {
					mode: "custom",
					provider: "openai",
					model: OPENAI_IMAGE_MODELS[0],
				},
			}),
		[],
		false,
	);
	await expect(
		readFile(path.join(root, ".codelia/config.json")),
	).rejects.toThrow();
	state.activeRunId = "running";
	const busy = await capture(() =>
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "busy",
			method: "image.model.configure",
			params: { mode: "off" },
		}),
	);
	expect(busy.find((m) => m.id === "busy")).toHaveProperty("error");
	state.activeRunId = null;
	await mkdir(path.join(root, ".codelia"), { recursive: true });
	await writeFile(path.join(root, ".codelia/config.json"), "broken-config");
	const bad = await capture(() =>
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "bad",
			method: "image.model.configure",
			params: { mode: "off" },
		}),
	);
	expect(bad.find((m) => m.id === "bad")).toHaveProperty("error");
	expect(await readFile(path.join(root, ".codelia/config.json"), "utf8")).toBe(
		"broken-config",
	);
	state.effectiveEnvironment = {
		...state.effectiveEnvironment,
		auth: { model: "host" },
	};
	const host = await capture(() =>
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "host",
			method: "image.artifact.get",
			params: { artifact_id: "ignored" },
		}),
	);
	expect(host.find((m) => m.id === "host")).toHaveProperty("error");
});

test("builtin picker uses stored Codex OAuth without API keys; real factory refreshes once and generates/edits/transfers originals on Codex only", async () => {
	process.env.OPENAI_API_KEY = "";
	await new AuthStore().save({
		version: 1,
		providers: {
			openai: {
				method: "oauth",
				oauth: {
					access_token: "expired-fixture",
					refresh_token: "refresh-fixture",
					expires_at: 1,
					account_id: "codex-account",
				},
			},
		},
	});
	const before = await readFile(resolveStoragePaths().authFile, "utf8");
	const originalMock = globalThis.fetch;
	const wire: string[] = [];
	globalThis.fetch = Object.assign(
		async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const address = String(url);
			if (address === "https://auth.openai.com/oauth/token") {
				wire.push("refresh");
				expect(String(init?.body)).toContain("refresh-fixture");
				return Response.json({
					access_token: "refreshed-fixture",
					refresh_token: "rotated-refresh-fixture",
					expires_in: 3600,
					token_type: "Bearer",
				});
			}
			if (address.startsWith("https://chatgpt.com/backend-api/codex/images/")) {
				wire.push(address);
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("Bearer refreshed-fixture");
				expect(headers.get("ChatGPT-Account-ID")).toBe("codex-account");
				const body = JSON.parse(String(init?.body));
				expect(body.model).toBe("gpt-image-2");
				if (address.endsWith("/edits"))
					expect(body.images).toEqual([
						{ image_url: `data:image/png;base64,${png64}` },
					]);
				return Response.json({ data: [{ b64_json: png64 }] });
			}
			if (address.startsWith("https://api.openai.com/"))
				throw new Error("Builtin OAuth crossed into public API billing");
			return originalMock(url, init);
		},
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
	const getAgent = createAgentFactory(state);
	const handlers = createRuntimeHandlers({ state, getAgent, log: () => {} });
	const selected = await capture(
		() =>
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "builtin",
				method: "image.model.configure",
				params: {},
			}),
		["builtin", "gpt-image-2"],
	);
	expect(selected.find((m) => m.id === "builtin")).toMatchObject({
		result: {
			state: "available",
			auth_mode: "codex_oauth",
			requested_model: "gpt-image-2",
		},
	});
	expect(selected.some((m) => m.method === "ui.prompt.request")).toBe(false);
	expect(JSON.stringify(selected)).toContain("no API key");
	expect(wire).toEqual([]);
	expect(await readFile(resolveStoragePaths().authFile, "utf8")).toBe(before);
	expect(
		JSON.parse(await readFile(path.join(root, ".codelia/config.json"), "utf8")),
	).toMatchObject({
		image_generation: {
			mode: "builtin",
			provider_options: { openai: { model: "gpt-image-2" } },
		},
	});
	const generated = await capture(() =>
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "generate-oauth",
			method: "tool.call",
			params: {
				name: "image_generate",
				arguments: { prompt: "Draw a circle" },
			},
		}),
	);
	const result = generated.find((m) => m.id === "generate-oauth") as
		| {
				result?: {
					result?: Array<{ type: string; image_ref?: { artifact_id: string } }>;
				};
		  }
		| undefined;
	const ref = result?.result?.result?.find(
		(p) => p.type === "image_ref",
	)?.image_ref;
	expect(ref?.artifact_id).toStartWith("codelia-image-");
	const edited = await capture(() =>
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "edit-oauth",
			method: "tool.call",
			params: {
				name: "image_generate",
				arguments: {
					prompt: "Make it blue",
					reference_artifact_ids: [ref?.artifact_id],
				},
			},
		}),
	);
	expect(JSON.stringify(edited)).toContain('"type":"image_ref"');
	const preview = await capture(() =>
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "preview-oauth",
			method: "image.artifact.get",
			params: { artifact_id: ref?.artifact_id },
		}),
	);
	expect(preview.find((m) => m.id === "preview-oauth")).toMatchObject({
		result: { data_url: `data:image/png;base64,${png64}` },
	});
	expect(wire).toEqual([
		"refresh",
		"https://chatgpt.com/backend-api/codex/images/generations",
		"https://chatgpt.com/backend-api/codex/images/edits",
	]);
	expect((await new AuthStore().load()).providers.openai).toMatchObject({
		method: "oauth",
		oauth: {
			access_token: "refreshed-fixture",
			refresh_token: "rotated-refresh-fixture",
			account_id: "codex-account",
		},
	});
	expect(JSON.stringify([...selected, ...generated, ...edited])).not.toContain(
		"refreshed-fixture",
	);
	expect(JSON.stringify([...selected, ...generated, ...edited])).not.toContain(
		"rotated-refresh-fixture",
	);
});
