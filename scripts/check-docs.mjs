import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"target",
	"dist",
	"build",
	"tmp",
	".claude",
	"plan",
	".codelia",
]);

const CHECKED_PATH_PREFIXES = [
	"packages/",
	"crates/",
	"docs/",
	"dev-docs/",
	"scripts/",
	"tools/",
	"examples/",
	".agents/",
	".github/",
	"src/",
	"tests/",
	"prompts/",
	"schema/",
];

const RETIRED_TEST_HOOKS = [
	"CODELIA_PROTOCOL_ASSERT",
	"CODELIA_TUI_CAPTURE_PATH",
	"CODELIA_TUI_EMULATOR_DIR",
	"CODELIA_IMAGE_LIVE",
	"CODELIA_IMAGE_PROVIDER",
	"CODELIA_IMAGE_MODEL",
	"CODELIA_IMAGE_ENDPOINT",
	"CODELIA_DEEPSEEK_LIVE",
	"CODELIA_QUALIFICATION_PEER",
	"CODELIA_UPDATE_STEER_FIXTURE",
	"CODELIA_AUTO_REVIEW_CODEX_LIVE",
	"CODELIA_RULE_SUGGESTION_CODEX_LIVE",
];

const toPosix = (filePath) => filePath.split(path.sep).join("/");

const walkMarkdownFiles = (startDir, results = []) => {
	let entries;
	try {
		entries = readdirSync(startDir, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return results;
		throw error;
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry.name)) continue;
		const fullPath = path.join(startDir, entry.name);
		if (entry.isDirectory()) {
			walkMarkdownFiles(fullPath, results);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			results.push(fullPath);
		}
	}
	return results;
};

const stripFencedLines = (lines) => {
	const result = [];
	let inFence = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trimStart();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) {
			result.push({ lineNumber: index + 1, text: line });
		}
	}
	return result;
};

