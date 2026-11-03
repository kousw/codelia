// Run only in isolated child processes: these tests deliberately configure proxies.
import assert from "node:assert/strict";
import { createServer, type ProxyEnv, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import {
	createImageLookup,
	downloadImageSource,
	requestImage,
} from "../src/image-generation/source-reader";
import { referencePng64 } from "./image-source-fixtures";
import {
	imageSourceTestCert,
	imageSourceTestKey,
} from "./image-source-tls-fixtures";

const bytes = Buffer.from(referencePng64, "base64");
const proxyAuthorization = `Basic ${Buffer.from("fixture:proxy-password").toString("base64")}`;
const proxyKeys = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
] as const;
function proxies(values: ProxyEnv = {}) {
	for (const key of proxyKeys) delete process.env[key];
	Object.assign(process.env, values);
}
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	return address.port;
}
async function close(server: Server) {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
		server.closeAllConnections();
	});
}

proxies();
const origin = createServer((request, result) => {
	if (request.url === "/image") result.end(bytes);
});
const originPort = await listen(origin);
try {
	// Loopback is confined to this low-level transport test, never URL policy.
	const url = new URL(`http://127.0.0.1:${originPort}/image`);
	const response = await requestImage(url, { agent: false });
	const chunks: Uint8Array[] = [];
	for await (const chunk of response) chunks.push(chunk);
	assert.deepEqual(Buffer.concat(chunks), bytes);
	url.pathname = "/stall";
	await assert.rejects(
		requestImage(url, { agent: false, signal: AbortSignal.timeout(30) }),
	);
	await assert.rejects(
		requestImage(url, { agent: false, signal: AbortSignal.abort() }),
	);
} finally {
	await close(origin);
}

// Node 20 remains supported for direct transport. Its Agent silently ignores
// proxyEnv, so configured proxies must explicitly fail rather than change route.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (
	!process.versions.bun &&
	!(
		nodeMajor >= 25 ||
		(nodeMajor === 24 && nodeMinor >= 5) ||
		(nodeMajor === 22 && nodeMinor >= 21)
	)
) {
	proxies({ HTTP_PROXY: "http://fixture:proxy-password@127.0.0.1:9" });
	await assert.rejects(
		downloadImageSource("http://images.example.invalid/image"),
		/Image URL proxies require/,
	);
	console.log(
		"Image transport: direct bytes/cancellation and unsupported Node proxy refusal; no fallback passed",
	);
	process.exit(0);
}

