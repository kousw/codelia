import { createHash } from "node:crypto";
import { isValidVersion } from "./semver";

export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
export const CLI_PACKAGE_NAME = "@codelia/cli";
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const MAX_REGISTRY_RESPONSE_BYTES = 256 * 1024;

export type FetchLike = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

export const normalizeRegistryUrl = (raw: string | undefined): string => {
	const candidate = (raw ?? "").trim() || DEFAULT_REGISTRY_URL;
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		throw new Error("Invalid npm registry URL");
	}
	if (parsed.protocol !== "https:") {
		throw new Error("Registry URL must use https");
	}
	if (parsed.username || parsed.password) {
		throw new Error("Registry URL must not include embedded credentials");
	}
	const pathname = parsed.pathname.replace(/\/+$/, "");
	return `${parsed.origin}${pathname}`;
};

export const resolveRegistryUrl = (
	env: NodeJS.ProcessEnv = process.env,
): string => normalizeRegistryUrl(env.npm_config_registry);

export const computeRegistryId = (registryUrl: string): string =>
	createHash("sha256").update(registryUrl).digest("hex");

const readBoundedText = async (
	response: Response,
	maxBytes: number,
): Promise<string> => {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength) {
		const parsedLength = Number.parseInt(declaredLength, 10);
		if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
			throw new Error("Registry response exceeded maximum allowed size");
		}
	}
	if (!response.body) {
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > maxBytes) {
			throw new Error("Registry response exceeded maximum allowed size");
		}
		return text;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error("Registry response exceeded maximum allowed size");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total).toString("utf8");
};

export type FetchLatestOptions = {
	registryUrl: string;
	channel: string;
	fetchImpl?: FetchLike;
	signal?: AbortSignal;
	timeoutMs?: number;
};

export const fetchLatestVersion = async (
	options: FetchLatestOptions,
): Promise<string> => {
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
	const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const endpoint = `${options.registryUrl}/-/package/${encodeURIComponent(CLI_PACKAGE_NAME)}/dist-tags`;
		const response = await fetchImpl(endpoint, {
			method: "GET",
			headers: { accept: "application/json" },
			redirect: "error",
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`Registry returned HTTP ${response.status}`);
		}
		const raw = await readBoundedText(response, MAX_REGISTRY_RESPONSE_BYTES);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error("Registry returned invalid JSON");
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error("Registry dist-tags response was not an object");
		}
		const version = (parsed as Record<string, unknown>)[options.channel];
		if (!isValidVersion(version)) {
			throw new Error(
				`Registry dist-tag "${options.channel}" has no valid semver version`,
			);
		}
		return version;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
};
