import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import {
	IMAGE_REFERENCE_MAX_BYTES,
	validateImageReference,
} from "../src/image-generation/references";
import {
	createImageLookup,
	createLocalImageSourceReader,
	downloadImageSource,
	imageSourceUrl,
	isPublicImageAddress,
	requestImage,
} from "../src/image-generation/source-reader";
import { SandboxContext } from "../src/sandbox/context";
import {
	referenceJpeg64,
	referencePng64,
	referenceWebp64,
} from "./image-source-fixtures";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

function response(
	chunks: Uint8Array[] | null,
	status = 200,
	headers = {},
): IncomingMessage {
	const result = new IncomingMessage(new Socket());
	result.statusCode = status;
	result.headers = headers;
	result._read = () => {};
	if (chunks) {
		for (const chunk of chunks) result.push(chunk);
		result.complete = true;
		result.push(null);
	}
	return result;
}

test("source types come from original PNG/JPEG/WebP bytes, not a filename or claimed MIME", () => {
	for (const [base64, mime] of [
		[referencePng64, "image/png"],
		[referenceJpeg64, "image/jpeg"],
		[referenceWebp64, "image/webp"],
	] as const) {
		const bytes = Buffer.from(base64, "base64");
		expect(validateImageReference(bytes)).toEqual({
			type: "bytes",
			bytes,
			media_type: mime,
		});
	}
	for (const bytes of [
		Buffer.from("<html>not an image</html>"),
		Buffer.alloc(0),
		Buffer.alloc(IMAGE_REFERENCE_MAX_BYTES + 1),
	])
		expect(() => validateImageReference(bytes)).toThrow(
			"no generation was attempted",
		);
	const oversized = Buffer.from(referencePng64, "base64");
	oversized.writeUInt32BE(5000, 16);
	expect(() => validateImageReference(oversized)).toThrow("4096 pixels");
});

test("source URLs reject local/reserved IPs, normalized IP aliases, credentials and unsafe schemes", () => {
	for (const url of [
		"file:///tmp/image.png",
		"https://user:secret@example.com/a",
		"http://127.1/a",
		"http://0x7f000001/a",
		"http://2130706433/a",
		"http://localhost/a",
		"http://x.localhost/a",
		"http://10.0.0.1/a",
		"http://169.254.169.254/a",
		"http://[::1]/a",
		"http://[::ffff:127.0.0.1]/a",
		"http://[fc00::1]/a",
		"https://example.com:8080/a",
		"https://example.com/a#fragment",
	])
		expect(() => imageSourceUrl(url)).toThrow("public HTTP(S)");
	for (const address of [
		"192.168.1.1",
		"100.64.0.1",
		"192.0.2.1",
		"2001:db8::1",
		"2002:7f00:1::",
		"3fff::1",
		"224.0.0.1",
		"255.255.255.255",
		"::ffff:8.8.8.8",
	])
		expect(isPublicImageAddress(address)).toBe(false);
	for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
		expect(isPublicImageAddress(address)).toBe(true);
	expect(imageSourceUrl("https://images.example.com/render?id=2").search).toBe(
		"?id=2",
	);
});

test("socket lookup pins validated DNS answers and rejects mixed public/private resolution", async () => {
	let resolutions = 0;
	const resolve = createImageLookup(async () => {
		resolutions++;
		return [{ address: "8.8.8.8", family: 4 }];
	});
	await new Promise<void>((done, reject) =>
		resolve("example.com", { all: true }, (error, address) => {
			if (error) return reject(error);
			expect(address).toEqual([{ address: "8.8.8.8", family: 4 }]);
			done();
		}),
	);
	expect(resolutions).toBe(1);
	const bad = createImageLookup(async () => [
		{ address: "8.8.8.8", family: 4 },
		{ address: "127.0.0.1", family: 4 },
	]);
	await new Promise<void>((done) =>
		bad("example.com", {}, (error) => {
			expect(error?.message).toContain("not public");
			done();
		}),
	);
});

