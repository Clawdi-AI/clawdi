import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const entry = process.env.OPENCLAW_TEST_ENTRY;
const endpoint = "https://127.0.0.1:19443/";

test("measure official CLI handoff and fresh native browser hello", async ({ browser }) => {
	test.skip(!entry, "Requires the isolated official OpenClaw gateway fixture");
	test.setTimeout(240_000);
	if (!entry) throw new Error("Missing official gateway entry");
	const command = async (option: "--help" | "--json") => {
		const start = performance.now();
		try {
			const { stdout } = await promisify(execFile)("node", [entry, "dashboard", option], {
				timeout: 10_000,
				maxBuffer: 32 * 1024,
			});
			return { stdout, ms: performance.now() - start };
		} catch {
			// execFile errors can contain a newly issued handoff. Never log them.
			throw new Error(`Official dashboard ${option} failed`);
		}
	};
	// Warm both command paths once; each timed invocation remains a fresh CLI process.
	await command("--help");
	await command("--json");
	for (let sample = 1; sample <= 3; sample += 1) {
		const strategies = sample % 2 ? ["help-json", "json"] : ["json", "help-json"];
		for (const strategy of strategies) {
			const context = await browser.newContext({ ignoreHTTPSErrors: true });
			try {
				const page = await context.newPage();
				let helloCount = 0;
				let helloAt = 0;
				let owner = false;
				page.on("websocket", (socket) => {
					socket.on("framereceived", ({ payload }) => {
						const frame = JSON.parse(String(payload));
						if (frame.payload?.type === "hello-ok") {
							helloCount += 1;
							helloAt = performance.now();
							owner = frame.payload.auth.scopes.includes("operator.admin");
						}
					});
				});
				const start = performance.now();
				const help = strategy === "help-json" ? await command("--help") : null;
				const json = await command("--json");
				let native: { ok?: boolean; browserUrl?: string; browserBootstrapExpiresAtMs?: number };
				try {
					native = JSON.parse(json.stdout);
				} catch {
					throw new Error("Official dashboard returned invalid JSON");
				}
				if (!native.ok || !native.browserUrl || !native.browserBootstrapExpiresAtMs)
					throw new Error("Official dashboard did not issue a bootstrap handoff");
				const fragment = new URLSearchParams(new URL(native.browserUrl).hash.slice(1));
				expect(fragment.has("bootstrapToken")).toBe(true);
				expect(fragment.get("bootstrapProfile")).toBe("owner");
				const lifetime = native.browserBootstrapExpiresAtMs - Date.now();
				expect(lifetime).toBeGreaterThan(0);
				expect(lifetime).toBeLessThanOrEqual(600_000);
				fragment.set("gatewayUrl", endpoint.replace("https:", "wss:").replace(/\/$/, ""));
				const handoffAt = performance.now();
				try {
					await page.goto(`${endpoint}#${fragment}`);
				} catch {
					throw new Error("Official browser navigation failed");
				}
				await expect.poll(() => helloCount, { timeout: 30_000 }).toBe(1);
				expect(owner).toBe(true);
				console.log(
					JSON.stringify({
						sample,
						strategy,
						mode: "native_bootstrap",
						helloCount,
						helpMs: help ? Math.round(help.ms) : 0,
						jsonMs: Math.round(json.ms),
						handoffMs: Math.round(handoffAt - start),
						browserHelloMs: Math.round(helloAt - handoffAt),
						totalMs: Math.round(helloAt - start),
					}),
				);
			} finally {
				await context.close();
			}
		}
	}
});
