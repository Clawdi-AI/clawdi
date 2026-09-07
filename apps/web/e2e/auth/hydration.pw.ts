import { expect, test } from "@playwright/test";
import type { SdkState } from "./clerk-fixture";
import type {} from "./hydration.browser";

const scenarios: { sdk: "ready" | "loading"; update?: Partial<SdkState> }[] = [
	{ sdk: "ready" },
	{ sdk: "loading" },
	{ sdk: "loading", update: { userId: null, sessionId: null } },
	{ sdk: "loading", update: { pending: true } },
	{ sdk: "loading", update: { userId: "user-b", sessionId: "session-b" } },
	{ sdk: "loading", update: { sessionId: "session-b" } },
];

for (const { sdk, update } of scenarios) {
	test(`SSR hydration retains SDK ${sdk} until ${JSON.stringify(update) ?? "ready"}`, async ({
		page,
	}, info) => {
		const entry = Promise.withResolvers<void>();
		await page.route("**/e2e/auth/hydration.browser.tsx", async (route) => {
			await entry.promise;
			await route.continue();
		});
		try {
			await page.goto(`/__auth-hydration?sdk=${sdk}`, { waitUntil: "commit" });
			await expect(page.getByRole("heading")).toHaveText("Server-admitted document");
			await page.frameLocator("iframe").getByRole("textbox").fill("before hydration");
			const frame = await page.locator("iframe").elementHandle();
			if (!frame) throw new Error("Missing SSR iframe");
			entry.resolve();
			await expect
				.poll(() => page.evaluate(() => window.hydrationTest?.observations.length ?? 0))
				.toBeGreaterThan(0);
			await expect.poll(() => page.evaluate(() => window.hydrationTest.mounts)).toBe(1);
			// Wait for the post-hydration client snapshot, not just getServerSnapshot.
			await expect.poll(() => page.evaluate(() => window.hydrationTest.hydrated)).toBe(true);
			await expect(page.frameLocator("iframe").getByRole("textbox")).toHaveValue(
				"before hydration",
			);
			expect(await frame.evaluate((node) => node === document.querySelector("iframe"))).toBe(true);
			const retained = await page.evaluate(() => ({ ...window.hydrationTest, emitSdk: undefined }));
			expect(retained.errors).toEqual([]);
			expect(retained.unmounts).toBe(0);
			expect(
				retained.observations.every(
					(row) => row.sameClient && row.cached && row.status === "signed-in",
				),
			).toBe(true);
			await page.evaluate(
				(update) => window.hydrationTest.emitSdk({ status: "ready", ...update }),
				update,
			);
			if (update) {
				await expect.poll(() => page.evaluate(() => window.hydrationTest.unmounts)).toBe(1);
				expect(await frame.evaluate((node) => node.isConnected)).toBe(false);
				await expect
					.poll(() => page.evaluate(() => window.hydrationTest.originalCached))
					.toBe(false);
				if (update.pending || update.userId === null) {
					await expect(page.locator("iframe")).toHaveCount(0);
					await expect(page.getByRole("heading")).toHaveText("Sign in");
				} else {
					await expect(page.frameLocator("iframe").getByRole("textbox")).toHaveValue("");
					expect(
						await page.evaluate(() =>
							window.hydrationTest.observations.some((row) => !row.sameClient && !row.cached),
						),
					).toBe(true);
				}
			} else {
				await expect(page.frameLocator("iframe").getByRole("textbox")).toHaveValue(
					"before hydration",
				);
				expect(await frame.evaluate((node) => node === document.querySelector("iframe"))).toBe(
					true,
				);
				expect(await page.evaluate(() => window.hydrationTest.unmounts)).toBe(0);
			}
			const result = await page.evaluate(() => ({ ...window.hydrationTest, emitSdk: undefined }));
			expect(result.errors).toEqual([]);
			await info.attach("hydration-observations", {
				body: JSON.stringify(result, null, 2),
				contentType: "application/json",
			});
		} finally {
			entry.resolve();
			await info.attach("hydration-diagnostics", {
				body: JSON.stringify(
					await page.evaluate(() =>
						window.hydrationTest ? { ...window.hydrationTest, emitSdk: undefined } : null,
					),
					null,
					2,
				),
				contentType: "application/json",
			});
		}
	});
}
