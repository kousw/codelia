import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	Agent,
	type BaseMessage,
	type ChatInvokeInput,
	type SessionRecord,
} from "@codelia/core";
import { ImageArtifactStore } from "@codelia/storage";
import {
	type ImageSource,
	resolveImageSources,
} from "../src/image-generation/references";
import type { ImageRoute } from "../src/image-generation/route";
import { createLocalImageSourceReader } from "../src/image-generation/source-reader";
import { createImageTools } from "../src/image-generation/tools";
import { createToolContext } from "../src/rpc/tool";
import { SandboxContext } from "../src/sandbox/context";
import {
	referenceJpeg64,
	referencePng64,
	referenceWebp64,
} from "./image-source-fixtures";

const png = Buffer.from(referencePng64, "base64");
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "codelia-image-sources-"));
	roots.push(root);
	const store = new ImageArtifactStore(path.join(root, "artifacts"));
	const original = await store.save(png, {
		provider: "fixture",
		requested_model: "fixture",
		endpoint: "fixture",
		parent_artifact_ids: [],
	});
	return { root, store, original };
}
function route(kind: "openai" | "codex" | "openrouter"): ImageRoute {
	if (kind === "codex")
		return {
			authMode: "codex_oauth",
			provider: "openai",
			model: "gpt-image-2",
			endpoint: "https://chatgpt.com/backend-api/codex/images/generations",
			options: {},
			getAccessToken: async () => ({ token: "fixture-oauth" }),
		};
	return {
		authMode: "api_key",
		provider: kind,
		model: kind === "openai" ? "gpt-image-2.5-sunburst" : "owner/image",
		endpoint:
			kind === "openai"
				? "https://api.openai.com/v1/images/generations"
				: "pinned",
		options: {},
		apiKey: "fixture-api-key",
	};
}
const generated = () => Response.json({ data: [{ b64_json: referencePng64 }] });
const catalog = (max = 16) =>
	Response.json({
		endpoints: [
			{
				provider_tag: "pinned",
				supported_parameters: {
					input_references: { type: "range", min: 0, max },
				},
			},
		],
	});

test.each(["openai", "codex", "openrouter"] as const)(
	"%s carries URL, file and artifact originals in order with correct MIME, after approval",
	async (kind) => {
		const { root, store, original } = await fixture();
		await writeFile(
			path.join(root, "photo.dat"),
			Buffer.from(referenceJpeg64, "base64"),
		);
		const localReader = createLocalImageSourceReader(
			await SandboxContext.create(root),
		);
		const events: string[] = [];
		const sources: ImageSource[] = [
			{ type: "url", url: "https://images.example.com/reference.webp" },
			{ type: "file", file_path: "photo.dat" },
			{ type: "artifact", artifact_id: original.artifact_id },
		];
		const tool = createImageTools({
			store,
			route: route(kind),
			authorize: () => {
				events.push("approve");
				return { decision: "allow" };
			},
			readSource: async (source, signal) => {
				events.push(source.type);
				return source.type === "url"
					? Buffer.from(referenceWebp64, "base64")
					: localReader(source, signal);
			},
			fetcher: async (url, init) => {
				if (url.endsWith("/endpoints")) {
					events.push("catalog");
					return catalog();
				}
				events.push("paid");
				const expected = [referenceWebp64, referenceJpeg64, referencePng64];
				const mimes = ["image/webp", "image/jpeg", "image/png"];
				if (kind === "openai") {
					expect(url).toEndWith("/images/edits");
					expect(init?.body).toBeInstanceOf(FormData);
					if (!(init?.body instanceof FormData))
						throw Error("missing multipart");
					const images = init.body.getAll("image[]");
					expect(images).toHaveLength(3);
					for (const [index, file] of images.entries()) {
						if (!(file instanceof Blob)) throw Error("not a blob");
						expect(file.type).toBe(mimes[index]);
						expect(
							Buffer.from(await file.arrayBuffer()).toString("base64"),
						).toBe(expected[index]);
					}
				} else {
					const body = JSON.parse(String(init?.body));
					const urls = expected.map(
						(base64, index) => `data:${mimes[index]};base64,${base64}`,
					);
					if (kind === "codex") {
						expect(url).toEndWith("/images/edits");
						expect(body.images).toEqual(
							urls.map((image_url) => ({ image_url })),
						);
					} else {
						expect(body.input_references).toEqual(
							urls.map((url) => ({ type: "image_url", image_url: { url } })),
						);
						expect(body.provider).toEqual({
							only: ["pinned"],
							allow_fallbacks: false,
						});
					}
				}
				return generated();
			},
		}).find((tool) => tool.name === "image_generate");
		if (!tool) throw Error("missing tool");
		const result = await tool.executeRaw(
			JSON.stringify({ prompt: "Use images 1, 2 and 3", images: sources }),
			createToolContext(),
		);
		expect(events).toEqual(
			kind === "openrouter"
				? ["approve", "catalog", "url", "file", "paid"]
				: ["approve", "url", "file", "paid"],
		);
		if (result.type !== "parts") throw Error("missing parts");
		const ref = result.parts.find((p) => p.type === "image_ref");
		if (ref?.type !== "image_ref") throw Error("missing ref");
		const { metadata } = await new ImageArtifactStore(store.root).read(
			ref.image_ref.artifact_id,
		);
		if (metadata.kind === "attachment") throw Error("expected generation");
		expect(metadata.parent_artifact_ids).toEqual([original.artifact_id]);
		expect(JSON.stringify(result)).not.toContain(referencePng64);
	},
);