const collectRetiredEnvNames = (envDocPath) => {
	const retired = new Set(RETIRED_TEST_HOOKS);
	const active = new Set();
	if (!existsSync(envDocPath)) return retired;

	const lines = readFileSync(envDocPath, "utf8").split(/\r?\n/);
	const backtickTokenRe = /`([^`]+)`/g;

	const addFromSnippet = (snippet, target) => {
		let lastPrefix = "";
		for (const match of snippet.matchAll(backtickTokenRe)) {
			const token = match[1].trim();
			if (/^CODELIA_[A-Z0-9_]+$/.test(token)) {
				target.add(token);
				if (token.startsWith("CODELIA_AGENTS_")) {
					lastPrefix = "CODELIA_AGENTS_";
				} else if (token.startsWith("CODELIA_TOOL_OUTPUT_CACHE_")) {
					lastPrefix = "CODELIA_TOOL_OUTPUT_CACHE_";
				} else {
					const cut = token.lastIndexOf("_");
					if (cut > "CODELIA".length) {
						lastPrefix = token.slice(0, cut + 1);
					}
				}
			} else if (/^_[A-Z0-9_]+$/.test(token) && lastPrefix) {
				target.add(`${lastPrefix}${token.slice(1)}`);
			}
		}
	};

	for (const line of lines) {
		if (/^\s*\|/.test(line)) {
			addFromSnippet(line, active);
		}
	}

	let mode = "none";
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (
			line.startsWith(
				"Previously env-based handoffs now moved off the environment:",
			) ||
			line.startsWith("Removed in favor of")
		) {
			mode = "bullets";
			continue;
		}
		if (line.startsWith("Removed individual debug env vars folded into")) {
			mode = "paragraph";
			continue;
		}
		if (line === "" || line.startsWith("#")) {
			mode = "none";
			continue;
		}
		if (mode === "bullets") {
			if (!line.startsWith("-")) {
				mode = "none";
				continue;
			}
			const left = line.split("→", 1)[0];
			addFromSnippet(left, retired);
		} else if (mode === "paragraph") {
			addFromSnippet(line, retired);
		}
	}

	for (const name of active) {
		retired.delete(name);
	}
	return retired;
};

const run = () => {
	const errors = [];
	const allMarkdown = walkMarkdownFiles(ROOT_DIR).sort();
	const relOf = (absPath) => toPosix(path.relative(ROOT_DIR, absPath));

	// 1. Disallow RULES.md anywhere in the repository.
	for (const absPath of allMarkdown) {
		if (path.basename(absPath) === "RULES.md") {
			errors.push(`unexpected RULES.md file: ${relOf(absPath)}`);
		}
	}

	const activeDocs = allMarkdown.filter((absPath) => {
		const rel = relOf(absPath);
		if (rel === "README.md" || rel === "AGENTS.md") return true;
		if (rel.startsWith("docs/")) return true;
		if (rel.startsWith("dev-docs/archive/")) {
			return rel === "dev-docs/archive/README.md";
		}
		return rel.startsWith("dev-docs/");
	});

	// 2. Verify relative Markdown links across README.md, AGENTS.md, docs/**, dev-docs/**.
	const mdLinkRe = /\[[^\]]*\]\(([^)]+)\)/g;
	for (const absPath of activeDocs) {
		const rel = relOf(absPath);
		const content = readFileSync(absPath, "utf8");
		for (const { lineNumber, text } of stripFencedLines(
			content.split(/\r?\n/),
		)) {
			for (const match of text.matchAll(mdLinkRe)) {
				const rawHref = match[1].trim().split(/\s+/)[0];
				if (
					!rawHref ||
					rawHref.startsWith("http://") ||
					rawHref.startsWith("https://") ||
					rawHref.startsWith("mailto:") ||
					rawHref.startsWith("#")
				) {
					continue;
				}
				const filePart = rawHref.split("#", 1)[0];
				if (!filePart) continue;
				let decoded = filePart;
				try {
					decoded = decodeURIComponent(filePart);
				} catch {
					// Fall back to literal path when percent-encoding is partial.
				}
				const resolved = path.resolve(path.dirname(absPath), decoded);
				if (!existsSync(resolved)) {
					errors.push(
						`broken relative link in ${rel}:${lineNumber}: ${rawHref} -> ${relOf(resolved)}`,
					);
				}
			}
		}
	}

	// 3. Verify inline backtick repo paths inside all AGENTS.md files.
	const agentsFiles = allMarkdown.filter(
		(absPath) => path.basename(absPath) === "AGENTS.md",
	);
	const inlinePathRe = /`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.*-]+)+)`/g;
	for (const absPath of agentsFiles) {
		const rel = relOf(absPath);
		const content = readFileSync(absPath, "utf8");
		for (const { lineNumber, text } of stripFencedLines(
			content.split(/\r?\n/),
		)) {
			for (const match of text.matchAll(inlinePathRe)) {
				const token = match[1].replace(/[.,:;]+$/, "");
				if (
					token.includes("*") ||
					token.includes("<") ||
					token.includes("://") ||
					token.startsWith("http")
				) {
					continue;
				}
				if (!CHECKED_PATH_PREFIXES.some((prefix) => token.startsWith(prefix))) {
					continue;
				}
				const fromFile = path.resolve(path.dirname(absPath), token);
				const fromRoot = path.resolve(ROOT_DIR, token);
				if (!existsSync(fromFile) && !existsSync(fromRoot)) {
					errors.push(
						`broken path reference in ${rel}:${lineNumber}: \`${token}\``,
					);
				}
			}
		}
	}

	// 4. Disallow retired CODELIA_* env vars in active documentation.
	const retiredEnv = collectRetiredEnvNames(
		path.join(ROOT_DIR, "dev-docs", "environment-variables.md"),
	);
	if (retiredEnv.size > 0) {
		const envScanTargets = new Set([
			...activeDocs,
			...agentsFiles.filter(
				(absPath) => !relOf(absPath).startsWith("examples/"),
			),
		]);
		const envRe = /\bCODELIA_[A-Z0-9_]+\b/g;
		for (const absPath of [...envScanTargets].sort()) {
			const rel = relOf(absPath);
			if (
				rel === "dev-docs/environment-variables.md" ||
				rel.startsWith("dev-docs/archive/") ||
				rel.startsWith("dev-docs/audits/")
			) {
				continue;
			}
			const lines = readFileSync(absPath, "utf8").split(/\r?\n/);
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index];
				if (line.includes("<!-- check-docs:allow-retired-env -->")) continue;
				for (const match of line.matchAll(envRe)) {
					if (retiredEnv.has(match[0])) {
						errors.push(`retired env var in ${rel}:${index + 1}: ${match[0]}`);
					}
				}
			}
		}
	}

	if (errors.length > 0) {
		for (const error of errors) {
			console.error(error);
		}
		process.exit(1);
	}
	console.log(
		`Docs hygiene check passed (${agentsFiles.length} AGENTS.md, ${activeDocs.length} doc files).`,
	);
};

run();
