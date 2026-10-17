import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import path from "node:path";
import type { SandboxContext } from "../sandbox/context";
import { ImageGenerationError } from "./http";
import {
	IMAGE_REFERENCE_MAX_BYTES,
	type ImageSourceReader,
} from "./references";

const blocked = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
] as const)
	blocked.addSubnet(address, prefix, "ipv6");

export function isPublicImageAddress(address: string): boolean {
	const family = isIP(address);
	return family === 4
		? !blocked.check(address, "ipv4")
		: family === 6 &&
				globalV6.check(address, "ipv6") &&
				!blocked.check(address, "ipv6");
}

/** Validate the DNS answer used by the socket itself, avoiding a check/fetch re-resolution. */
export function createImageLookup(
	resolve = (hostname: string) =>
		lookup(hostname, { all: true, verbatim: true }),
): LookupFunction {
	return (hostname, options, callback) => {
		void resolve(hostname).then(
			(addresses) => {
				if (
					!addresses.length ||
					addresses.some((entry) => !isPublicImageAddress(entry.address))
				) {
					callback(new Error("Image source destination is not public"), "");
					return;
				}
				const family =
					options.family === "IPv4"
						? 4
						: options.family === "IPv6"
							? 6
							: options.family;
				const selected = addresses.filter(
					(entry) => !family || entry.family === family,
				);
				const first = selected[0];
				if (!first)
					callback(
						new Error("Image source has no compatible public address"),
						"",
					);
				else if (options.all) callback(null, selected);
				else callback(null, first.address, first.family);
			},
			() => callback(new Error("Image source DNS failed"), ""),
		);
	};
}

export function imageSourceUrl(value: string): URL {
	try {
		const url = new URL(value);
		const host = url.hostname.replace(/^\[|\]$/g, "");
		if (
			!/^https?:$/.test(url.protocol) ||
			url.username ||
			url.password ||
			url.hash ||
			value.length > 8192 ||
			(url.port && url.port !== "80" && url.port !== "443") ||
			host === "localhost" ||
			host.endsWith(".localhost") ||
			host.endsWith(".local") ||
			(isIP(host) && !isPublicImageAddress(host))
		)
			throw new Error("invalid source");
		return url;
	} catch {
		throw new ImageGenerationError(
			"Image source requires a public HTTP(S) URL on port 80/443 without credentials or fragments; no generation was attempted.",
		);
	}
}

type SourceRequest = (
	url: URL,
	options: RequestOptions,
) => Promise<IncomingMessage>;
export const requestImage: SourceRequest = (url, options) =>
	new Promise((resolve, reject) => {
		// Bun's HTTP shim can use environment proxies even with agent:false,
		// bypassing the direct, DNS-pinned destination contract. Fail closed.
		if (
			process.versions.bun &&
			[
				"HTTP_PROXY",
				"HTTPS_PROXY",
				"ALL_PROXY",
				"http_proxy",
				"https_proxy",
				"all_proxy",
			].some((name) => process.env[name])
		)
			throw new ImageGenerationError(
				"Image URL references require a direct connection; proxy-configured Bun is unsupported. Use a local file/artifact reference. No generation was attempted.",
			);
		const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
			url,
			options,
		);
		const cleanup = () => options.signal?.removeEventListener("abort", abort);
		const abort = () => {
			cleanup();
			reject(new Error("Image source request cancelled"));
			request.destroy();
		};
		request.once("response", (response) => {
			cleanup();
			resolve(response);
		});
		// Bun can emit more than one error while exhausting custom DNS candidates.
		request.on("error", (error) => {
			cleanup();
			reject(error);
		});
		request.once("close", () => {
			cleanup();
			reject(new Error("Image source closed before response"));
		});
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		else request.end();
	});

