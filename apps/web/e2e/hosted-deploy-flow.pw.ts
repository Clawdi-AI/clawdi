import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	deploymentStatusLabel,
	KNOWN_DEPLOYMENT_STATUSES,
	parseDeploymentStatus,
} from "../src/hosted/deployment-status";
import { collectBrowserErrors, DEPLOY_API, fulfillJson, stubCloudApi } from "./hosted-fixtures";

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
	await expect(page.getByText("First slot free", { exact: true })).toBeVisible();

	const createdResponse = page.waitForResponse(
		(response) =>
			response.url() === `${DEPLOY_API}/v2/deployments` && response.request().method() === "POST",
	);
	await page.getByRole("button", { name: /Deploy agent/i }).click();
	const created = await (await createdResponse).json();
	expect(created.status).toBe("creating");
	expect(created.config_info.enable_openclaw).toBe(true);
	expect(created.config_info.enable_hermes).toBe(false);

	await expect(page).toHaveURL(/\/agents\/hdep_dev_/);
	await expect(page.getByText("Provisioning").first()).toBeVisible();

	const running = await request.post(`${DEPLOY_API}/v2/deployments/${created.id}/start`);
	expect(running.ok()).toBeTruthy();

	await page.goto("/agents");
	await expect(page.getByText("Running").first()).toBeVisible();
	expect(errors, `deploy flow: ${errors.join(" | ")}`).toEqual([]);
});

test("deployment status surface renders every list-visible known status from the shared status source", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	await stubCloudApi(page);
	await page.route(`${DEPLOY_API}/v2/deployments`, (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		const createdAt = new Date().toISOString();
		return fulfillJson(
			route,
			KNOWN_DEPLOYMENT_STATUSES.map((status) => ({
				id: `hdep_status_${status}`,
				user_id: "usr_dev_preview",
				name: `status-${status}`,
				app_id: "app_dev_sidebar",
				backend: "mock",
				status,
				failure_reason: null,
				endpoints: [],
				config_info: {
					compute_plan_slug: "compute_performance",
					configured_agents: ["hermes"],
					onboarded_agents: ["hermes"],
					enable_openclaw: false,
					enable_hermes: true,
					clawdi_cloud_environments: {},
				},
				compute_subscription: null,
				created_at: createdAt,
				upgrade_available: false,
				agent_version: "v2-dev",
				app_image: "clawdi/hosted-runtime:dev",
			})),
		);
	});

	await page.goto("/agents");
	for (const raw of KNOWN_DEPLOYMENT_STATUSES.filter((status) => status !== "deleted")) {
		const label = deploymentStatusLabel(parseDeploymentStatus(raw));
		await expect(page.getByText(label).first()).toBeVisible();
	}
	await expect(page.getByText("Deleted")).toHaveCount(0);
	expect(errors, `status surface: ${errors.join(" | ")}`).toEqual([]);
});
