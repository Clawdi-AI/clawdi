import { defineConfig } from "@playwright/test";
import hosted from "./playwright.hosted.config";

export default defineConfig({
	...hosted,
	testMatch: ["hosted-openclaw-native.pw.ts", "hosted-openclaw-recovery.pw.ts"],
	// Hosted APIs are stubbed in-page; only the real Vite product server is needed.
	webServer: Array.isArray(hosted.webServer)
		? hosted.webServer.slice(0, 1).map((server) => ({ ...server, ignoreHTTPSErrors: true }))
		: hosted.webServer,
	use: {
		...hosted.use,
		ignoreHTTPSErrors: true,
		// The isolated ingress uses a self-signed loopback certificate.
		launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
	},
});
