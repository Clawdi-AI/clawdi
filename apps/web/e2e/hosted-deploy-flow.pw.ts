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

	await page.goto("/deploy");
	await expect(page.getByRole("heading", { name: "Deploy an Agent" })).toBeVisible();

	await page.getByRole("button", { name: /OpenClaw/i }).click();
	await expect(page.getByRole("button", { name: /OpenClaw/i })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByRole("button", { name: /Hermes/i })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(page.getByText("Free", { exact: true }).first()).toBeVisible();

	const createdResponse = page.waitForResponse(
		(response) =>
			response.url() === `${DEPLOY_API}/v2/deployments` && response.request().method() === "POST",
	);
	await page.getByTestId("deploy-action-bar").getByRole("button", { name: "Deploy" }).click();
	const createBody = (await createdResponse).request().postDataJSON() as { runtime?: string };
	expect(createBody.runtime).toBe("openclaw");

	await expect(page).toHaveURL(/\/agents\/hdep_dev_/);
	await expect(page.getByText("Starting").first()).toBeVisible();
	expect(errors, `deploy flow: ${errors.join(" | ")}`).toEqual([]);
});
