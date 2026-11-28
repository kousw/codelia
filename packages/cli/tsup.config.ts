import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const cliPackageJson = JSON.parse(
	fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string };
const cliVersion = cliPackageJson.version ?? "0.0.0";

const resolveGitDir = (repoRoot: string): string | null => {
	const dotGit = path.join(repoRoot, ".git");
	try {
		const stat = fs.statSync(dotGit);
		if (stat.isDirectory()) return dotGit;
		if (stat.isFile()) {
			const content = fs.readFileSync(dotGit, "utf8").trim();
			const match = content.match(/^gitdir:\s*(.+)$/);
			if (!match) return null;
			return path.isAbsolute(match[1])
				? match[1]
				: path.resolve(repoRoot, match[1]);
		}
	} catch {
		return null;
	}
	return null;
};

const readHeadShaFromGitDir = (gitDir: string): string | null => {
	try {
		const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
		if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 8);
		const refMatch = head.match(/^ref:\s*(.+)$/);
		if (!refMatch) return null;
		const refName = refMatch[1].trim();
		const refPath = path.join(gitDir, refName);
		if (fs.existsSync(refPath)) {
			const sha = fs.readFileSync(refPath, "utf8").trim();
			if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 8);
		}
		const packedPath = path.join(gitDir, "packed-refs");
		if (fs.existsSync(packedPath)) {
			for (const line of fs.readFileSync(packedPath, "utf8").split("\n")) {
				if (!line || line.startsWith("#") || line.startsWith("^")) continue;
				const [sha, name] = line.trim().split(/\s+/);
				if (name === refName && sha && /^[0-9a-f]{7,40}$/i.test(sha)) {
					return sha.slice(0, 8);
				}
			}
		}
	} catch {
		return null;
	}
	return null;
};

const resolveDevBuildId = (): string => {
	if (process.env.CI === "true" || process.env.CODELIA_RELEASE_BUILD === "1") {
		return "";
	}
	const repoRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../..",
	);
	const gitDir = resolveGitDir(repoRoot);
	let sha = gitDir ? readHeadShaFromGitDir(gitDir) : null;
	if (!sha) {
		try {
			sha = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			sha = null;
		}
	}
	if (!sha) return "";
	try {
		const dirty =
			execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim().length > 0;
		return dirty ? `${sha}-dirty` : sha;
	} catch {
		return sha;
	}
};

const cliBuild = resolveDevBuildId();

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	dts: true,
	clean: true,
	platform: "node",
	define: {
		__CODELIA_CLI_VERSION__: JSON.stringify(cliVersion),
		__CODELIA_CLI_BUILD__: JSON.stringify(cliBuild),
	},
	banner: ({ format }) =>
		format === "cjs" ? { js: "#!/usr/bin/env node" } : undefined,
});
