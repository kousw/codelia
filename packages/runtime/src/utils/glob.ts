import { promises as fs } from "node:fs";
import path from "node:path";

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
): Promise<void> => {
	const entries = await fs.readdir(startDir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(startDir, entry.name);
		if (entry.isDirectory()) {
			await walkFiles(fullPath, visitor);
		} else if (entry.isFile()) {
			const shouldContinue = await visitor(fullPath);
			if (!shouldContinue) return;
		}
	}
};

export const globMatch = async (
	searchDir: string,
	rootDir: string,
	pattern: string,
): Promise<string[]> => {
	const regex = globToRegExp(pattern.replaceAll("\\", "/"));
	const matches: string[] = [];
	await walkFiles(searchDir, async (filePath) => {
		const relPath = path.relative(rootDir, filePath).replaceAll("\\", "/");
		if (regex.test(relPath)) {
			matches.push(relPath);
		}
		return matches.length < 200;
	});
	return matches;
};
