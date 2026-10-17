import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	Agent,
	type BaseMessage,
	type ChatInvokeInput,
	type ContentPart,
	type SessionRecord,
	type SessionState,
} from "@codelia/core";
import { ImageArtifactStore } from "@codelia/storage";
import { persistImageAttachments } from "../src/image-generation/attachments";
import { createImageTools } from "../src/image-generation/tools";
import { createRunHandlers } from "../src/rpc/run";
import { normalizeRunInput } from "../src/rpc/run-input";
import { createToolContext } from "../src/rpc/tool";
import { RuntimeState } from "../src/runtime-state";
import {
	referenceJpeg64,
	referencePng64,
	referenceWebp64,
} from "./image-source-fixtures";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
async function storeFixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "codelia-attachments-"));
	roots.push(root);
	return new ImageArtifactStore(root);
}
const images = [
	["image/png", referencePng64],
	["image/jpeg", referenceJpeg64],
	["image/webp", referenceWebp64],
] as const;

function pngWithMetadata(bytes: number): Buffer {
	const original = Buffer.from(referencePng64, "base64");
	const chunk = Buffer.alloc(bytes + 12, 65);
	chunk.writeUInt32BE(bytes, 0);
	chunk.write("tEXt", 4);
	chunk.write("Note\0", 8);
	let crc = 0xffffffff;
	for (const byte of chunk.subarray(4, -4)) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++)
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
	return Buffer.concat([
		original.subarray(0, 33),
		chunk,
		original.subarray(33),
	]);
}

test("five saved generated PNGs over 12 MiB still allow ordinary conversation and disk resume", async () => {
	const store = await storeFixture();
	const bytes = pngWithMetadata(3 * 1024 * 1024);
	const refs: ContentPart[] = [];
	for (let i = 0; i < 5; i++) {
		const metadata = await store.save(bytes, {
			provider: "openai",
			requested_model: "fixture",
			endpoint: "fixture",
			parent_artifact_ids: [],
		});
		refs.push({ type: "image_ref", image_ref: metadata });
	}
	expect(bytes.length * refs.length).toBeGreaterThan(12 * 1024 * 1024);
	const disk = path.join(store.root, "history.json");
	await writeFile(disk, JSON.stringify([{ role: "user", content: refs }]));
	for (const provider of ["openai", "anthropic", "openrouter"] as const) {
		const reloaded = new ImageArtifactStore(store.root);
		let calls = 0;
		const agent = new Agent({
			tools: [],
			services: { resolveImage: reloaded.resolve.bind(reloaded) },
			llm: {
				provider,
				model: provider === "anthropic" ? "claude-opus-5" : "gpt-6-astra",
				ainvoke: async (input) => {
					calls++;
					const visual = input.messages
						.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
						.filter((part) => part.type === "image_url");
					expect(visual).toHaveLength(5);
					for (const part of visual) {
						if (part.type !== "image_url") throw Error("missing image");
						expect(part.image_url.url).toBe(
							`data:image/png;base64,${bytes.toString("base64")}`,
						);
					}
					return { messages: [{ role: "assistant", content: "done" }] };
				},
			},
		});
		agent.replaceHistoryMessages(JSON.parse(await readFile(disk, "utf8")));
		expect(await agent.run("continue")).toBe("done");
		expect(await agent.run("another normal message")).toBe("done");
		expect(calls).toBe(2);
	}
});