let requests = 0;
let connects = 0;
let secureRequests = 0;
let tunnelPort: number | undefined;
let stalledConnect: ((socket: Duplex) => void) | undefined;
const tunnels = new Set<Duplex>();
const secureOrigin = createHttpsServer(
	{ key: imageSourceTestKey, cert: imageSourceTestCert },
	(request, response) => {
		secureRequests++;
		assert.equal(request.headers.host, "images.example.invalid");
		assert.equal(request.headers.authorization, undefined);
		assert.equal(request.headers["proxy-authorization"], undefined);
		response.end(bytes);
	},
);
const securePort = await listen(secureOrigin);
const proxy = createServer((request, result) => {
	requests++;
	assert.equal(request.method, "GET");
	assert.equal(request.headers.host, "images.example.invalid");
	assert.equal(request.headers.authorization, undefined);
	assert.equal(request.headers["proxy-authorization"], proxyAuthorization);
	const url = new URL(request.url ?? "");
	assert.equal(url.origin, "http://images.example.invalid");
	if (url.pathname === "/redirect") {
		result.writeHead(302, { location: "http://127.0.0.1/private" });
		result.end();
	} else if (url.pathname === "/stall") {
		// Cancellation must close this otherwise unanswered request.
	} else if (url.pathname === "/body-stall") {
		result.writeHead(200);
		result.write(bytes.subarray(0, 10));
	} else {
		result.end(bytes);
	}
});
proxy.on("connect", (request, socket) => {
	connects++;
	assert.match(request.url ?? "", /^(images|wrong)\.example\.invalid:443$/);
	assert.equal(request.headers.authorization, undefined);
	assert.equal(request.headers["proxy-authorization"], proxyAuthorization);
	if (stalledConnect) {
		tunnels.add(socket);
		socket.on("close", () => tunnels.delete(socket));
		socket.resume();
		stalledConnect(socket);
		return;
	}
	if (tunnelPort) {
		tunnels.add(socket);
		const upstream = connect(tunnelPort, "127.0.0.1", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			socket.pipe(upstream).pipe(socket);
		});
		tunnels.add(upstream);
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
		upstream.on("close", () => {
			socket.destroy();
			tunnels.delete(upstream);
		});
		socket.on("close", () => {
			upstream.destroy();
			tunnels.delete(socket);
		});
		return;
	}
	socket.end(
		"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
	);
});
const proxyPort = await listen(proxy);
// A private proxy hostname is an intentionally trusted route, not an image URL.
const proxyUrl = `http://fixture:proxy-password@localhost:${proxyPort}`;
try {
	for (const values of [
		{ HTTP_PROXY: proxyUrl },
		{ http_proxy: proxyUrl, HTTP_PROXY: "http://127.0.0.1:9" },
		{ ALL_PROXY: proxyUrl },
		{ all_proxy: proxyUrl, ALL_PROXY: "http://127.0.0.1:9" },
	]) {
		proxies(values);
		const before = requests;
		assert.deepEqual(
			await downloadImageSource("http://images.example.invalid/image"),
			bytes,
		);
		assert.equal(requests, before + 1);
	}
	for (const pathname of ["redirect", "stall", "body-stall"]) {
		const before = requests;
		await assert.rejects(
			downloadImageSource(
				`http://images.example.invalid/${pathname}`,
				undefined,
				requestImage,
				150,
			),
			/No generation was attempted/,
		);
		assert.equal(requests, before + 1);
	}

	// NO_PROXY uses the original socket lookup, including private-IP rejection.
	for (const values of [
		{ HTTP_PROXY: proxyUrl, NO_PROXY: "images.example.invalid" },
		{ HTTP_PROXY: proxyUrl, no_proxy: "*", NO_PROXY: "other.invalid" },
	]) {
		proxies(values);
		const before = requests;
		let lookups = 0;
		await assert.rejects(
			requestImage(new URL("http://images.example.invalid/image"), {
				agent: false,
				lookup: createImageLookup(async () => {
					lookups++;
					return [{ address: "127.0.0.1", family: 4 }];
				}),
				signal: AbortSignal.timeout(1000),
			}),
			/not public/,
		);
		assert.equal(lookups, 1);
		assert.equal(requests, before);
	}

	proxies({ HTTPS_PROXY: proxyUrl });
	await assert.rejects(
		downloadImageSource("https://images.example.invalid/image"),
		(error: Error) => {
			assert(!error.message.includes("proxy-password"));
			assert(!error.message.includes(String(proxyPort)));
			return /No generation was attempted/.test(error.message);
		},
	);
	assert.equal(connects, 1);
	for (const callerAbort of [false, true]) {
		let accept!: () => void;
		const accepted = new Promise<void>((resolve) => {
			accept = resolve;
		});
		// Keep an accepted but unanswered CONNECT half-open until the client ends
		// it. request.destroy alone did not own this native agent socket.
		let ended!: Promise<void>;
		stalledConnect = (socket) => {
			ended = new Promise<void>((resolve) =>
				socket.once("end", () => {
					socket.end();
					resolve();
				}),
			);
			accept();
		};
		const controller = new AbortController();
		const pending = downloadImageSource(
			"https://images.example.invalid/image",
			controller.signal,
			requestImage,
			callerAbort ? 5000 : 1000,
		);
		const rejected = assert.rejects(pending, /No generation was attempted/);
		await accepted;
		if (callerAbort) controller.abort();
		await rejected;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Cancelled CONNECT socket remained open")),
				1000,
			);
			void ended.then(() => {
				clearTimeout(timer);
				resolve();
			}, reject);
		});
	}
	stalledConnect = undefined;

	tunnelPort = securePort;
	const trustedTls = (
		target: URL,
		options: Parameters<typeof requestImage>[1],
	) => requestImage(target, { ...options, ca: imageSourceTestCert });
	assert.deepEqual(
		await downloadImageSource(
			"https://images.example.invalid/image",
			undefined,
			trustedTls,
		),
		bytes,
	);
	assert.equal(secureRequests, 1);
	// Trust is supplied only for this request. Default TLS rejects the self-signed
	// identity, and even that CA cannot authorize a different origin hostname.
	await assert.rejects(
		downloadImageSource("https://images.example.invalid/image"),
		/No generation was attempted/,
	);
	await assert.rejects(
		downloadImageSource(
			"https://wrong.example.invalid/image",
			undefined,
			trustedTls,
		),
		/No generation was attempted/,
	);
	assert.equal(secureRequests, 1);

	// Proxy failures must never retry a direct connection or expose credentials.
	for (const url of [
		"http://fixture:proxy-password@127.0.0.1:9",
		"http://fixture:proxy-password@proxy.invalid:99999",
		"socks5://fixture:proxy-password@localhost:9",
	]) {
		proxies({ HTTP_PROXY: url });
		let lookups = 0;
		await assert.rejects(
			downloadImageSource(
				"http://images.example.invalid/image",
				undefined,
				(target, options) =>
					requestImage(target, {
						...options,
						lookup: (...args) => {
							lookups++;
							createImageLookup()(...args);
						},
					}),
			),
			(error: Error) => {
				assert(!error.message.includes("proxy-password"));
				return /no generation was attempted/i.test(error.message);
			},
		);
		assert.equal(lookups, 0);
	}
	console.log(
		"Image transport: direct bytes/cancellation, proxy routing/bounds, NO_PROXY DNS, HTTPS CONNECT, redaction and no fallback passed",
	);
} finally {
	for (const socket of tunnels) socket.destroy();
	await close(proxy);
	await close(secureOrigin);
}
