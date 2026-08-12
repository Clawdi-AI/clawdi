import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
	// Vite does not load .env files into process.env while evaluating this file.
	// Loading without a prefix follows Sentry's documented Vite plugin setup.
	const env = loadEnv(mode, process.cwd(), "");

	// Vercel system variables are server-only by default. Mirror only the public
	// deployment metadata Sentry needs before Vite resolves import.meta.env.
	if (env.VERCEL_ENV) {
		process.env.VITE_SENTRY_ENVIRONMENT = env.VERCEL_ENV;
	}
	if (env.VERCEL_GIT_COMMIT_SHA) {
		process.env.VITE_SENTRY_RELEASE = env.VERCEL_GIT_COMMIT_SHA;
	}

	const sentryPlugins =
		env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT
			? sentryTanstackStart({
					authToken: env.SENTRY_AUTH_TOKEN,
					org: env.SENTRY_ORG,
					project: env.SENTRY_PROJECT,
					release: env.VERCEL_GIT_COMMIT_SHA ? { name: env.VERCEL_GIT_COMMIT_SHA } : undefined,
				})
			: [];

	return {
		server: {
			port: 3000,
		},
		ssr: {
			// Published leaf components use extensionless internal ESM imports,
			// so Vite must transform this package before Node evaluates SSR.
			noExternal: ["@lobehub/icons"],
		},
		resolve: {
			tsconfigPaths: true,
		},
		plugins: [
			tanstackStart({
				importProtection: {
					client: { specifiers: ["@clerk/tanstack-react-start/server"] },
				},
			}),
			nitro(),
			tailwindcss(),
			viteReact(),
			...sentryPlugins,
		],
	};
});
