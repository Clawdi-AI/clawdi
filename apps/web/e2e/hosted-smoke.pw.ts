import { expect, test } from "@playwright/test";
import { basicPlan, collectBrowserErrors, stubHostedApi } from "./hosted-stub-api";

// HOSTED (Clawdi Cloud) smoke against the vite dev server with dev-auth-bypass
// (no Clerk key needed) + deploy-api enabled so /deploy renders. Exercises the
// hosted deploy happy path asserting zero browser console/page errors.
//
// IMPORTANT: stub by API host, never with broad "**/v2/**" globs. The app's
// own modules live under /src/hosted/v2/... and a path glob would intercept
// them and break module loading.

test("hosted deploy happy path submits an included Basic agent", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const createRequests: string[] = [];
	await stubHostedApi(page, {
		createRequests,
		deployments: [],
		plans: [{ ...basicPlan, offers: [] }],
	});
	await page.goto("/deploy");
	await expect(page.getByRole("heading", { name: "Deploy an Agent" })).toBeVisible();

	// The Personalize section's language select is always present.
	const languageSelect = page.locator("#agent-language");
	await expect(languageSelect).toBeVisible();
	await languageSelect.click();
	await expect(page.getByRole("option").first()).toBeVisible();
	await page.getByRole("option").first().click();

	await page.getByRole("button", { name: /OpenClaw/i }).click();
	await expect(page.getByRole("button", { name: /OpenClaw/i })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByText("First slot free", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Deploy agent" }).click();
	await expect.poll(() => createRequests.length).toBe(1);
	expect(JSON.parse(createRequests[0] ?? "{}")).toMatchObject({
		compute_plan_slug: "compute_basic",
	});
	expect(errors, `hosted smoke: ${errors.join(" | ")}`).toEqual([]);
});
