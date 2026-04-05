import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "codelia-desktop",
		identifier: "dev.codelia.desktop",
		version: "0.0.1",
		description: "Electrobun desktop MVP for Codelia",
	},
	build: {
		copy: {
			"generated/mainview": "views/mainview",
			"generated/runtime/index.js": "runtime/index.js",
			"../../packages/core/prompts/system.md": "prompts/system.md",
		},
		watch: [
			"generated/mainview",
			"../../packages/runtime/src",
			"../../packages/core/src",
			"../../packages/core/prompts",
			"../../packages/config/src",
			"../../packages/config-loader/src",
			"../../packages/logger/src",
			"../../packages/model-metadata/src",
			"../../packages/protocol/src",
			"../../packages/shared-types/src",
			"../../packages/storage/src",
		],
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
	scripts: {
		preBuild: "scripts/prebuild.ts",
	},
} satisfies ElectrobunConfig;
