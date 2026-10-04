import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "../../vite.config";
export default defineConfig((env) =>
	mergeConfig(appConfig(env), {
		server: { allowedHosts: ["cloud"] },
		// Sharing routes load this dependency lazily. Prebundle it before the
		// browser starts so first navigation cannot use an outdated optimizer URL.
		optimizeDeps: { include: ["react-virtuoso"] },
		resolve: {
			alias: [
				{
					find: /^@clerk\/tanstack-react-start$/,
					replacement: fileURLToPath(new URL("./clerk.tsx", import.meta.url)),
				},
				{
					find: /^@clerk\/tanstack-react-start\/server$/,
					replacement: fileURLToPath(new URL("./clerk-server.ts", import.meta.url)),
				},
			],
		},
	}),
);
