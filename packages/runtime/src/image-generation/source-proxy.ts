import { Agent as HttpAgent, type ProxyEnv } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Duplex } from "node:stream";
import { ImageGenerationError } from "./http";

function ownConnections(agent: HttpAgent): HttpAgent {
	const sockets = new Set<Duplex>();
	const createConnection = agent.createConnection.bind(agent);
	const destroy = agent.destroy.bind(agent);
	agent.createConnection = (options, callback) => {
		// Native HTTPS agents return the proxy socket before registering it in
		// agent.sockets. Own it while CONNECT is pending so cancellation closes it.
		const socket = createConnection(options, callback);
		if (socket) {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
		}
		return socket;
	};
	agent.destroy = () => {
		for (const socket of sockets) socket.destroy();
		destroy();
	};
	return agent;
}

/** Environment proxies are host-configured, trusted network boundaries. */
export function createImageSourceAgent(protocol: string): HttpAgent | false {
	const fallback = process.env.all_proxy || process.env.ALL_PROXY;
	const proxyEnv: ProxyEnv = {
		http_proxy: process.env.http_proxy || process.env.HTTP_PROXY || fallback,
		https_proxy: process.env.https_proxy || process.env.HTTPS_PROXY || fallback,
		no_proxy: process.env.no_proxy || process.env.NO_PROXY,
	};
	const proxy =
		protocol === "https:" ? proxyEnv.https_proxy : proxyEnv.http_proxy;
	if (!proxy) return false;

	// Older runtimes silently ignore proxyEnv, which would change the route.
	const bun = process.versions.bun;
	const [major, minor, patch] = (bun || process.versions.node)
		.split(".")
		.map(Number);
	const supported = bun
		? major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 4)))
		: major >= 25 ||
			(major === 24 && minor >= 5) ||
			(major === 22 && minor >= 21);
	if (!supported)
		throw new ImageGenerationError(
			"Image URL proxies require Bun 1.4.4+, Node 22.21.x or Node 24.5+; no generation was attempted.",
		);

	// Validate without echoing credentials from malformed/unsupported proxy URLs.
	try {
		const url = new URL(proxy);
		if (url.protocol !== "http:" && url.protocol !== "https:")
			throw new Error("unsupported proxy scheme");
		return ownConnections(
			protocol === "https:"
				? new HttpsAgent({ keepAlive: false, proxyEnv })
				: new HttpAgent({ keepAlive: false, proxyEnv }),
		);
	} catch {
		throw new ImageGenerationError(
			"Image URL proxy configuration requires a valid HTTP(S) proxy URL; no generation was attempted.",
		);
	}
}
