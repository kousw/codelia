import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	root: "src/mainview",
	base: "./",
	build: {
		outDir: "../../generated/mainview",
		emptyOutDir: true,
		sourcemap: true,
		rollupOptions: {
			input: resolve(import.meta.dirname, "src/mainview/index.html"),
			output: {
				entryFileNames: "index.js",
				assetFileNames: (assetInfo) =>
					assetInfo.names.includes("index.css")
						? "index.css"
						: "assets/[name]-[hash][extname]",
				chunkFileNames: "chunks/[name]-[hash].js",
			},
		},
	},
});