for (const [mediaType, encoded] of images)
	test(`${mediaType} attachment is durable and usable as an explicit generation reference after reload`, async () => {
		const store = await storeFixture();
		const inline = {
			type: "image_url" as const,
			image_url: {
				url: `data:${mediaType};base64,${encoded}`,
				media_type: mediaType,
				detail: "high" as const,
			},
		};
		const input = normalizeRunInput({
			type: "parts",
			parts: [inline, { type: "text", text: "Make a variation of this image" }],
		});
		const prepared = await persistImageAttachments(input, store);
		if (typeof prepared === "string") throw Error("expected parts");
		const ref = prepared.find((p) => p.type === "image_ref");
		if (ref?.type !== "image_ref") throw Error("expected artifact reference");
		expect(ref.detail).toBe("high");
		expect(JSON.stringify(prepared)).toContain(ref.image_ref.artifact_id);
		expect(JSON.stringify(prepared)).not.toContain(encoded);
		const disk = path.join(store.root, "history.json");
		await writeFile(
			disk,
			JSON.stringify([{ role: "user", content: prepared }]),
		);
		const reloaded = new ImageArtifactStore(store.root);
		const { metadata, bytes } = await reloaded.read(ref.image_ref.artifact_id);
		expect(metadata.kind).toBe("attachment");
		expect(metadata).not.toHaveProperty("provider");
		expect(bytes).toEqual(Buffer.from(encoded, "base64"));
		let paidMock = 0;
		let approved = false;
		const tools = createImageTools({
			store: reloaded,
			authorize: () => {
				approved = true;
				return { decision: "allow" };
			},
			route: {
				authMode: "api_key",
				provider: "openai",
				model: "gpt-image-2",
				endpoint: "https://api.openai.com/v1/images/generations",
				apiKey: "fixture-key",
				options: {},
			},
			fetcher: async (_url, init) => {
				paidMock++;
				expect(approved).toBe(true);
				if (!(init?.body instanceof FormData))
					throw Error("expected multipart reference");
				const file = init.body.getAll("image[]")[0];
				if (!(file instanceof Blob)) throw Error("expected image bytes");
				expect(file.type).toBe(mediaType);
				expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
				return Response.json({ data: [{ b64_json: referencePng64 }] });
			},
		});
		const generate = tools.find((t) => t.name === "image_generate");
		if (!generate) throw Error("missing generation tool");
		const result = await generate.executeRaw(
			JSON.stringify({
				prompt: "variation",
				images: [{ type: "artifact", artifact_id: ref.image_ref.artifact_id }],
			}),
			createToolContext(),
		);
		expect(paidMock).toBe(1);
		if (result.type !== "parts") throw Error("missing result");
		const output = result.parts.find((p) => p.type === "image_ref");
		if (output?.type !== "image_ref") throw Error("missing output");
		const generated = (await reloaded.read(output.image_ref.artifact_id))
			.metadata;
		if (generated.kind === "attachment") throw Error("wrong provenance");
		expect(generated.parent_artifact_ids).toEqual([ref.image_ref.artifact_id]);
		const calls: ChatInvokeInput[] = [];
		const agent = new Agent({
			llm: {
				provider: "openai",
				model: "fixture",
				ainvoke: async (request) => {
					const { signal: _signal, ...snapshot } = request;
					calls.push(structuredClone(snapshot));
					return { messages: [{ role: "assistant", content: "done" }] };
				},
			},
			tools: [],
			compaction: null,
			services: { resolveImage: reloaded.resolve.bind(reloaded) },
		});
		const history: BaseMessage[] = JSON.parse(await readFile(disk, "utf8"));
		agent.replaceHistoryMessages(history);
		await agent.run("continue");
		await agent.run("continue again");
		expect(calls[0]?.messages[0]?.content).toContainEqual(inline);
		expect(calls[1]?.messages.slice(0, calls[0]?.messages.length)).toEqual(
			calls[0]?.messages,
		);
	});

