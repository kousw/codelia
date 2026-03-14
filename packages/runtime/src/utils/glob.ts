import { promises as fs } from "node:fs";
import path from "node:path";

export type GlobMatchResult = {
	matches: string[];
	total_matches: number | null;
	truncated: boolean;
};

export const globToRegExp = (pattern: string): RegExp => {
	const normalized = pattern.replaceAll("\\", "/");
	const globDirToken = "__GLOBSTAR_DIR__";
	const globAnyToken = "__GLOBSTAR__";
	const globSingleToken = "__GLOBSTAR_SINGLE__";
	const globCharToken = "__GLOBSTAR_CHAR__";
	const withTokens = normalized
		.replace(/\*\*\//g, globDirToken)
		.replace(/\*\*/g, globAnyToken)
		.replace(/\*/g, globSingleToken)
		.replace(/\?/g, globCharToken);
	const escaped = withTokens.replace(/[.+^$(){}|[\]\\]/g, "\\$&");
	const withGlob = escaped
		.replace(new RegExp(globDirToken, "g"), "(?:.+/)?")
		.replace(new RegExp(globAnyToken, "g"), ".+")
		.replace(new RegExp(globSingleToken, "g"), "[^/]*")
		.replace(new RegExp(globCharToken, "g"), ".");
	return new RegExp(`^${withGlob}$`);
};

export const walkFiles = async (
	startDir: string,
	visitor: (filePath: string) => Promise<boolean> | boolean,
): Promise<boolean> => {
	const entries = (await fs.readdir(startDir, { withFileTypes: true })).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	for (const entry of entries) {
		const fullPath = path.join(startDir, entry.name);
		if (entry.isDirectory()) {
			const shouldContinue = await walkFiles(fullPath, visitor);
			if (!shouldContinue) return false;
		} else if (entry.isFile()) {
			const shouldContinue = await visitor(fullPath);
			if (!shouldContinue) return false;
		}
	}
	return true;
};

export const globMatch = async (
	searchDir: string,
	pattern: string,
	scanLimit = 200,
	visibleLimit = scanLimit,
): Promise<GlobMatchResult> => {
	const regex = globToRegExp(pattern.replaceAll("\\", "/"));
	const matches: string[] = [];
	let totalMatches = 0;
	let truncated = false;
	await walkFiles(searchDir, async (filePath) => {
		const relPath = path.relative(searchDir, filePath).replaceAll("\\", "/");
		if (!regex.test(relPath)) {
			return true;
		}
		totalMatches += 1;
		if (matches.length < visibleLimit) {
			matches.push(relPath);
		}
		if (totalMatches > scanLimit) {
			truncated = true;
			return false;
		}
		return true;
	});
	return {
		matches,
		total_matches: truncated ? null : totalMatches,
		truncated,
	};
};
