import type { DeviceLookupResponse } from "@clawdi/shared/api";
import { expect, type Route, test } from "@playwright/test";

async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({
		status,
		contentType: "application/json",
		body: JSON.stringify(body),
	});
}

test("retired browser approval tells the user to update the CLI", async ({ page }) => {
	const lookup: DeviceLookupResponse = {
		user_code: "ABCD-1234",
		client_label: "clawdi cli · build-host",
		status: "pending",
		expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
	};
	await page.route("**/v1/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/v1/cli/auth/lookup") {
			await fulfillJson(route, lookup);
			return;
		}
		if (url.pathname === "/v1/cli/auth/approve") {
			await fulfillJson(
				route,
				{
					detail:
						"This sign-in method is no longer supported. Update the Clawdi CLI and run `clawdi auth login`.",
				},
				410,
			);
			return;
		}
		await fulfillJson(route, {});
	});

	await page.goto("/cli-authorize?code=abcd-1234");
	const authorize = page.getByRole("button", { name: "Authorize" });
	await expect(authorize).toBeVisible({ timeout: 15_000 });
	await authorize.click();

	const status = page.getByRole("status").filter({ hasText: "Update the Clawdi CLI" });
	await expect(status).toBeVisible();
	await expect(
		status.getByText(
			"This CLI version is no longer supported. Update Clawdi CLI and run `clawdi auth login`.",
			{ exact: true },
		),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Authorize" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Deny" })).toHaveCount(0);
});
