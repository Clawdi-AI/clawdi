import { defineConfig } from "@playwright/test";
import hosted from "./playwright.hosted.config";

export default defineConfig({
	...hosted,
	testMatch: ["hosted-openclaw-native.pw.ts", "openclaw-handoff-latency.pw.ts"],
	workers: 1,
	// Handoff fragments are credentials; do not persist browser traces or screenshots.
	// Hosted APIs are stubbed in-page; only the real Vite product server is needed.
	webServer: Array.isArray(hosted.webServer) ? hosted.webServer.slice(0, 1) : hosted.webServer,
	use: {
		...hosted.use,
		ignoreHTTPSErrors: true,
		trace: "off",
		screenshot: "off",
		video: "off",
		// The isolated ingress uses a self-signed loopback certificate.
		launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
	},
});
