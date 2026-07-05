import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.pw.ts",
	timeout: 30_000,
	expect: {
		timeout: 5_000,
	},
	fullyParallel: false,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL,
		trace: "on-first-retry",
	},
	webServer: {
		command: "bun run dev -- --host 127.0.0.1",
		url: baseURL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
		env: {
			...process.env,
			VITE_CLAWDI_API_URL: "http://127.0.0.1:8000",
			VITE_CLAWDI_HOSTED: "false",
			VITE_DEV_AUTH_BYPASS: "true",
			VITE_DEV_AUTH_TOKEN: "dev-bypass",
		},
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
