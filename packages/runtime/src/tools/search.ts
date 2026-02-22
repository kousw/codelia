import type { Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";

type SearchBackend = "ddg" | "brave";

type SearchResultEntry = {
	title: string;
	url: string;
	snippet: string;
	source: SearchBackend;
};

export type SearchToolOptions = {
	defaultBackend: SearchBackend;
	braveApiKeyEnv: string;
};

const normalizeDomain = (value: string): string =>
	value.trim().toLowerCase().replace(/\.+$/, "");

const shouldKeepUrl = (url: string, allowedDomains: string[]): boolean => {
	if (!allowedDomains.length) return true;
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		return allowedDomains.some((domain) => {
			const normalized = normalizeDomain(domain);
			return host === normalized || host.endsWith(`.${normalized}`);
		});
	} catch {
		return false;
	}
};

const normalizeEntries = (
	entries: SearchResultEntry[],
	allowedDomains: string[],
	maxResults: number,
): SearchResultEntry[] => {
	return entries
		.filter((entry) => shouldKeepUrl(entry.url, allowedDomains))
		.slice(0, maxResults);
};

const parseDdg = (payload: unknown): SearchResultEntry[] => {
	const results: SearchResultEntry[] = [];
	if (!payload || typeof payload !== "object") {
		return results;
	}
	const record = payload as Record<string, unknown>;
	const related = Array.isArray(record.RelatedTopics)
		? record.RelatedTopics
		: [];
	for (const topic of related) {
		if (!topic || typeof topic !== "object") {
			continue;
		}
		const typed = topic as Record<string, unknown>;
		if (Array.isArray(typed.Topics)) {
			for (const child of typed.Topics) {
				if (!child || typeof child !== "object") continue;
				const row = child as Record<string, unknown>;
				const text = typeof row.Text === "string" ? row.Text : "";
				const url = typeof row.FirstURL === "string" ? row.FirstURL : "";
				if (!text || !url) continue;
				results.push({
					title: text.split(" - ")[0] ?? text,
					url,
					snippet: text,
					source: "ddg",
				});
			}
			continue;
		}
		const text = typeof typed.Text === "string" ? typed.Text : "";
		const url = typeof typed.FirstURL === "string" ? typed.FirstURL : "";
		if (!text || !url) continue;
		results.push({
			title: text.split(" - ")[0] ?? text,
			url,
			snippet: text,
			source: "ddg",
		});
	}
	return results;
};

const parseBrave = (payload: unknown): SearchResultEntry[] => {
	const results: SearchResultEntry[] = [];
	if (!payload || typeof payload !== "object") {
		return results;
	}
	const record = payload as Record<string, unknown>;
	const web = record.web;
	if (!web || typeof web !== "object") {
		return results;
	}
	const rows = Array.isArray((web as Record<string, unknown>).results)
		? ((web as Record<string, unknown>).results as unknown[])
		: [];
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const typed = row as Record<string, unknown>;
		const title = typeof typed.title === "string" ? typed.title : "";
		const url = typeof typed.url === "string" ? typed.url : "";
		const snippet =
			typeof typed.description === "string" ? typed.description : "";
		if (!title || !url) continue;
		results.push({
			title,
			url,
			snippet,
			source: "brave",
		});
	}
	return results;
};

const runDdgSearch = async (
	query: string,
	maxResults: number,
	allowedDomains: string[],
): Promise<SearchResultEntry[]> => {
	const url = new URL("https://api.duckduckgo.com/");
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("no_html", "1");
	url.searchParams.set("skip_disambig", "1");
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`ddg request failed: status=${response.status}`);
	}
	const payload = (await response.json()) as unknown;
	const parsed = parseDdg(payload);
	return normalizeEntries(parsed, allowedDomains, maxResults);
};

const runBraveSearch = async (
	query: string,
	maxResults: number,
	allowedDomains: string[],
	apiKey: string,
): Promise<SearchResultEntry[]> => {
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(maxResults));
	const response = await fetch(url, {
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": apiKey,
		},
	});
	if (!response.ok) {
		throw new Error(`brave request failed: status=${response.status}`);
	}
	const payload = (await response.json()) as unknown;
	const parsed = parseBrave(payload);
	return normalizeEntries(parsed, allowedDomains, maxResults);
};

export const createSearchTool = (options: SearchToolOptions): Tool =>
	defineTool({
		name: "search",
		description: "Search the web and return concise source candidates.",
		input: z.object({
			query: z.string().min(1).describe("Search query."),
			max_results: z
				.number()
				.int()
				.min(1)
				.max(20)
				.optional()
				.describe("Max results. Default 5."),
			backend: z
				.enum(["ddg", "brave"])
				.optional()
				.describe("Search backend. Default comes from config."),
			allowed_domains: z
				.array(z.string().min(1))
				.optional()
				.describe("Optional allowlist of domains."),
		}),
		execute: async (input) => {
			const backend = input.backend ?? options.defaultBackend;
			const maxResults = input.max_results ?? 5;
			const allowedDomains =
				input.allowed_domains
					?.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0) ?? [];
			try {
				let results: SearchResultEntry[];
				if (backend === "ddg") {
					results = await runDdgSearch(input.query, maxResults, allowedDomains);
				} else {
					const apiKey = process.env[options.braveApiKeyEnv]?.trim();
					if (!apiKey) {
						return `Missing ${options.braveApiKeyEnv} for brave backend.`;
					}
					results = await runBraveSearch(
						input.query,
						maxResults,
						allowedDomains,
						apiKey,
					);
				}
				return {
					query: input.query,
					backend,
					count: results.length,
					results,
				};
			} catch (error) {
				return `Error running search: ${String(error)}`;
			}
		},
	});
