import type { components } from "@clawdi/shared/api";
import { expect, type Page, test } from "@playwright/test";
import { CLOUD_API, collectBrowserErrors, fulfillJson } from "./hosted-fixtures";
import { includedBasicDeployment, stubHostedApi } from "./hosted-stub-api";

type CatalogEntry = components["schemas"]["PluginCatalogEntryResponse"];
type DesiredPlugin = components["schemas"]["AgentPluginDesiredStateResponse"];

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "hdep_agent_plugins";
const PLUGIN_NAME = "web-research";
const catalogEntry: CatalogEntry = {
	name: PLUGIN_NAME,
	version: "1.0.0",
	display_name: "Web Research",
	description: "Search and summarize trusted sources from the web.",
	publisher: "Example Labs",
	category: "research",
	keywords: ["browser", "research"],
	languages: ["en"],
	runtimes: ["openclaw", "hermes"],
	components: {
		skills: ["web-research"],
		mcpServers: { browser: "streamable-http" },
	},
	installable: true,
};

function desiredPlugin(): DesiredPlugin {
	return {
		installation_id: "22222222-2222-4222-8222-222222222222",
		agent_id: AGENT_ID,
		plugin_name: PLUGIN_NAME,
		version: catalogEntry.version,
		catalog_revision: "a".repeat(40),
		desired_state: "present",
		convergence: "not_observed",
		observation_error_code: null,
		observed_at: null,
		created_at: "2026-08-16T00:00:00Z",
		updated_at: "2026-08-16T00:00:00Z",
	};
}

test("hosted agent installs, inspects, and removes an Agent Plugin", async ({ page }) => {
	const mutationMethods: string[] = [];
	let desired: DesiredPlugin | null = null;
	await stubHostedApi(page, {
		deployments: [
			{
				...includedBasicDeployment,
				id: DEPLOYMENT_ID,
				name: "Plugin test agent",
				config_info: {
					...includedBasicDeployment.config_info,
					clawdi_cloud_environments: { hermes: AGENT_ID },
				},
			},
		],
	});
	await page.route(`${CLOUD_API}/v1/plugin-catalog`, (route) =>
		fulfillJson(route, {
			revision: "a".repeat(40),
			synced_at: "2026-08-16T00:00:00Z",
			plugins: [catalogEntry],
		}),
	);
	await page.route(`${CLOUD_API}/v1/agents/${AGENT_ID}/agent-plugins**`, (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === `/v1/agents/${AGENT_ID}/agent-plugins`) {
			return fulfillJson(route, { plugins: desired ? [desired] : [] });
		}
		if (path !== `/v1/agents/${AGENT_ID}/agent-plugins/${PLUGIN_NAME}`) {
			return fulfillJson(route, { detail: "Not found" }, 404);
		}
		if (request.method() === "PUT") {
			mutationMethods.push("PUT");
			desired = desiredPlugin();
			return fulfillJson(route, desired, 202);
		}
		if (request.method() === "DELETE") {
			mutationMethods.push("DELETE");
			desired = null;
			return fulfillJson(
				route,
				{ agent_id: AGENT_ID, plugin_name: PLUGIN_NAME, desired_state: "absent" },
				202,
			);
		}
		return fulfillJson(route, desired ?? { detail: "Not found" }, desired ? 200 : 404);
	});

	const errors = collectBrowserErrors(page);
	await page.setViewportSize({ width: 360, height: 800 });
	await page.goto(`/agents/${AGENT_ID}/plugins?source=on-clawdi&d=${DEPLOYMENT_ID}`);

	await expect(page.getByRole("heading", { name: "Plugins", exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Web Research" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Install", exact: true })).toBeVisible();
	await expectNoHorizontalOverflow(page);

	await page.getByRole("button", { name: "Install", exact: true }).click();
	await expect(page.getByText("Waiting for agent", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Open Web Research" })).toBeVisible();
	expect(mutationMethods).toEqual(["PUT"]);

	await page.getByRole("link", { name: "Open Web Research" }).click();
	await expect(page).toHaveURL(new RegExp(`/agents/${AGENT_ID}/plugins/${PLUGIN_NAME}`));
	await expect(page.getByRole("heading", { name: "Web Research", exact: true })).toBeVisible();
	await expect(page.getByText("Streamable HTTP", { exact: true })).toBeVisible();
	await expect(page.locator("code").filter({ hasText: /^web-research$/ })).toBeVisible();
	await expectNoHorizontalOverflow(page);

	await page.setViewportSize({ width: 1024, height: 800 });
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(page.locator("html")).toHaveClass(/dark/);
	await expectNoHorizontalOverflow(page);
	await page.getByRole("button", { name: "Remove", exact: true }).click();
	await expect(page.getByRole("alertdialog", { name: "Remove Web Research?" })).toBeVisible();
	await page.getByRole("button", { name: "Remove plugin", exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/agents/${AGENT_ID}/plugins\\?`));
	await expect(page.getByRole("button", { name: "Install", exact: true })).toBeVisible();
	expect(mutationMethods).toEqual(["PUT", "DELETE"]);
	expect(errors, `Agent Plugins flow: ${errors.join(" | ")}`).toEqual([]);
});

async function expectNoHorizontalOverflow(page: Page) {
	await expect
		.poll(() =>
			page.evaluate(() => ({
				clientWidth: document.documentElement.clientWidth,
				scrollWidth: document.documentElement.scrollWidth,
			})),
		)
		.toEqual({
			clientWidth: page.viewportSize()?.width,
			scrollWidth: page.viewportSize()?.width,
		});
}
