import { expect, test } from "@playwright/test";
import { includedBasicDeployment, stubHostedApi } from "./hosted-stub-api";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "hdep_agent_plugins_closed";

const deployment = {
	...includedBasicDeployment,
	id: DEPLOYMENT_ID,
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: AGENT_ID },
	},
};

test("Agent Plugins waits for a Cloud Agent projection", { tag: "@hosted-route-contract" }, async ({
	page,
}) => {
	const invalidCloudAgentRequests: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (path.startsWith(`/v1/agents/${DEPLOYMENT_ID}`)) invalidCloudAgentRequests.push(path);
	});
	await stubHostedApi(page, {
		canUseAgentPluginsUI: true,
		deployments: [
			{
				...deployment,
				config_info: {
					...deployment.config_info,
					clawdi_cloud_environments: {},
				},
			},
		],
	});

	await page.goto(`/agents/${DEPLOYMENT_ID}/plugins`);
	await expect(page.getByText("Plugins unavailable", { exact: true })).toBeVisible();
	expect(invalidCloudAgentRequests).toEqual([]);
});

test("Agent Plugins stays closed without the per-user capability", {
	tag: "@hosted-route-contract",
}, async ({ page }) => {
	await stubHostedApi(page, {
		deployments: [deployment],
	});

	await page.goto(`/agents/${AGENT_ID}?source=on-clawdi&d=${DEPLOYMENT_ID}`);
	await expect(page.getByRole("link", { name: "Plugins", exact: true })).toHaveCount(0);

	await page.goto(`/agents/${AGENT_ID}/plugins?source=on-clawdi&d=${DEPLOYMENT_ID}`);
	await expect(page).toHaveURL(new RegExp(`/agents/${DEPLOYMENT_ID}$`));
	await expect(page.getByRole("link", { name: "Plugins", exact: true })).toHaveCount(0);
});

test("Agent Plugins opens and installs with the per-user capability", {
	tag: "@hosted-route-contract",
}, async ({ page }) => {
	let installed = false;
	const desired = {
		installation_id: "22222222-2222-4222-8222-222222222222",
		agent_id: AGENT_ID,
		plugin_name: "sui",
		version: "1.0.0",
		catalog_revision: "a".repeat(40),
		desired_state: "present",
		convergence: "not_observed",
		observation_error_code: null,
		observed_at: null,
		created_at: "2026-08-17T00:00:00Z",
		updated_at: "2026-08-17T00:00:00Z",
	};
	await stubHostedApi(page, {
		canUseAgentPluginsUI: true,
		deployments: [deployment],
	});
	await page.route("http://127.0.0.1:8000/v1/plugin-catalog", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				plugins: [
					{
						name: "sui",
						version: "1.0.0",
						display_name: "Sui Agent",
						description: "Official Sui knowledge and tools.",
						publisher: "Mysten Labs",
						category: "developer-tools",
						keywords: ["sui"],
						languages: ["en"],
						runtimes: ["openclaw", "hermes"],
						components: { skills: ["sui"], mcpServers: { sui: "streamable-http" } },
						installable: true,
					},
				],
			}),
		});
	});
	await page.route(`http://127.0.0.1:8000/v1/agents/${AGENT_ID}/agent-plugins`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ plugins: installed ? [desired] : [] }),
		});
	});
	await page.route(
		`http://127.0.0.1:8000/v1/agents/${AGENT_ID}/agent-plugins/**`,
		async (route) => {
			installed = true;
			await route.fulfill({
				status: 202,
				contentType: "application/json",
				body: JSON.stringify(desired),
			});
		},
	);

	await page.goto(`/agents/${AGENT_ID}?source=on-clawdi&d=${DEPLOYMENT_ID}`);
	await page.getByRole("link", { name: "Plugins", exact: true }).click();
	await expect(page).toHaveURL(`/agents/${DEPLOYMENT_ID}/plugins`);
	await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
	await expect(page.getByText("Sui Agent", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Install", exact: true }).click();
	await expect(page.getByText("Not observed", { exact: true })).toBeVisible();
});
