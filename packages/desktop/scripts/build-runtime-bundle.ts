import { mkdir } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const workspaceRoot = path.resolve(packageRoot, "..", "..");
const outdir = path.join(packageRoot, "generated", "runtime");
const entrypoint = path.join(
	workspaceRoot,
	"packages",
	"runtime",
	"src",
	"index.ts",
);

const alias = {
	"@codelia/config": path.join(
		workspaceRoot,
		"packages",
		"config",
		"src",
		"index.ts",
	),
	"@codelia/config-loader": path.join(
		workspaceRoot,
		"packages",
		"config-loader",
		"src",
		"index.ts",
	),
	"@codelia/core": path.join(
		workspaceRoot,
		"packages",
		"core",
		"src",
		"index.ts",
	),
	"@codelia/logger": path.join(
		workspaceRoot,
		"packages",
		"logger",
		"src",
		"index.ts",
	),
	"@codelia/model-metadata": path.join(
		workspaceRoot,
		"packages",
		"model-metadata",
		"src",
		"index.ts",
	),
	"@codelia/protocol": path.join(
		workspaceRoot,
		"packages",
		"protocol",
		"src",
		"index.ts",
	),
	"@codelia/shared-types": path.join(
		workspaceRoot,
		"packages",
		"shared-types",
		"src",
		"index.ts",
	),
	"@codelia/storage": path.join(
		workspaceRoot,
		"packages",
		"storage",
		"src",
		"index.ts",
	),
};

await mkdir(outdir, { recursive: true });

const buildConfig: Parameters<typeof Bun.build>[0] & {
	alias: typeof alias;
} = {
	entrypoints: [entrypoint],
	outdir,
	target: "bun",
	format: "esm",
	minify: false,
	sourcemap: "inline",
	naming: {
		entry: "index.js",
	},
	alias,
};

const build = await Bun.build(buildConfig);

if (!build.success) {
	for (const log of build.logs) {
		console.error(log);
	}
	process.exit(1);
}