test("invalid attachment inputs fail explicitly; remote URLs are not downloaded; GIF is not silently converted for generation", async () => {
	const store = await storeFixture();
	for (const url of [
		"data:image/png;base64,???",
		`data:image/jpeg;base64,${referencePng64}`,
		"data:image/svg+xml;base64,PHN2Zy8+",
	])
		await expect(
			persistImageAttachments(
				[{ type: "image_url", image_url: { url } }],
				store,
			),
		).rejects.toThrow();
	const remote: ContentPart[] = [
		{
			type: "image_url",
			image_url: { url: "https://do-not-fetch.invalid/p.png" },
		},
	];
	expect(await persistImageAttachments(remote, store)).toEqual(remote);
	const gif64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
	const prepared = await persistImageAttachments(
		[
			{
				type: "image_url",
				image_url: { url: `data:image/gif;base64,${gif64}` },
			},
		],
		store,
	);
	if (typeof prepared === "string") throw Error("missing parts");
	const ref = prepared.find((p) => p.type === "image_ref");
	if (ref?.type !== "image_ref") throw Error("missing ref");
	let requests = 0;
	const tool = createImageTools({
		store,
		authorize: () => ({ decision: "allow" }),
		route: {
			authMode: "api_key",
			provider: "openai",
			model: "gpt-image-2",
			endpoint: "https://api.openai.com/v1/images/generations",
			apiKey: "fixture",
			options: {},
		},
		fetcher: async () => {
			requests++;
			throw Error("must not generate");
		},
	}).find((t) => t.name === "image_generate");
	if (!tool) throw Error("missing tool");
	await expect(
		tool.executeRaw(
			JSON.stringify({
				prompt: "edit",
				images: [{ type: "artifact", artifact_id: ref.image_ref.artifact_id }],
			}),
			createToolContext(),
		),
	).rejects.toThrow();
	expect(requests).toBe(0);
});

test("run.start ingests pasted images before model history, run records and session snapshots", async () => {
	const store = await storeFixture();
	const records: SessionRecord[] = [];
	const snapshots: SessionState[] = [];
	const requests: ChatInvokeInput[] = [];
	const state = new RuntimeState();
	state.prepareRunImages = (input) => persistImageAttachments(input, store);
	const agent = new Agent({
		tools: [],
		compaction: null,
		services: { resolveImage: store.resolve.bind(store) },
		llm: {
			provider: "openai",
			model: "fixture",
			ainvoke: async (input) => {
				requests.push(
					structuredClone({ messages: input.messages, tools: input.tools }),
				);
				return { messages: [{ role: "assistant", content: "done" }] };
			},
		},
	});
	const handlers = createRunHandlers({
		state,
		getAgent: async () => agent,
		log: () => {},
		appendSession: (record) => {
			records.push(structuredClone(record));
		},
		runEventStoreFactory: {
			create: () => ({
				append: (record) => {
					records.push(structuredClone(record));
				},
			}),
		},
		sessionStateStore: {
			load: async () => null,
			save: async (snapshot) => {
				snapshots.push(structuredClone(snapshot));
			},
			list: async () => [],
		},
	});
	const originalWrite = process.stdout.write;
	const output: string[] = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		output.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		await handlers.handleRunStart("paste", {
			input: {
				type: "parts",
				parts: [
					{
						type: "image_url",
						image_url: { url: `data:image/png;base64,${referencePng64}` },
					},
					{ type: "text", text: "describe" },
				],
			},
		});
		const deadline = Date.now() + 4000;
		while (state.activeRunId) {
			if (Date.now() > deadline) throw Error("run did not settle");
			await Bun.sleep(5);
		}
	} finally {
		process.stdout.write = originalWrite;
	}
	expect(output.join("")).not.toContain('"error":');
	expect(output.join("")).not.toContain('"status":"error"');
	expect(requests).toHaveLength(1);
	expect(JSON.stringify(requests)).toContain(referencePng64);
	expect(JSON.stringify(records)).not.toContain(referencePng64);
	expect(JSON.stringify(snapshots)).not.toContain(referencePng64);
	expect(snapshots.length).toBeGreaterThan(0);
	const start = records.find((record) => record.type === "run.start");
	expect(JSON.stringify(start)).toContain('"type":"image_ref"');
	expect(output.join("")).not.toContain('"status":"error"');
});
