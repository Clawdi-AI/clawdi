import { expect, test } from "@playwright/test";
import type {} from "./hydration.browser";

for (const sdk of ["ready", "loading"] as const) {
	test(`SSR hydration with live SDK ${sdk}`, async ({ page }, info) => {
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
			if (sdk === "loading") {
				await expect(page.locator("iframe")).toHaveCount(0);
				await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
				await page.evaluate(() => window.hydrationTest.emitSdk({ status: "ready" }));
				await expect(page.locator("iframe")).toBeVisible();
				await expect.poll(() => page.evaluate(() => window.hydrationTest.mounts)).toBe(2);
				await expect(page.frameLocator("iframe").getByRole("textbox")).toHaveValue("");
				expect(await frame.evaluate((node) => node.isConnected)).toBe(false);
			} else {
				await expect.poll(() => page.evaluate(() => window.hydrationTest.mounts)).toBe(1);
				await expect(page.frameLocator("iframe").getByRole("textbox")).toHaveValue(
					"before hydration",
				);
				expect(await frame.evaluate((node) => node === document.querySelector("iframe"))).toBe(
					true,
				);
			}
			const result = await page.evaluate(() => ({ ...window.hydrationTest, emitSdk: undefined }));
			expect(result.errors).toEqual([]);
			expect(result.unmounts).toBe(sdk === "ready" ? 0 : 1);
			if (sdk === "ready")
				expect(
					result.observations.every(
						(row) => row.sameClient && row.cached && row.status === "signed-in",
					),
				).toBe(true);
			else expect(result.observations.some((row) => !row.sameClient && !row.cached)).toBe(true);
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
