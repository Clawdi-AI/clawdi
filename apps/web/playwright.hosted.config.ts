import { defineConfig, devices } from "@playwright/test";

// HOSTED (Clawdi Cloud) smoke against the vite dev server with dev-auth-bypass
// (no Clerk key needed) + deploy-api enabled so /deploy renders.
const hostedPort = Number(process.env.E2E_HOSTED_PORT ?? 3100);
if (!Number.isInteger(hostedPort) || hostedPort < 1 || hostedPort > 65_535) {
	throw new Error("E2E_HOSTED_PORT must be a valid TCP port.");
}
const baseURL = process.env.E2E_HOSTED_BASE_URL ?? `http://127.0.0.1:${hostedPort}`;
// Must match the stub host in e2e/hosted-stub-api.ts / hosted-fixtures.ts.
const deployApiPort = Number(process.env.E2E_HOSTED_DEPLOY_API_PORT ?? 8001);
if (!Number.isInteger(deployApiPort) || deployApiPort < 1 || deployApiPort > 65_535) {
	throw new Error("E2E_HOSTED_DEPLOY_API_PORT must be a valid TCP port.");
}
const deployApiURL = process.env.E2E_HOSTED_DEPLOY_API_URL ?? `http://127.0.0.1:${deployApiPort}`;
const stripePublishableKey = process.env.E2E_STRIPE_PUBLISHABLE_KEY ?? "pk_test_browser";

export default defineConfig({
	testDir: "./e2e",
	testMatch: ["**/hosted-*.pw.ts", "**/query-refresh-hosted.pw.ts"],
	timeout: 60_000,
	expect: { timeout: 12_000 },
	fullyParallel: false,
	workers: 1,
	reporter: "list",
	use: { baseURL, trace: "on-first-retry" },
	webServer: [
		{
			command: `bun run dev -- --host 127.0.0.1 --port ${hostedPort}`,
			url: baseURL,
			reuseExistingServer: Boolean(process.env.E2E_HOSTED_BASE_URL),
			timeout: 120_000,
			env: {
				...process.env,
				VITE_CLAWDI_API_URL: "http://127.0.0.1:8000",
				VITE_CLAWDI_HOSTED: "true",
				VITE_CLAWDI_DEPLOY_API_URL: deployApiURL,
				VITE_CLAWDI_LEGACY_DASHBOARD_URL: "https://legacy.example/dashboard",
				VITE_DEV_AUTH_BYPASS: "true",
				VITE_DEV_AUTH_TOKEN: "dev-bypass",
				VITE_STRIPE_PUBLISHABLE_KEY: stripePublishableKey,
			},
		},
		{
			// Deploy API mock for the deploy-wizard spec (in-page stubs cover
			// everything else). PYTHONPATH puts the backend root on sys.path so
			// the mock can import `app.*` helpers.
			command: `uv run python scripts/mock_deploy_api.py --host 127.0.0.1 --port ${deployApiPort}`,
			cwd: "../../backend",
			url: `${deployApiURL}/health`,
			reuseExistingServer: Boolean(process.env.E2E_HOSTED_DEPLOY_API_URL),
			timeout: 60_000,
			env: { PYTHONPATH: "." },
		},
	],
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
