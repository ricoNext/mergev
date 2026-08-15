import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const mergeUiSource = fileURLToPath(
	new URL("../../packages/merge-ui/src", import.meta.url),
);

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@mergev/merge-ui": mergeUiSource,
		},
	},
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			ignored: ["**/src-tauri/**"],
		},
	},
	build: {
		rollupOptions: {
			output: {
				manualChunks: {
					"react-vendor": ["react", "react-dom"],
					"tauri-vendor": [
						"@tauri-apps/api",
						"@tauri-apps/plugin-dialog",
						"@tauri-apps/plugin-opener",
					],
					shiki: ["shiki"],
				},
			},
		},
		chunkSizeWarningLimit: 1000,
	},
});
