import { expect, test } from "@playwright/test";
import type {} from "./hydration.browser";

for (const signedOut of [false, true]) {
	test(`SSR frame hydrates without session resources, then ${signedOut ? "signs out" : "activates"}`, async ({
		page,
	}) => {
		const requests: string[] = [];
		await page.route("http://127.0.0.1:8000/**", (route) => {
			requests.push(route.request().headers().authorization ?? "missing");
			return route.fulfill({ contentType: "application/json", body: "{}" });
		});
		const entry = Promise.withResolvers<void>();
		await page.route("**/e2e/auth/hydration.browser.tsx", async (route) => {
			await entry.promise;
			await route.continue();
		});
		try {
			await page.goto("/__auth-hydration?sdk=loading", { waitUntil: "commit" });
			await expect(page.getByRole("heading")).toHaveText("Server-admitted document");
			const header = await page.locator("header").elementHandle();
			if (!header) throw new Error("Missing SSR header");
			await expect(page.locator("iframe")).toHaveCount(0);
			entry.resolve();
			await expect.poll(() => page.evaluate(() => window.hydrationTest?.hydrated)).toBe(true);
			expect(await page.evaluate(() => window.hydrationTest.errors)).toEqual([]);
			expect(await header.evaluate((node) => node === document.querySelector("header"))).toBe(true);
			expect(requests).toEqual([]);
			await page.evaluate(
				(signedOut) =>
					window.hydrationTest.emitSdk({
						status: "ready",
						...(signedOut ? { userId: null, sessionId: null } : {}),
					}),
				signedOut,
			);
			if (signedOut) {
				await expect(page.getByRole("heading")).toHaveText("Sign in");
				await expect(page.locator("iframe")).toHaveCount(0);
				expect(requests).toEqual([]);
			} else {
				await expect(page.locator("iframe")).toBeVisible();
				expect(await header.evaluate((node) => node === document.querySelector("header"))).toBe(
					true,
				);
				await expect.poll(() => requests.length).toBeGreaterThan(0);
				expect(requests.every((token) => token === "Bearer user-a:session-a")).toBe(true);
			}
		} finally {
			entry.resolve();
		}
	});
}
