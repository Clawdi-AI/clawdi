import type { components } from "@clawdi/shared/api";
import { expect, test } from "@playwright/test";
import { includedBasicDeployment, stubHostedApi } from "./hosted-stub-api";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "hdep_agent_plugins_closed";

const deployment = {
	...includedBasicDeployment,
	id: DEPLOYMENT_ID,
	agent_id: AGENT_ID,
	config_info: {
		...includedBasicDeployment.config_info,
		clawdi_cloud_environments: { hermes: AGENT_ID },
	},
};

type CatalogEntry = components["schemas"]["PluginCatalogEntryResponse"];
type DesiredPlugin = components["schemas"]["AgentPluginDesiredStateResponse"];
let desiredPluginSequence = 0;

function catalogEntry(name: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
	return {
		name,
		version: "1.0.0",
		display_name: name,
		description: `${name} guidance and tools for coding agents.`,
		publisher: "Example Partner",
		category: "developer-tools",
		keywords: [name],
		languages: ["en"],
		runtimes: ["openclaw", "hermes"],
		components: { skills: [`${name}-skill`], mcpServers: {} },
		installable: true,
		...overrides,
	};
}

function desiredPlugin(name: string, overrides: Partial<DesiredPlugin> = {}): DesiredPlugin {
	desiredPluginSequence += 1;
	const idSuffix = desiredPluginSequence.toString(16).padStart(12, "0");
	return {
		installation_id: `22222222-2222-4222-8222-${idSuffix}`,
		agent_id: AGENT_ID,
		plugin_name: name,
		version: "1.0.0",
		catalog_revision: "a".repeat(40),
		desired_state: "present",
		convergence: "installed",
		observation_error_code: null,
		observed_at: "2026-08-22T00:00:00Z",
		created_at: "2026-08-22T00:00:00Z",
		updated_at: "2026-08-22T00:00:00Z",
		...overrides,
	};
}

test("Agent Plugins stays closed without the per-user capability", async ({ page }) => {
	await stubHostedApi(page, {
		deployments: [deployment],
	});

	await page.goto(`/agents/${AGENT_ID}`);
	await expect(
		page.getByTestId("app-sidebar").getByRole("link", { name: "Plugins", exact: true }),
	).toHaveCount(0);
	await expect(page.locator('[data-overview-module="plugins"]')).toHaveCount(0);

	await page.goto(`/agents/${AGENT_ID}/plugins`);
	await expect(page).toHaveURL(new RegExp(`/agents/${AGENT_ID}$`));

	await page.goto(`/agents/${AGENT_ID}/plugins/sui`);
	await expect(page).toHaveURL(new RegExp(`/agents/${AGENT_ID}$`));
	await expect(
		page.getByTestId("app-sidebar").getByRole("link", { name: "Plugins", exact: true }),
	).toHaveCount(0);
	await expect(page.locator('[data-overview-module="plugins"]')).toHaveCount(0);
});

