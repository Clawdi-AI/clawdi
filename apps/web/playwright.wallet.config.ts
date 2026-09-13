import { defineConfig } from "@playwright/test";
import hosted from "./playwright.hosted.config";

// Wallet API and Stripe boundaries are intercepted in the browser; no backend
// process, credentials, or external payment provider is needed for this suite.
export default defineConfig({
	...hosted,
	testMatch: "**/hosted-wallet-checkout.pw.ts",
	webServer: Array.isArray(hosted.webServer) ? hosted.webServer[0] : hosted.webServer,
});
