import { expect, test } from "@playwright/test";
import { includedBasicDeployment, stubHostedApi } from "./hosted-stub-api";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "hdep_agent_plugins_closed";

test("Agent Plugins has no product entry while closed", async ({ page }) => {
	await stubHostedApi(page, {
		deployments: [
			{
				...includedBasicDeployment,
				id: DEPLOYMENT_ID,
				config_info: {
					...includedBasicDeployment.config_info,
					clawdi_cloud_environments: { hermes: AGENT_ID },
				},
			},
		],
	});

	await page.goto(`/agents/${AGENT_ID}?source=on-clawdi&d=${DEPLOYMENT_ID}`);
	await expect(page.getByRole("link", { name: "Plugins", exact: true })).toHaveCount(0);

	await page.goto(`/agents/${AGENT_ID}/plugins?source=on-clawdi&d=${DEPLOYMENT_ID}`);
	await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
