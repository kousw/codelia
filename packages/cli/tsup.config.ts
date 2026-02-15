import fs from "node:fs";
import { defineConfig } from "tsup";

const cliPackageJson = JSON.parse(
	fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string };
const cliVersion = cliPackageJson.version ?? "0.0.0";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	dts: true,
	clean: true,
	platform: "node",
	define: {
		__CODELIA_CLI_VERSION__: JSON.stringify(cliVersion),
	},
	banner: ({ format }) =>
		format === "cjs" ? { js: "#!/usr/bin/env node" } : undefined,
});
