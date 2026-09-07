import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
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
