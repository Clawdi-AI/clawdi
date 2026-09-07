import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	optimizeDeps: { entries: ["e2e/auth/index.html", "e2e/auth/hydration.browser.tsx"] },
	plugins: [
		react(),
		tailwindcss(),
		{
			name: "auth-hydration-fixture",
			configureServer(server) {
				server.middlewares.use(async (request, response, next) => {
					if (request.url?.split("?")[0] !== "/__auth-hydration") return next();
					try {
						const module = await server.ssrLoadModule("/e2e/auth/hydration.browser.tsx");
						const output: unknown = await module.renderHydrationProbe();
						if (
							!output ||
							typeof output !== "object" ||
							!("markup" in output) ||
							!("bootstrap" in output) ||
							typeof output.markup !== "string" ||
							typeof output.bootstrap !== "string"
						)
							throw new Error("Invalid SSR fixture output");
						response.setHeader("Content-Type", "text/html");
						const template = await server.transformIndexHtml(
							request.url,
							'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Auth hydration contract</title></head><body><!--ssr-outlet--><script type="module" src="/e2e/auth/hydration.browser.tsx"></script></body></html>',
						);
						response.end(
							template.replace(
								"<!--ssr-outlet-->",
								() => `<div id="app">${output.markup}</div>${output.bootstrap}`,
							),
						);
					} catch (error) {
						next(error);
					}
				});
			},
		},
	],
	resolve: {
		alias: [
			{ find: "@", replacement: fileURLToPath(new URL("../../src", import.meta.url)) },
			{
				find: /^@clerk\/tanstack-react-start$/,
				replacement: fileURLToPath(new URL("./clerk-fixture.ts", import.meta.url)),
			},
		],
	},
});