test("Agent Plugin cards keep every status and action readable", async ({ page }) => {
	const catalog = [
		catalogEntry("available", { display_name: "Available Plugin" }),
		catalogEntry("failed", { display_name: "Failed Plugin", version: "2.0.0" }),
		catalogEntry("installed", { display_name: "Installed Plugin" }),
		catalogEntry("installing", { display_name: "Installing Plugin", version: "2.0.0" }),
		catalogEntry("requires-setup", {
			display_name: "Plugin Requiring Setup",
			installable: false,
			installability_reason: "configuration_not_supported",
		}),
		catalogEntry("reserved", {
			display_name: "Reserved Plugin",
			installable: false,
			installability_reason: "reserved_name",
		}),
		catalogEntry("runtime-unavailable", {
			display_name: "Runtime Unavailable Plugin",
			runtimes: ["openclaw"],
		}),
		catalogEntry("update", {
			display_name: "Update Available Plugin",
			version: "2.0.0",
			publisher: "Mysten Labs",
			components: {
				skills: Array.from({ length: 21 }, (_, index) => `sui-${index}`),
				mcpServers: { "sui-docs": "streamable-http" },
			},
		}),
		catalogEntry("waiting", {
			display_name: "Plugin Waiting for Agent",
			version: "2.0.0",
		}),
	];
	const desired = [
		desiredPlugin("failed", {
			convergence: "failed",
			observation_error_code: "reconcile_failed",
		}),
		desiredPlugin("installed"),
		desiredPlugin("installing", {
			convergence: "not_observed",
			updated_at: new Date().toISOString(),
		}),
		desiredPlugin("legacy-plugin"),
		desiredPlugin("update"),
		desiredPlugin("waiting", {
			convergence: "not_observed",
			updated_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
		}),
	];
	await stubHostedApi(page, {
		canUseAgentPluginsUI: true,
		deployments: [deployment],
	});
	await page.route("http://127.0.0.1:8000/v1/plugin-catalog", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ plugins: catalog }),
		});
	});
	await page.route(`http://127.0.0.1:8000/v1/agents/${AGENT_ID}/agent-plugins`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ plugins: desired }),
		});
	});

	await page.goto(`/agents/${AGENT_ID}`);
	await expect(page.locator('[data-overview-module="plugins"]')).toContainText(
		"3 installed · 2 pending · 1 failed",
	);

	await page.setViewportSize({ width: 320, height: 844 });
	await page.goto(`/agents/${AGENT_ID}/plugins`);
	const cardFor = (title: string) =>
		page.getByRole("button", { name: `View ${title} details` }).locator("..");
	const states = [
		{ title: "Available Plugin", action: "Install", disabled: false, removable: false },
		{ title: "Plugin Requiring Setup", action: "Requires setup", disabled: true, removable: false },
		{ title: "Reserved Plugin", action: "Reserved", disabled: true, removable: false },
		{
			title: "Runtime Unavailable Plugin",
			action: "Unavailable",
			disabled: true,
			removable: false,
		},
		{ title: "Installed Plugin", action: "Installed", disabled: true, removable: true },
		{ title: "Update Available Plugin", action: "Update", disabled: false, removable: true },
		{ title: "Installing Plugin", action: "Installing…", disabled: true, removable: true },
		{
			title: "Plugin Waiting for Agent",
			action: "Waiting for agent",
			disabled: true,
			removable: true,
		},
		{ title: "Failed Plugin", action: "Retry", disabled: false, removable: true },
		{ title: "legacy-plugin", action: "Installed", disabled: true, removable: true },
	] as const;
	for (const state of states) {
		const card = cardFor(state.title);
		await expect(card).toBeVisible();
		const primaryAction = card.getByRole("button", { name: state.action, exact: true });
		await expect(primaryAction).toBeVisible();
		if (state.disabled) {
			await expect(primaryAction).toBeDisabled();
		} else {
			await expect(primaryAction).toBeEnabled();
		}
		if (state.removable) {
			await expect(
				card.getByRole("button", { name: `Remove ${state.title}`, exact: true }),
			).toBeVisible();
		}
	}
	await expect(cardFor("Failed Plugin").getByRole("button", { name: "Retry" })).toHaveAttribute(
		"title",
		"The agent could not apply this plugin.",
	);
	await expect(page.getByRole("main").locator('[data-slot="status-badge"]')).toHaveCount(0);
	expect(
		await cardFor("Installed Plugin")
			.getByRole("button", { name: "Installed", exact: true })
			.evaluate((button) => button.getBoundingClientRect().width),
	).toBeLessThan(120);

	const updateFooter = cardFor("Update Available Plugin").locator('[data-slot="entity-meta"]');
	await expect(updateFooter).toContainText("Mysten Labs");
	await expect(updateFooter).toContainText("v1.0.0 → v2.0.0");
	await expect(updateFooter).toContainText("21 Skills · 1 MCP server");
	expect(
		await updateFooter
			.locator(":scope > span")
			.evaluateAll((items) => new Set(items.map((item) => (item as HTMLElement).offsetTop)).size),
	).toBeGreaterThan(1);

	const cards = page.locator('[data-slot="entity-card"]');
	await expect(cards).toHaveCount(states.length);
	const readLayouts = () =>
		cards.evaluateAll((elements) =>
			elements.map((card) => {
				const cardRect = card.getBoundingClientRect();
				const heading = card.querySelector("h3");
				const badge = card.querySelector('[data-slot="status-badge"]');
				const controls = Array.from(card.querySelectorAll("button"));
				return {
					title: heading?.textContent ?? "Unknown plugin",
					cardFits: card.scrollWidth <= card.clientWidth,
					badgesFit: Array.from(card.querySelectorAll('[data-slot="status-badge"]')).every(
						(item) => item.scrollWidth <= item.clientWidth,
					),
					metadataFits: Array.from(
						card.querySelectorAll('[data-slot="entity-meta"] > span > span'),
					).every((item) => item.scrollWidth <= item.clientWidth),
					controlsFit: controls.every((control) => {
						const rect = control.getBoundingClientRect();
						return (
							control.scrollWidth <= control.clientWidth &&
							rect.left >= cardRect.left - 1 &&
							rect.right <= cardRect.right + 1
						);
					}),
					titleClearsBadge:
						!heading ||
						!badge ||
						heading.getBoundingClientRect().right <= badge.getBoundingClientRect().left,
				};
			}),
		);
	for (const viewport of [
		{ width: 320, height: 844 },
		{ width: 1440, height: 1000 },
	]) {
		await page.setViewportSize(viewport);
		const layouts = await readLayouts();
		expect(
			layouts.filter(
				({ cardFits, badgesFit, metadataFits, controlsFit, titleClearsBadge }) =>
					!cardFits || !badgesFit || !metadataFits || !controlsFit || !titleClearsBadge,
			),
		).toEqual([]);
	}

	await page.getByRole("button", { name: "View Plugin Waiting for Agent details" }).click();
	await expect(page.getByRole("button", { name: "Waiting for agent", exact: true })).toBeDisabled();
	await expect(page.getByRole("alert")).toContainText("Agent hasn't picked up this change");
	await expect(page.getByRole("main").locator('[data-slot="status-badge"]')).toHaveCount(0);
});

