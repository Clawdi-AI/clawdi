import { expect, test } from "@playwright/test";

test("explains Project access once and opens the Project after accepting", async ({ page }) => {
	let accepted = false;
	await page.route("**/v1/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/v1/share/invitation-preview/preview") {
			return route.fulfill({
				json: {
					project_id: "team-knowledge",
					project_name: "Team Knowledge",
					owner_display: "Alex",
					owner_handle: "alex",
					skill_count: 3,
					vault_count: 1,
					vault_locked: true,
				},
			});
		}
		if (path === "/v1/share/invitation-preview/upgrade") {
			accepted = true;
			return route.fulfill({ json: { project_id: "team-knowledge" } });
		}
		return route.fulfill({ json: {} });
	});
	await page.goto("/share/invitation-preview");
	await expect(page.getByText("Team Knowledge", { exact: true })).toBeVisible();
	await expect(
		page.getByText(/You can view this Project and link it to your Agents/),
	).toBeVisible();
	for (const width of [1280, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await expect(page.getByRole("button", { name: "Accept invitation" })).toBeVisible();
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
	}
	await page.getByRole("button", { name: "Accept invitation" }).click();
	await expect(page).toHaveURL(/\/projects\/team-knowledge\?joined=share/);
	expect(accepted).toBe(true);
});