test("remote reads are bounded unauthenticated binary GETs with no redirects or provider headers", async () => {
	const bytes = Buffer.from(referencePng64, "base64");
	const original = response([bytes.subarray(0, 20), bytes.subarray(20)]);
	const result = await downloadImageSource(
		"https://images.example.com/render?id=2",
		undefined,
		async (url, options) => {
			expect(url.href).toBe("https://images.example.com/render?id=2");
			expect(options.agent).toBe(false);
			expect(options.method).toBe("GET");
			expect(options.lookup).toBeFunction();
			expect(options.servername).toBe("images.example.com");
			expect(options.signal).toBeInstanceOf(AbortSignal);
			expect(options.headers).toEqual({
				Host: "images.example.com",
				Accept: "image/png,image/jpeg,image/webp",
				"Accept-Encoding": "identity",
			});
			return original;
		},
	);
	expect(Buffer.from(result)).toEqual(bytes);
	expect(original.destroyed).toBe(true);
	for (const stream of [
		response([bytes], 302, { location: "http://127.0.0.1/private" }),
		response([], 404),
		response([bytes], 200, {
			"content-length": String(IMAGE_REFERENCE_MAX_BYTES + 1),
		}),
		response([bytes], 200, { "content-encoding": "gzip" }),
		response([Buffer.alloc(IMAGE_REFERENCE_MAX_BYTES), Buffer.from([1])]),
	]) {
		let calls = 0;
		await expect(
			downloadImageSource("https://example.com/a", undefined, async () => {
				calls++;
				return stream;
			}),
		).rejects.toThrow("No generation was attempted");
		expect(calls).toBe(1);
		expect(stream.destroyed).toBe(true);
	}
});

test("real source transport completes binary responses and cancels before headers", async () => {
	const bytes = Buffer.from(referencePng64, "base64");
	const server = createServer((request, result) => {
		if (request.url === "/image") result.end(bytes);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No test port");
		const url = new URL(`http://127.0.0.1:${address.port}/image`);
		// Only this low-level transport test uses loopback, never the source policy.
		const stream = await requestImage(url, { agent: false });
		const chunks: Uint8Array[] = [];
		for await (const chunk of stream) chunks.push(chunk);
		expect(Buffer.concat(chunks)).toEqual(bytes);
		url.pathname = "/stall";
		await expect(
			requestImage(url, { agent: false, signal: AbortSignal.timeout(30) }),
		).rejects.toThrow();
		await expect(
			requestImage(url, { agent: false, signal: AbortSignal.abort() }),
		).rejects.toThrow();
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			server.closeAllConnections();
		});
	}
});

test("Bun proxy environments fail closed instead of bypassing pinned DNS", async () => {
	const module = new URL(
		"../src/image-generation/source-reader.ts",
		import.meta.url,
	);
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`
			import { downloadImageSource } from ${JSON.stringify(module.href)};
			try { await downloadImageSource("https://images.example.invalid/a.png"); process.exitCode = 1; }
			catch (error) { console.log(error.message); }
		`,
		],
		{
			env: { ...process.env, HTTPS_PROXY: "http://127.0.0.1:9" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const output = await new Response(child.stdout).text();
	expect(await child.exited).toBe(0);
	expect(output).toContain("proxy-configured Bun is unsupported");
	expect(output).not.toContain("127.0.0.1");
});

test("stalled image bodies terminate on timeout or caller cancellation", async () => {
	for (const cancel of [false, true]) {
		const stream = response(null);
		const controller = new AbortController();
		const pending = downloadImageSource(
			"https://example.com/a",
			controller.signal,
			async () => stream,
			cancel ? 1000 : 20,
		);
		if (cancel) setTimeout(() => controller.abort(), 5);
		await expect(pending).rejects.toThrow("No generation was attempted");
		expect(stream.destroyed).toBe(true);
	}
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	await expect(
		downloadImageSource(
			"https://example.com/a",
			controller.signal,
			async () => {
				calls++;
				return response([]);
			},
		),
	).rejects.toThrow();
	expect(calls).toBe(0);
});

test("file references use regular bounded files and realpath sandbox confinement", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "codelia-image-source-"));
	roots.push(root);
	const outside = await mkdtemp(
		path.join(os.tmpdir(), "codelia-image-outside-"),
	);
	roots.push(outside);
	const bytes = Buffer.from(referenceJpeg64, "base64");
	await writeFile(path.join(root, "photo.dat"), bytes);
	await writeFile(
		path.join(root, "large.png"),
		Buffer.alloc(IMAGE_REFERENCE_MAX_BYTES + 1),
	);
	await writeFile(path.join(outside, "outside.jpg"), bytes);
	await symlink(
		path.join(outside, "outside.jpg"),
		path.join(root, "escape.jpg"),
	);
	const reader = createLocalImageSourceReader(
		await SandboxContext.create(root),
	);
	expect(await reader({ type: "file", file_path: "photo.dat" })).toEqual(bytes);
	for (const file_path of [
		"escape.jpg",
		path.join(outside, "outside.jpg"),
		"missing.png",
		"large.png",
		".",
	])
		await expect(reader({ type: "file", file_path })).rejects.toThrow(
			"no generation was attempted",
		);
	const unrestricted = createLocalImageSourceReader(
		await SandboxContext.create(root, { approvalMode: "full-access" }),
	);
	expect(
		await unrestricted({
			type: "file",
			file_path: path.join(outside, "outside.jpg"),
		}),
	).toEqual(bytes);
});
