import { defineConfig, devices } from "@playwright/test";

// HOSTED (Clawdi Cloud) smoke against the vite dev server with dev-auth-bypass
// (no Clerk key needed) + deploy-api enabled so /deploy renders.
const baseURL = process.env.E2E_HOSTED_BASE_URL ?? "http://127.0.0.1:3100";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/hosted-smoke.pw.ts",
	timeout: 60_000,
	expect: { timeout: 12_000 },
	fullyParallel: false,
	reporter: "list",
	use: { baseURL, trace: "on-first-retry" },
	webServer: {
		command: "bun run dev -- --host 127.0.0.1 --port 3100",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
		env: {
			...process.env,
			VITE_CLAWDI_API_URL: "http://127.0.0.1:8000",
			VITE_CLAWDI_HOSTED: "true",
			VITE_CLAWDI_DEPLOY_API_URL: "http://127.0.0.1:8001",
			VITE_DEV_AUTH_BYPASS: "true",
			VITE_DEV_AUTH_TOKEN: "dev-bypass",
		},
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
