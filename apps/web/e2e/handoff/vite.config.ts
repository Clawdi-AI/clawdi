import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "../../vite.config";
export default defineConfig((env) =>
	mergeConfig(appConfig(env), {
		server: { allowedHosts: ["cloud"] },
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
