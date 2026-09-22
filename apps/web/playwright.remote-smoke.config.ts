import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.SMOKE_BASE_URL;
if (!baseURL) throw new Error("SMOKE_BASE_URL is required");
const parsedBaseUrl = new URL(baseURL);
if (parsedBaseUrl.protocol !== "https:" && parsedBaseUrl.protocol !== "http:") {
	throw new Error("SMOKE_BASE_URL must use HTTP or HTTPS");
}

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/pages-smoke.pw.ts",
	timeout: 30_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	workers: 1,
	reporter: process.env.CI ? "github" : "list",
	use: {
		...devices["Desktop Chrome"],
		baseURL: parsedBaseUrl.toString(),
		trace: "on-first-retry",
	},
	projects: [{ name: "chromium" }],
});