/** Separate unauthenticated transport; never reuse the generation API's headers/fetch client. */
export async function downloadImageSource(
	value: string,
	callerSignal?: AbortSignal,
	transport: SourceRequest = requestImage,
	timeoutMs = 15_000,
): Promise<Uint8Array> {
	const url = imageSourceUrl(value);
	const signal = callerSignal
		? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])
		: AbortSignal.timeout(timeoutMs);
	let response: IncomingMessage | undefined;
	try {
		signal.throwIfAborted();
		response = await transport(url, {
			method: "GET",
			agent: false,
			lookup: createImageLookup(),
			// Preserve the original authority when Bun connects to a validated DNS IP.
			...(url.protocol === "https:" &&
			!isIP(url.hostname.replace(/^\[|\]$/g, ""))
				? { servername: url.hostname }
				: {}),
			signal,
			headers: {
				Host: url.host,
				Accept: "image/png,image/jpeg,image/webp",
				"Accept-Encoding": "identity",
			},
		});
		signal.throwIfAborted();
		if (response.statusCode !== 200)
			throw new Error("non-200 source (redirects are not followed)");
		if (
			response.headers["content-encoding"] &&
			response.headers["content-encoding"] !== "identity"
		)
			throw new Error("compressed transfer unsupported");
		if (
			Number(response.headers["content-length"] ?? 0) >
			IMAGE_REFERENCE_MAX_BYTES
		)
			throw new Error("source too large");
		const stream = response;
		const abort = () =>
			stream.destroy(new Error("Image source read cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		try {
			const chunks: Uint8Array[] = [];
			let size = 0;
			for await (const chunk of stream) {
				signal.throwIfAborted();
				if (!(chunk instanceof Uint8Array)) throw new Error("nonbinary source");
				size += chunk.length;
				if (size > IMAGE_REFERENCE_MAX_BYTES)
					throw new Error("source too large");
				chunks.push(chunk);
			}
			signal.throwIfAborted();
			if (!size) throw new Error("empty source");
			return Buffer.concat(chunks);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	} catch (error) {
		if (error instanceof ImageGenerationError) throw error;
		throw new ImageGenerationError(
			"Image source download failed, timed out, was cancelled, or exceeded limits; redirects/private destinations are not allowed. No generation was attempted.",
		);
	} finally {
		response?.destroy();
	}
}

async function readImageFile(
	sandbox: SandboxContext,
	filePath: string,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	try {
		signal?.throwIfAborted();
		const target = await realpath(sandbox.resolvePath(filePath));
		if (sandbox.approvalMode !== "full-access") {
			const root = await realpath(sandbox.rootDir);
			const relative = path.relative(root, target);
			if (
				relative === ".." ||
				relative.startsWith(`..${path.sep}`) ||
				path.isAbsolute(relative)
			)
				throw new Error("outside sandbox");
		}
		const handle = await open(
			target,
			constants.O_RDONLY |
				(constants.O_NOFOLLOW ?? 0) |
				(constants.O_NONBLOCK ?? 0),
		);
		try {
			const stat = await handle.stat();
			if (
				!stat.isFile() ||
				stat.size <= 0 ||
				stat.size > IMAGE_REFERENCE_MAX_BYTES
			)
				throw new Error("invalid source file");
			const bytes = Buffer.alloc(stat.size + 1);
			let offset = 0;
			while (offset < bytes.length) {
				signal?.throwIfAborted();
				const result = await handle.read(
					bytes,
					offset,
					Math.min(bytes.length - offset, 65536),
					offset,
				);
				if (!result.bytesRead) break;
				offset += result.bytesRead;
			}
			if (offset !== stat.size)
				throw new Error("source file changed during read");
			signal?.throwIfAborted();
			return bytes.subarray(0, offset);
		} finally {
			await handle.close();
		}
	} catch {
		throw new ImageGenerationError(
			"Image reference file is unavailable, outside the sandbox, not a bounded regular file, or reading was cancelled; no generation was attempted.",
		);
	}
}

export function createLocalImageSourceReader(
	sandbox: SandboxContext,
): ImageSourceReader {
	return (source, signal) =>
		source.type === "url"
			? downloadImageSource(source.url, signal)
			: readImageFile(sandbox, source.file_path, signal);
}
