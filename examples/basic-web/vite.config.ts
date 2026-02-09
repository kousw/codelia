import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
	const proxyTarget =
		env.VITE_API_PROXY_TARGET?.trim() || "http://localhost:3001";

	return {
		plugins: [react()],
		root: "src/client",
		build: {
			outDir: "../../dist/client",
			emptyOutDir: true,
		},
		server: {
			port: 3000,
			proxy: {
				"/api/": {
					target: proxyTarget,
					changeOrigin: true,
				},
			},
		},
	};
});
