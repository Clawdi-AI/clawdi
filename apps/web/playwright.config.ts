import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3200";
const serverPort = new URL(baseURL).port || "3200";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.pw.ts",
	testIgnore: [
		// SDK lifecycle contracts use their own isolated Clerk fixture server.
		"**/auth/**",
		// Paired marketing/Cloud apps and SDK fixtures have a dedicated Docker runner.
		"**/handoff/**",
		// Hosted suites run under playwright.hosted.config.ts
		// (VITE_CLAWDI_HOSTED=true); in the OSS build those surfaces cannot
		// render.
		"**/hosted-*.pw.ts",
		"**/query-refresh-hosted.pw.ts",
	],
	timeout: process.env.CI ? 60_000 : 30_000,
	expect: {
		// The SSR-then-client-retry query path can delay first paint well past
		// 5s, and CI runners are slower than a dev machine. 10s covers local
		// full-suite load; CI gets 20s.
		timeout: process.env.CI ? 20_000 : 10_000,
	},
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	failOnFlakyTests: !!process.env.CI,
	reporter: process.env.CI
		? [["github"], ["html", { outputFolder: "playwright-report/oss", open: "never" }]]
		: "list",
	outputDir: "test-results/oss",
	use: {
		baseURL,
		// API mocks use plain-http loopback origins blocked by production CSP.
		bypassCSP: true,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
	},
	webServer: {
		// OSS runs the production bundle to avoid the Nitro dev proxy and cold transforms.
		command: `bun run build --mode e2e && bun run start`,
		url: baseURL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
		env: {
			...process.env,
			HOST: "127.0.0.1",
			PORT: serverPort,
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
