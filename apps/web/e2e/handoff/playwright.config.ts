import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: "*.pw.ts",
	workers: 1,
	timeout: 120_000,
	expect: { timeout: 30_000 },
	use: { baseURL: "http://localhost:3200", trace: "retain-on-failure" },
});