test("Agent Plugins opens and installs with the per-user capability", async ({ page }) => {
	let installed = false;
	let acceptInstall = () => {};
	const installAccepted = new Promise<void>((resolve) => {
		acceptInstall = resolve;
	});
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
		updated_at: new Date().toISOString(),
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
			if (route.request().method() === "PUT") {
				await installAccepted;
				installed = true;
			} else {
				installed = false;
			}
			await route.fulfill({
				status: 202,
				contentType: "application/json",
				body: JSON.stringify(desired),
			});
		},
	);

	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`/agents/${AGENT_ID}`);
	await expect(
		page.getByTestId("app-sidebar").getByRole("link", { name: "Plugins", exact: true }),
	).toBeVisible();
	const overviewPlugins = page.locator('[data-overview-module="plugins"]');
	await expect(overviewPlugins).toContainText("No plugins installed");
	const workspaceModules = page.locator(
		'section[aria-labelledby="agent-overview-workspace"] [data-overview-module]',
	);
	await expect(workspaceModules).toHaveCount(4);
	const workspaceRows = await workspaceModules.evaluateAll((modules) => {
		const rowCounts = new Map<number, number>();
		for (const module of modules) {
			const top = Math.round(module.getBoundingClientRect().top);
			rowCounts.set(top, (rowCounts.get(top) ?? 0) + 1);
		}
		return [...rowCounts.values()].sort();
	});
	expect(workspaceRows).toEqual([2, 2]);
	await overviewPlugins.getByRole("link", { name: "Plugins", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
	await expect(page.getByText("Sui Agent", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Install", exact: true }).click();
	await expect(page.getByRole("button", { name: "Installing…", exact: true })).toBeDisabled();
	const desiredRefetched = page.waitForResponse(
		(response) =>
			response.request().method() === "GET" &&
			response.url() === `http://127.0.0.1:8000/v1/agents/${AGENT_ID}/agent-plugins`,
	);
	acceptInstall();
	await desiredRefetched;
	await expect(page.getByRole("button", { name: "Installing…", exact: true })).toBeDisabled();
	await expect(page.getByRole("main").locator('[data-slot="status-badge"]')).toHaveCount(0);
	await page.getByRole("button", { name: "View Sui Agent details" }).click();
	await expect(page.getByRole("heading", { name: "Sui Agent", exact: true })).toBeVisible();
	await expect(page.getByText("OpenClaw", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Hermes", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Installing…", exact: true })).toBeDisabled();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Remove Sui Agent", exact: true })).toBeVisible();
	await page.getByTestId("app-sidebar").getByRole("link", { name: "Plugins", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
	await page.getByRole("button", { name: "Remove Sui Agent", exact: true }).click();
	await page.getByRole("button", { name: "Remove plugin", exact: true }).click();
	await expect(page.getByRole("button", { name: "Install", exact: true })).toBeVisible();
	await expect(page.getByText("Sui Agent", { exact: true })).toBeVisible();
});
