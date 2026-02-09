import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	dts: true,
	clean: true,
	platform: "node",
	banner: ({ format }) =>
		format === "cjs" ? { js: "#!/usr/bin/env node" } : undefined,
});
