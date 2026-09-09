import { expect, test } from "@playwright/test";
import { stubHostedApi } from "./hosted-stub-api";

test("channel recommendation is claimed on SPA entry and remains optional", async ({ page }) => {
	await stubHostedApi(page);
	let channel: string | null = null;
	let claims = 0;
	await page.route("http://127.0.0.1:8000/v1/settings", async (route) => {
		if (route.request().method() === "PATCH") {
			channel = route.request().postDataJSON().settings.deploy_channel;
			claims += 1;
			await route.fulfill({ json: { status: "updated" } });
		} else await route.fulfill({ json: channel ? { deploy_channel: channel } : {} });
	});
	await page.goto("/deploy?deploy_profile=unknown");
	await expect(page.getByRole("heading", { name: "Deploy an Agent" })).toBeVisible();
	await expect(page.getByRole("checkbox", { name: /Sui bundle/ })).toHaveCount(0);
	expect(claims).toBe(0);
	await page.evaluate(() => {
		window.history.pushState({}, "", "/deploy?deploy_profile=sui");
		window.dispatchEvent(new PopStateEvent("popstate"));
	});
	const bundle = page.getByRole("checkbox", { name: /Sui bundle/ });
	await expect(bundle).toBeChecked();
	await expect.poll(() => claims).toBe(1);
	await bundle.uncheck();
	await expect(bundle).not.toBeChecked();
	await expect(
		page.getByText("Includes Sui ecosystem Store plugins and their skills and MCP servers."),
	).toBeVisible();
	await page.evaluate(() => window.localStorage.clear());
	// Server-side channel persistence is sufficient on a later visit.
	await page.goto("/deploy");
	await expect(bundle).toBeChecked();
	expect(claims).toBe(1);
});
