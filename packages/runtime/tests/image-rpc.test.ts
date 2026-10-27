import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OPENAI_IMAGE_MODELS } from "@codelia/config";
import { resolveStoragePaths } from "@codelia/storage";
import { createAgentFactory } from "../src/agent-factory";
import { AuthStore } from "../src/auth/store";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";

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
	setEnv("CODELIA_APPROVAL_MODE", "full-access");
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
	state.setUiCapabilities({ supports_pick: true, supports_confirm: true });
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
			if (m.method === "ui.pick.request")
				queueMicrotask(() =>
					state.resolveUiResponse({
						jsonrpc: "2.0",
						id: String(m.id),
						result: { ids: [picks.shift()] },
					}),
				);
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
		["custom", "openai", OPENAI_IMAGE_MODELS[1]],
	);
	expect(selected.find((m) => m.id === "choose")).toMatchObject({
		result: { state: "available", requested_model: OPENAI_IMAGE_MODELS[1] },
	});
	const project = JSON.parse(
		await readFile(path.join(root, ".codelia/config.json"), "utf8"),
	);
	expect(project.image_generation).toMatchObject({
		mode: "custom",
		model: OPENAI_IMAGE_MODELS[1],
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