test("public route accepts 16 ordered references, persists all parents, and retains legacy artifact-only input", async () => {
	const { store, original } = await fixture();
	let requests = 0;
	const tool = createImageTools({
		store,
		route: route("openai"),
		authorize: () => ({ decision: "allow" }),
		fetcher: async (_url, init) => {
			requests++;
			expect(init?.body).toBeInstanceOf(FormData);
			if (init?.body instanceof FormData)
				expect(init.body.getAll("image[]")).toHaveLength(16);
			return generated();
		},
	}).find((t) => t.name === "image_generate");
	if (!tool) throw Error("missing tool");
	const ids = Array.from({ length: 16 }, () => original.artifact_id);
	for (const references of [
		{ images: ids.map((artifact_id) => ({ type: "artifact", artifact_id })) },
		{ reference_artifact_ids: ids },
	]) {
		const result = await tool.executeRaw(
			JSON.stringify({ prompt: "edit", ...references }),
			createToolContext(),
		);
		if (result.type !== "parts") throw Error("missing parts");
		const ref = result.parts.find((p) => p.type === "image_ref");
		if (ref?.type !== "image_ref") throw Error("missing ref");
		const { metadata } = await store.read(ref.image_ref.artifact_id);
		if (metadata.kind === "attachment") throw Error("expected generation");
		expect(metadata.parent_artifact_ids).toEqual(ids);
	}
	expect(requests).toBe(2);
});

test("route caps and unsupported references fail before reading sources or sending a paid request", async () => {
	const { store } = await fixture();
	for (const [kind, count] of [
		["codex", 6],
		["openrouter", 3],
	] as const) {
		let reads = 0;
		let paid = 0;
		const tool = createImageTools({
			store,
			route: route(kind),
			authorize: () => ({ decision: "allow" }),
			readSource: async () => {
				reads++;
				return png;
			},
			fetcher: async (url) => {
				if (url.endsWith("/endpoints")) return catalog(2);
				paid++;
				return generated();
			},
		}).find((t) => t.name === "image_generate");
		if (!tool) throw Error("missing tool");
		await expect(
			tool.executeRaw(
				JSON.stringify({
					prompt: "edit",
					images: Array.from({ length: count }, () => ({
						type: "url",
						url: "https://example.com/image.png",
					})),
				}),
				createToolContext(),
			),
		).rejects.toThrow("no generation was attempted");
		expect(reads).toBe(0);
		expect(paid).toBe(0);
	}
});

test("invalid, missing, denied and failed sources never degrade to text-only generation", async () => {
	const { store, original } = await fixture();
	let paid = 0;
	let reads = 0;
	let approvals = 0;
	const make = (denied = false, reader = true) => {
		const tool = createImageTools({
			store,
			route: route("openai"),
			authorize: () => {
				approvals++;
				return { decision: denied ? "deny" : "allow" };
			},
			...(reader
				? {
						readSource: async () => {
							reads++;
							return Buffer.from("not an image");
						},
					}
				: {}),
			fetcher: async () => {
				paid++;
				return generated();
			},
		}).find((t) => t.name === "image_generate");
		if (!tool) throw Error("missing tool");
		return tool;
	};
	const tool = make();
	const args = {
		prompt: "edit",
		images: [{ type: "url", url: "https://example.com/image.png" }],
	};
	for (const invalid of [
		{ ...args, reference_artifact_ids: [] },
		{
			...args,
			images: [{ type: "url", url: "https://user:secret@example.com/a" }],
		},
		{
			...args,
			images: [
				{ type: "file", file_path: "a.png", url: "https://example.com/a" },
			],
		},
		{
			...args,
			images: Array.from({ length: 17 }, () => ({
				type: "artifact",
				artifact_id: original.artifact_id,
			})),
		},
	])
		expect(() =>
			tool.executeRaw(JSON.stringify(invalid), createToolContext()),
		).toThrow("validation failed");
	expect(approvals).toBe(0);
	await expect(
		make(true).executeRaw(JSON.stringify(args), createToolContext()),
	).rejects.toThrow();
	expect(reads).toBe(0);
	await expect(
		make(false, false).executeRaw(JSON.stringify(args), createToolContext()),
	).rejects.toThrow("unavailable in this environment");
	await expect(
		tool.executeRaw(JSON.stringify(args), createToolContext()),
	).rejects.toThrow("valid PNG/JPEG/WebP");
	await expect(
		tool.executeRaw(
			JSON.stringify({
				prompt: "edit",
				images: [
					{
						type: "artifact",
						artifact_id: "codelia-image-00000000-0000-0000-0000-000000000000",
					},
				],
			}),
			createToolContext(),
		),
	).rejects.toThrow("no generation was attempted");
	expect(paid).toBe(0);
});

