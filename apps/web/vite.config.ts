import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv, type Plugin } from "vite";

const require = createRequire(import.meta.url);
const DESKTOP_CLERK_ASSET = "assets/clerk.browser.js";
const clerkBrowserBundle = require.resolve("@clerk/clerk-js/dist/clerk.browser.js");

function desktopClerkAssetPlugin(): Plugin {
	return {
		name: "clawdi-desktop-clerk-asset",
		apply: "build",
		buildStart() {
			this.emitFile({
				type: "asset",
				fileName: DESKTOP_CLERK_ASSET,
				source: readFileSync(clerkBrowserBundle),
			});
		},
	};
}

export default defineConfig(({ mode }) => {
	// Vite does not load .env files into process.env while evaluating this file.
	// Loading without a prefix follows Sentry's documented Vite plugin setup.
	const env = loadEnv(mode, process.cwd(), "");
	const desktopBuild = env.VITE_CLAWDI_DESKTOP_BUILD === "true";

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
		...(desktopBuild ? {} : { server: { port: 3000 } }),
		ssr: {
			// Published leaf components use extensionless internal ESM imports,
			// so Vite must transform this package before Node evaluates SSR.
			noExternal: ["@lobehub/icons"],
		},
		resolve: {
			tsconfigPaths: true,
		},
		plugins: [
			tailwindcss(),
			...(desktopBuild ? [desktopClerkAssetPlugin()] : []),
			tanstackStart({
				...(desktopBuild
					? {
							spa: {
								enabled: true,
								prerender: { outputPath: "index.html" },
							},
						}
					: {}),
				importProtection: {
					client: { specifiers: ["@clerk/tanstack-react-start/server"] },
				},
			}),
			viteReact(),
			...(desktopBuild ? [] : [nitro()]),
			...sentryPlugins,
		],
	};
});
