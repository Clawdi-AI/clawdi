import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e/auth",
	testMatch: "*.pw.ts",
	workers: 1,
	timeout: 30000,
	expect: { timeout: 10000 },
	use: { baseURL: "http://127.0.0.1:3111", trace: "retain-on-failure" },
	webServer: {
		command:
			"bun x --no-install vite --config e2e/auth/vite.config.ts --host 127.0.0.1 --port 3111 --strictPort",
		url: "http://127.0.0.1:3111/e2e/auth/",
		env: {
			VITE_DEV_AUTH_BYPASS: "false",
			VITE_CLERK_PUBLISHABLE_KEY: "pk_test_contract_fixture",
			VITE_CLAWDI_API_URL: "http://127.0.0.1:8000",
		},
	},
});
