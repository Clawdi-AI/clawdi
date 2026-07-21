import { defineConfig, devices } from "@playwright/test";

// HOSTED (Clawdi Cloud) smoke against the vite dev server with dev-auth-bypass
// (no Clerk key needed) + deploy-api enabled so /deploy renders.
const hostedPort = Number(process.env.E2E_HOSTED_PORT ?? 3100);
if (!Number.isInteger(hostedPort) || hostedPort < 1 || hostedPort > 65_535) {
	throw new Error("E2E_HOSTED_PORT must be a valid TCP port.");
}
const baseURL = process.env.E2E_HOSTED_BASE_URL ?? `http://127.0.0.1:${hostedPort}`;
const deployApiURL = process.env.E2E_HOSTED_DEPLOY_API_URL ?? "http://127.0.0.1:50001";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/hosted-*.pw.ts",
	timeout: 60_000,
	expect: { timeout: 12_000 },
	fullyParallel: false,
	workers: 1,
	reporter: "list",
	use: { baseURL, trace: "on-first-retry" },
	webServer: {
		command: `bun run dev -- --host 127.0.0.1 --port ${hostedPort}`,
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
		env: {
			...process.env,
			VITE_CLAWDI_API_URL: "http://127.0.0.1:8000",
			VITE_CLAWDI_HOSTED: "true",
			VITE_CLAWDI_DEPLOY_API_URL: deployApiURL,
			VITE_DEV_AUTH_BYPASS: "true",
			VITE_DEV_AUTH_TOKEN: "dev-bypass",
			VITE_STRIPE_PUBLISHABLE_KEY: "pk_test_browser",
		},
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