test("source byte budget is independent of the reference count limit", async () => {
	const { store } = await fixture();
	const sources: ImageSource[] = Array.from({ length: 5 }, () => ({
		type: "url",
		url: "https://example.com/image.png",
	}));
	const bytes = Buffer.alloc(8 * 1024 * 1024);
	png.copy(bytes);
	await expect(
		resolveImageSources(sources, store, async () => bytes),
	).rejects.toThrow("32 MiB combined limit");
});

test("three generated turns and disk resume preserve full prior LLM input prefixes and never replay source reads", async () => {
	const { root, store } = await fixture();
	const file = path.join(root, "reference.webp");
	await writeFile(file, Buffer.from(referenceWebp64, "base64"));
	const local = createLocalImageSourceReader(await SandboxContext.create(root));
	const requests: ChatInvokeInput[] = [];
	const records: SessionRecord[] = [];
	let reads = 0;
	let paid = 0;
	let waiting = false;
	const tools = createImageTools({
		store,
		route: route("openai"),
		authorize: () => ({ decision: "allow" }),
		readSource: async (source, signal) => {
			reads++;
			return local(source, signal);
		},
		fetcher: async () => {
			paid++;
			return generated();
		},
	});
	const llm = {
		provider: "openai" as const,
		model: "fixture",
		ainvoke: async (input: ChatInvokeInput) => {
			requests.push(
				structuredClone({ messages: input.messages, tools: input.tools }),
			);
			if (waiting || input.messages.at(-1)?.content === "resume") {
				waiting = false;
				return { messages: [{ role: "assistant" as const, content: "done" }] };
			}
			waiting = true;
			return {
				messages: [
					{
						role: "assistant" as const,
						content: null,
						tool_calls: [
							{
								id: `generate-${paid}`,
								type: "function" as const,
								function: {
									name: "image_generate",
									arguments: JSON.stringify({
										prompt: "edit",
										images: [{ type: "file", file_path: "reference.webp" }],
									}),
								},
							},
						],
					},
				],
			};
		},
	};
	const agent = new Agent({
		llm,
		tools,
		services: { resolveImage: store.resolve.bind(store) },
		compaction: { enabled: false },
	});
	for (let turn = 0; turn < 3; turn++)
		await agent.run(`draw ${turn}`, {
			session: {
				session_id: "session",
				run_id: `run-${turn}`,
				append: (record) => {
					records.push(record);
				},
			},
		});
	for (let i = 1; i < requests.length; i++) {
		const previous = requests[i - 1];
		const next = requests[i];
		if (!previous || !next) throw Error("missing captured request");
		expect(
			JSON.stringify(next.messages.slice(0, previous.messages.length)),
		).toBe(JSON.stringify(previous.messages));
		expect(JSON.stringify(next.tools)).toBe(JSON.stringify(previous.tools));
	}
	const history = JSON.stringify(agent.getHistoryMessages());
	expect(history).not.toContain(referencePng64);
	expect(history).not.toContain(referenceWebp64);
	expect(JSON.stringify(records)).not.toContain(referencePng64);
	expect(JSON.stringify(records)).not.toContain(referenceWebp64);
	expect(
		requests
			.at(-1)
			?.messages.filter((m) => JSON.stringify(m).includes(referencePng64)),
	).toHaveLength(3);
	const disk = path.join(root, "history.json");
	await writeFile(disk, history);
	await rm(file);
	const reloaded = new ImageArtifactStore(store.root);
	const restoredTools = createImageTools({
		store: reloaded,
		route: route("openai"),
		authorize: () => ({ decision: "allow" }),
		fetcher: async () => {
			throw Error("history replay must not generate");
		},
	});
	const next = new Agent({
		llm,
		tools: restoredTools,
		services: { resolveImage: reloaded.resolve.bind(reloaded) },
		compaction: { enabled: false },
	});
	const restored: BaseMessage[] = JSON.parse(await readFile(disk, "utf8"));
	next.replaceHistoryMessages(restored);
	const previous = requests.at(-1);
	if (!previous) throw Error("missing captured request");
	await next.run("resume");
	expect(
		JSON.stringify(
			requests.at(-1)?.messages.slice(0, previous.messages.length),
		),
	).toBe(JSON.stringify(previous.messages));
	expect(JSON.stringify(requests.at(-1)?.tools)).toBe(
		JSON.stringify(previous.tools),
	);
	expect(reads).toBe(3);
	expect(paid).toBe(3);
});
