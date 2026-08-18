import { type APIRequestContext, expect, test } from "@playwright/test";
import { collectBrowserErrors, DEPLOY_API, stubCloudApi } from "./hosted-fixtures";

async function clearFreeDeployments(request: APIRequestContext) {
	const response = await request.get(`${DEPLOY_API}/v2/deployments`);
	expect(response.ok()).toBeTruthy();
	const deployments = (await response.json()) as Array<{
		id: string;
		config_info?: { compute_plan_slug?: string | null } | null;
	}>;
	await Promise.all(
		deployments
			.filter((deployment) => deployment.config_info?.compute_plan_slug === "compute_basic")
			.map((deployment) => request.delete(`${DEPLOY_API}/v2/deployments/${deployment.id}`)),
	);
}
test("deploy wizard creates one selected runtime and renders mock status transitions", async ({
	page,
	request,
}) => {
	await clearFreeDeployments(request);
	const errors = collectBrowserErrors(page);
	await stubCloudApi(page);
	// The wizard blocks submission until the managed model catalog loads; the
	// mock deploy API has no such endpoint, so stub a minimal catalog here.
	await page.route(`${DEPLOY_API}/v2/ai-providers/managed/models`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				models: [
					{
						id: "gpt-5.6-luna",
						display_name: "GPT-5.6 Luna",
						provider_id: "openai-codex",
						is_default: true,
						is_featured: true,
						description: "Low cost for routine work.",
						capabilities: { vision: false, reasoning: false },
					},
				],
			}),
		});
	});
	await page.route(`${DEPLOY_API}/v2/subscriptions/reusable?*`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ items: [], has_more: false, next_cursor: null }),
		});
	});

	await page.goto("/deploy");
	await expect(page.getByRole("heading", { name: "Deploy an Agent" })).toBeVisible();

	const deployWizard = page.locator("main");
	await deployWizard.getByRole("button", { name: /OpenClaw/i }).click();
	await expect(deployWizard.getByRole("button", { name: /OpenClaw/i })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(deployWizard.getByRole("button", { name: /Hermes/i })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	const includedBasic = page.getByRole("button", { name: /Basic compute/ });
	await expect(includedBasic).toBeVisible();
	await includedBasic.click();
	await expect(includedBasic).toHaveAttribute("aria-pressed", "true");

	const createdResponse = page.waitForResponse(
		(response) =>
			response.url() === `${DEPLOY_API}/v2/deployments` && response.request().method() === "POST",
	);
	await page.getByTestId("deploy-action-bar").getByRole("button", { name: "Deploy" }).click();
	const createBody = (await createdResponse).request().postDataJSON() as { runtime?: string };
	expect(createBody.runtime).toBe("openclaw");

	await expect(page).toHaveURL(
		/\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	);
	await expect(page.getByText("Starting").first()).toBeVisible();

	await page.goto("/deploy");
	await expect(page.getByRole("heading", { name: "Deploy an Agent" })).toBeVisible();
	await expect(page.getByRole("button", { name: /Basic compute/ })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /New paid subscription/ })).toHaveCount(0);
	await expect(page.getByText("Payment method", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: /Card subscription/ })).toBeVisible();
	expect(errors, `deploy flow: ${errors.join(" | ")}`).toEqual([]);
});
