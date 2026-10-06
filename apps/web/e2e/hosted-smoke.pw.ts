import { expect, test } from "@playwright/test";
import type { AiProvider } from "../src/hosted/v2/ai-providers/types";
import {
	type DeploymentMutationFixture,
	fixtureAgentId,
	mutationDeploymentReadFixture,
	nativeProviderConflict,
} from "./hosted-stub-api";

import {
	basicPlan,
	CLOUD_API,
	completedDeploymentOperation,
	DEPLOY_API,
	expectContainedInOwnerAndViewport,
	expectInlineSidebarStatus,
	expectLiveToolFillsDashboard,
	expectNoHorizontalOverflow,
	expectTerminalFitsHost,
	failedMissingProjectionDeployment,
	fulfillJson,
	gotoHostedAgentSettings,
	hostedOverviewSessionsPage,
	includedBasicDeployment,
	missingProjectionEnvironmentId,
	missingProjectionFailureReason,
	paidBasicDeployment,
	performancePlan,
	railHostedCloudAgent,
	railHostedDeployment,
	railHostedEnvironmentId,
	runningMissingProjectionDeployment,
	stubHostedApi,
	userProvider,
} from "./support/hosted-api-stub";

test("overview loads resources and retains memory data after a failed refetch", async ({
	page,
}) => {
	const paidSubscription = paidBasicDeployment.compute_subscription;
	if (!paidSubscription) throw new Error("Missing paid subscription fixture");
	const deployment = mutationDeploymentReadFixture({
		...railHostedDeployment,
		hermes_control_ui_url: "https://runtime.example/",
		config_info: { ...railHostedDeployment.config_info, compute_plan_slug: "compute_performance" },
		compute_subscription: {
			...paidSubscription,
			current_period_end: "2026-09-11T00:00:00Z",
		},
	});
	const sessionsPage = hostedOverviewSessionsPage(3);
	await stubHostedApi(page, {
		deployments: [deployment],
		cloudAgents: [railHostedCloudAgent],
		plans: [basicPlan, performancePlan],
		agentResourceFixtures: true,
		sessionsPage,
	});
	let inventoryGate = Promise.resolve();
	let resourceGate = Promise.resolve();
	await page.route(`${DEPLOY_API}/v2/deployments**`, async (route) => {
		if (new URL(route.request().url()).pathname === "/v2/deployments") await inventoryGate;
		await route.fallback();
	});
	await page.route(`${CLOUD_API}/**`, async (route) => {
		if (/\/(agent-plugins|memories|vault|connectors)(\?|$)/.test(route.request().url()))
			await resourceGate;
		await route.fallback();
	});
	for (const viewport of [
		{ width: 1440, height: 900 },
		{ width: 390, height: 844 },
		{ width: 320, height: 800 },
	]) {
		await page.setViewportSize(viewport);
		let releaseInventory = () => {};
		let releaseResources = () => {};
		inventoryGate = new Promise<void>((resolve) => {
			releaseInventory = resolve;
		});
		resourceGate = new Promise<void>((resolve) => {
			releaseResources = resolve;
		});
		try {
			await page.goto(`/agents/${railHostedEnvironmentId}`);
			await expect(page.getByTestId("overview-status-card-skeleton")).toBeVisible();
			releaseInventory();
			await expect(page.locator("[data-overview-compute-plan]")).toHaveText("Performance plan");
			await expect(
				page.locator('[data-overview-module="plugins"] [data-slot="skeleton"]'),
			).toBeVisible();

			releaseResources();
			await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
		} finally {
			releaseInventory();
			releaseResources();
		}
	}
	let memoryFailures = 0;
	await page.route(`${CLOUD_API}/v1/memories?*`, async (route) => {
		memoryFailures += 1;
		await fulfillJson(route, { detail: "Temporary fixture error" }, 503);
	});
	const currentTime = await page.evaluate(() => Date.now());
	await page.clock.setFixedTime(currentTime + 60_000);
	await page.locator('main a[href$="/sessions"]').click();
	await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
	await page.goBack();
	await expect.poll(() => memoryFailures).toBe(3);
	await page.evaluate(() => new Promise(requestAnimationFrame));
	const memories = page.locator('[data-overview-module="memories"]');
	await expect(memories).toContainText("1 memory");
	await expect(memories.locator('[data-slot="skeleton"]')).toHaveCount(0);
});

test("runtime readiness keeps launch closed across generation and credential races", async ({
	page,
	context,
}) => {
	test.setTimeout(120_000);
	const deployment = mutationDeploymentReadFixture({
		...railHostedDeployment,
		openclaw_control_ui_url: "https://runtime.example/",
		config_info: { ...railHostedDeployment.config_info, runtime: "openclaw" },
	});
	const readyStatus = deployment.resource.status;
	const endpoint = deployment.runtime_ui_endpoint;
	if (!readyStatus || !endpoint) throw new Error("Missing runtime readiness fixture");
	let handoffUrl = `${endpoint.url}#bootstrapToken=fixture-token&bootstrapProfile=owner`;
	const credentialRequests: string[] = [];
	const refreshInventory = async () => {
		await page.clock.setFixedTime(await page.evaluate(() => Date.now() + 31_000));
		await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
	};
	await stubHostedApi(page, {
		deployments: [deployment],
		cloudAgents: [],
		agentResourceFixtures: true,
		runtimeUiRedemptionRequests: credentialRequests,
	});
	await context.route("https://runtime.example/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><title>Runtime fixture</title><h1>Mock authentication target</h1>",
		}),
	);
	let releaseCredentials = () => {};
	const credentialGate = new Promise<void>((resolve) => {
		releaseCredentials = resolve;
	});
	let credentialFailures = 0;
	await page.route(`${DEPLOY_API}/v2/deployments/*/runtime-ui/credentials`, async (route) => {
		credentialRequests.push(route.request().url());
		const version = deployment.resource.metadata.resourceVersion;
		await credentialGate;
		if (credentialFailures-- > 0)
			return route.fulfill({
				status: 409,
				contentType: "application/json",
				body: JSON.stringify({ detail: "Runtime UI credential is unavailable" }),
			});
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				runtime: "openclaw",
				url: endpoint.url,
				deployment_resource_version: version,
				auth_mode: "openclaw_token",
				token: "fixture-token",
				handoff_url: handoffUrl,
			}),
		});
	});
	for (const state of ["starting", "no-endpoint", "old-ack", "old-generation"] as const) {
		deployment.resource.status = {
			...readyStatus,
			summary_state: state === "starting" ? "starting" : "running",
			driver_acknowledged_generation: state === "old-ack" ? 0 : 1,
		};
		deployment.resource.metadata.generation = state === "old-generation" ? 2 : 1;
		deployment.runtime_ui_endpoint = state === "no-endpoint" ? null : endpoint;
		await page.goto(`/agents/${railHostedEnvironmentId}`);
		const launch = page.locator('[data-overview-module="dashboard"]');
		if (state === "starting") {
			await expect(page.getByTestId("hosted-initial-deployment-panel")).toBeVisible();
			await expect(launch).toHaveCount(0);
		} else {
			await expect(launch.getByRole("button", { name: "Chat on the web" })).toBeDisabled();
		}

		expect(credentialRequests).toHaveLength(0);
	}
	deployment.resource.metadata.generation = 1;
	deployment.resource.status = { ...readyStatus, summary_state: "creating" };
	deployment.runtime_ui_endpoint = null;
	await page.goto(`/agents/${railHostedEnvironmentId}`);
	try {
		await expect(page.getByTestId("hosted-initial-deployment-panel")).toBeVisible();
		expect(credentialRequests).toHaveLength(0);
		// Stay on the first deployment's overview while inventory polling observes
		// running first, then the published endpoint. Neither step needs navigation.
		deployment.resource.status = readyStatus;
		await expect(
			page.locator('[data-overview-module="dashboard"]').getByRole("button", {
				name: "Chat on the web",
			}),
		).toBeDisabled({ timeout: 15_000 });
		expect(credentialRequests).toHaveLength(0);
		deployment.runtime_ui_endpoint = endpoint;
		await expect.poll(() => credentialRequests.length, { timeout: 15_000 }).toBe(1);
		await expect(page).toHaveURL(`/agents/${railHostedEnvironmentId}`);
		await expect(page.locator("main iframe")).toHaveCount(0);
		releaseCredentials();
		const iframe = page.locator('iframe[title="OpenClaw Control UI"]');
		await expect(iframe).toHaveAttribute("src", handoffUrl);
		await expect(iframe).toBeHidden();
		const firstFrame = await iframe.elementHandle();
		await page.getByRole("link", { name: "Chat on the web" }).click();
		await expect(iframe).toBeVisible();
		expect(credentialRequests).toHaveLength(1);
		expect(await firstFrame?.evaluate((element) => element.isConnected)).toBe(true);
		credentialFailures = 1;
		await page.getByRole("button", { name: "Reconnect", exact: true }).click();
		await expect(page.getByText("Clawdi couldn't establish this browser session.")).toBeVisible();
		await expect(iframe).toHaveCount(0);
		expect(await firstFrame?.evaluate((element) => element.isConnected)).toBe(false);
		await page.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(iframe).toHaveAttribute("src", handoffUrl);
		expect(credentialRequests).toHaveLength(3);
		const beforeGeneration = await iframe.elementHandle();
		deployment.resource.metadata.generation = 2;
		deployment.resource.metadata.resourceVersion = "rv_generation_2";
		deployment.resource.status = {
			...readyStatus,
			observedGeneration: 2,
			driver_acknowledged_generation: 2,
			driver_applied_generation: 2,
			conditions: readyStatus.conditions.map((condition) => ({
				...condition,
				observedGeneration: 2,
			})),
		};
		await refreshInventory();
		await expect.poll(() => credentialRequests.length, { timeout: 15_000 }).toBe(4);
		await expect(iframe).toHaveAttribute("src", handoffUrl);
		expect(await beforeGeneration?.evaluate((element) => element.isConnected)).toBe(false);
		const beforeEndpoint = await iframe.elementHandle();
		endpoint.url = "https://runtime.example/moved/";
		handoffUrl = `${endpoint.url}#bootstrapToken=moved-token&bootstrapProfile=owner`;
		await refreshInventory();
		await expect.poll(() => credentialRequests.length, { timeout: 15_000 }).toBe(5);
		await expect(iframe).toHaveAttribute("src", handoffUrl);
		expect(await beforeEndpoint?.evaluate((element) => element.isConnected)).toBe(false);
		deployment.resource.status = { ...deployment.resource.status, summary_state: "stopped" };
		await refreshInventory();
		await expect(iframe).toHaveCount(0, { timeout: 15_000 });
		await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
		expect(credentialRequests).toHaveLength(5);
		await firstFrame?.dispose();
		await beforeGeneration?.dispose();
		await beforeEndpoint?.dispose();
	} finally {
		releaseCredentials();
	}
});

test("Help opens Chatwoot live chat", async ({ page }) => {
	await page.addInitScript(() => {
		window.__chatwootToggleCalls = 0;
		window.$chatwoot = {
			hasLoaded: true,
			darkMode: "light",
			setColorScheme: () => {},
			setUser: () => {},
			reset: () => {},
			toggle: () => {
				window.__chatwootToggleCalls = (window.__chatwootToggleCalls ?? 0) + 1;
			},
			toggleBubbleVisibility: () => {},
		};
	});
	await stubHostedApi(page);
	await page.goto("/agents");
	await page.waitForLoadState("networkidle");

	await page.getByTestId("app-sidebar-help-menu-button").click();
	await expect(page.getByRole("menuitem", { name: "Docs" })).toBeVisible();
	const liveChat = page.getByRole("menuitem", { name: "Live chat" });
	await expect(liveChat).toBeVisible();
	await liveChat.click();
	await expect.poll(() => page.evaluate(() => window.__chatwootToggleCalls)).toBe(1);
});

test("hosted agent overview uses the modular hierarchy", async ({ page }) => {
	const sessionRequests: string[] = [];
	const aiProviderRequests: string[] = [];
	const managedModelRequests: string[] = [];
	const overviewConnectorRequests: string[] = [];
	const agentProjectRequests: string[] = [];
	const skillRequests: string[] = [];
	const vaultRequests: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (path.startsWith("/v1/connectors/available")) overviewConnectorRequests.push(path);
	});
	const telegramAccount = {
		id: "channel-overview-telegram",
		provider: "telegram",
		name: "Research Telegram",
		status: "active",
		created_at: "2026-07-15T00:00:00Z",
	};
	await stubHostedApi(page, {
		sessionRequests,
		aiProviderRequests,
		managedModelRequests,
		agentProjectRequests,
		skillRequests,
		vaultRequests,
		deployments: [railHostedDeployment],
		cloudAgents: [railHostedCloudAgent],
		agentResourceFixtures: true,
		sessionsPage: hostedOverviewSessionsPage(5),
		connectorConnections: [
			{ id: "hosted-conn-github", app_name: "github", status: "ACTIVE" },
			{ id: "hosted-conn-slack", app_name: "slack", status: "ACTIVE" },
		],
		connectorCatalog: ["github", "slack", "gmail", "notion", "linear", "dropbox", "calendar"].map(
			(name) => ({
				name,
				display_name: name[0]?.toUpperCase() + name.slice(1),
				logo: "",
				description: `${name} connector`,
				auth_type: "oauth",
				connect_disabled: false,
				connect_disabled_reason: null,
			}),
		),
		skillsByProjectId: {
			"project-hosted": [
				{
					id: "skill-hosted-briefing",
					skill_key: "briefing",
					name: "Daily briefing",
					description: "Prepare daily briefings",
					version: 1,
					source: "cloud",
					authority: "cloud",
					source_repo: null,
					agent_types: ["hermes"],
					file_count: 1,
					content_hash: "b".repeat(64),
					is_active: true,
					created_at: "2026-07-15T00:00:00Z",
					updated_at: "2026-07-15T00:00:00Z",
					project_id: "project-hosted",
					project_name: "Hosted Agent Project",
					project_kind: "environment",
				},
			],
		},
		channelAgentLinks: [
			{
				id: "link-overview-telegram",
				account_id: telegramAccount.id,
				agent_id: railHostedEnvironmentId,
				status: "active",
				created_at: "2026-07-15T00:00:00Z",
				account: telegramAccount,
			},
		],
	});
	await page.goto(`/agents/${railHostedEnvironmentId}`);
	await expect.poll(() => sessionRequests.length).toBe(1);
	expect(new URL(sessionRequests[0] ?? "http://invalid").searchParams.get("page_size")).toBe("3");

	const overview = page.locator("main");
	const overviewTitleRow = page.locator('[data-slot="page-header"]');
	await expect(overviewTitleRow.getByText("Cloud Agent", { exact: true })).toHaveCount(1);
	await expect(overviewTitleRow.getByText("Legacy", { exact: true })).toHaveCount(0);
	await expect(overview.getByRole("heading", { name: "Workspace", exact: true })).toBeVisible({
		timeout: 12_000,
	});
	await expect(overview.getByRole("heading", { name: "Shared", exact: true })).toBeVisible();
	await expect(overview.locator("[data-overview-access-scope]")).toHaveCount(0);
	await expect(overview.locator("[data-overview-module-error]")).toHaveCount(0);
	await expect(
		overview.locator(
			"[data-overview-module] a a, [data-overview-module] a button, [data-overview-module] button a",
		),
	).toHaveCount(0);
	await expect(overview.getByRole("heading", { name: "Connections", exact: true })).toHaveCount(0);
	await expect(overview.locator('[data-overview-module="channels"]')).toContainText(
		"Telegram, Discord, or WhatsApp",
	);
	await expect(overview.locator('[data-overview-module="sessions"]')).toHaveCount(0);
	await expect(overview.locator('[data-overview-module="projects"]')).not.toContainText(
		"Hosted Agent Project",
	);
	await expect(overview.getByText("Default Project", { exact: true })).toHaveCount(0);
	await expect(overview.getByTestId("agent-project-grid")).toHaveCount(0);
	expect(agentProjectRequests).toHaveLength(1);
	expect(skillRequests).toHaveLength(1);
	expect(new URL(skillRequests[0] ?? "http://invalid").searchParams.get("project_id")).toBe(
		"project-hosted",
	);
	expect(vaultRequests).toHaveLength(1);
	expect(new URL(vaultRequests[0] ?? "http://invalid").searchParams.get("project_id")).toBe(
		"project-hosted",
	);
	const viewAllSessions = page
		.locator("#hosted-recent-sessions")
		.locator("..")
		.getByRole("button", { name: "View all", exact: true });
	const viewAllHref = await viewAllSessions.getAttribute("href");
	const viewAllUrl = new URL(viewAllHref ?? "", page.url());
	expect(viewAllUrl.pathname).toBe(`/agents/${railHostedEnvironmentId}/sessions`);
	expect(viewAllUrl.search).toBe("");
	const recentSessions = page.getByRole("region", { name: "Recent sessions" });
	await expect(recentSessions.locator("article")).toHaveCount(3);
	await expect(recentSessions).not.toContainText("Review risks");
	await expect(page.locator('[data-overview-module="dashboard"]')).toBeVisible();
	await expect(page.getByRole("button", { name: "Chat on the web", exact: true })).toBeDisabled();
	const compute = page.locator('[data-overview-status="compute"]');
	await expect(compute).toContainText("Running");
	await expect(compute).toContainText("Basic plan");
	await expect(compute.getByRole("link", { name: "Compute", exact: true })).toHaveAttribute(
		"href",
		/\/settings/,
	);
	await expect(compute.getByRole("button")).toHaveCount(0);
	await expect(compute.locator("a a, a button, button a")).toHaveCount(0);
	await expect(compute.getByLabel("Compute resources", { exact: true })).toBeVisible();
	await expect(overview.locator('[data-overview-module="model-provider"]')).toContainText(
		"AI Providers",
	);
	expect(aiProviderRequests).toEqual([]);
	await expect.poll(() => managedModelRequests.length).toBe(1);
	for (const configuration of ["2 vCPU", "4 GiB RAM", "20 GiB storage"])
		await expect(compute.getByText(configuration, { exact: true })).toBeVisible();
	await expect(overview.locator('[data-overview-module="skills"]')).toContainText(
		"No skills installed",
	);
	await expect(overview.locator('[data-overview-module="vaults"]')).toContainText("1 vault");
	await expect(
		overview.locator('[data-overview-module="skills"]').getByRole("link", { name: "Skills" }),
	).toHaveAttribute(
		"href",
		`/agents/${railHostedEnvironmentId}/project-access/project-hosted/skills`,
	);
	await expect(
		overview.locator('[data-overview-module="vaults"]').getByRole("link", { name: "Vaults" }),
	).toHaveAttribute("href", `/agents/${railHostedEnvironmentId}/vaults`);
	await expect(overview.locator('[data-overview-module="memories"]')).toContainText("1 memory");
	await expect(overview.locator('[data-overview-module="connectors"]')).toContainText("2 apps");
	expect(overviewConnectorRequests).toEqual([]);
	const sidebar = page.getByTestId("app-sidebar");
	await expect(sidebar.getByText("Running", { exact: true })).toBeVisible();
	await expectInlineSidebarStatus(sidebar, "hosted");
	await expect(sidebar.getByText("Paused", { exact: true })).toHaveCount(0);
	await expect(sidebar.getByText(/last seen/i)).toHaveCount(0);
	for (const section of ["Projects", "Memories", "Connectors", "Skills", "Vaults"]) {
		await expect(sidebar.getByRole("link", { name: section, exact: true })).toBeVisible();
	}
	const projectGroup = sidebar.getByRole("group", {
		name: "Workspace",
		exact: true,
	});
	const skillsLink = projectGroup.getByRole("link", { name: "Skills", exact: true });
	const vaultsLink = projectGroup.getByRole("link", { name: "Vaults", exact: true });
	const expectedProjectHub = `/agents/${railHostedEnvironmentId}/project-access/project-hosted`;
	await expect(skillsLink).toHaveAttribute("href", `${expectedProjectHub}/skills`);
	await expect(vaultsLink).toHaveAttribute("href", `/agents/${railHostedEnvironmentId}/vaults`);
	await vaultsLink.focus();
	await expect(vaultsLink).toBeFocused();
	await vaultsLink.click();
	await expect(page).toHaveURL(`/agents/${railHostedEnvironmentId}/vaults`);
	await expect(vaultsLink).toHaveAttribute("data-active", "");
	await expect(skillsLink).not.toHaveAttribute("data-active", "");
	await page.goto(`/agents/${railHostedEnvironmentId}`);
	await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
	await page.setViewportSize({ width: 390, height: 1200 });
	await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
	const mobileSidebar = page.getByRole("dialog");
	await expectInlineSidebarStatus(mobileSidebar, "hosted");

	await page.keyboard.press("Escape");
	await page.goto(`/agents/${railHostedEnvironmentId}/sessions`);
	const sessionsHeading = page.getByRole("heading", { name: "Sessions", exact: true });
	await expect(sessionsHeading).toBeVisible();
	await expect(sessionsHeading.locator("..").getByText("Cloud Agent", { exact: true })).toHaveCount(
		0,
	);
	await expect(page.getByRole("button", { name: "Chat on the web", exact: true })).toHaveCount(0);
});

for (const projectionFailure of [
	{ name: "missing", response: { status: 404, body: { detail: "Agent not found" } } },
	{ name: "error", response: { status: 500, body: { detail: "projection gateway failed" } } },
] as const) {
	test(`hosted overview renders from deployment authority when the agent projection is ${projectionFailure.name}`, async ({
		page,
	}) => {
		// The overview renders from deployment status alone: a missing or
		// erroring projection never blanks the page and never leaks internals.
		await stubHostedApi(page, {
			deployments: [runningMissingProjectionDeployment],
			cloudAgentResponses:
				projectionFailure.name === "missing"
					? { [missingProjectionEnvironmentId]: [projectionFailure.response] }
					: undefined,
			cloudAgentErrors:
				projectionFailure.name === "error"
					? {
							[missingProjectionEnvironmentId]: {
								status: 500,
								detail: "projection gateway failed",
							},
						}
					: undefined,
		});
		await page.goto(`/agents/${missingProjectionEnvironmentId}`);
		const main = page.locator("main");
		await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
		await expect(main.getByText("Unavailable right now", { exact: true }).first()).toBeVisible();
		await expect(main).not.toContainText("projection gateway failed");
	});
}

test("Custom model ownership is preserved in agent settings", async ({ page }) => {
	const id = "existing-provider";
	const provider = {
		...userProvider(id, "Existing provider", [{ id: "legacy-first" }, { id: "legacy-second" }]),
		configuration_mode: "custom" as const,
	};
	const deployment: DeploymentMutationFixture = {
		...railHostedDeployment,
		config_info: {
			...railHostedDeployment.config_info,
			ai_provider_auth_kind: "api_key",
			runtime_configuration: {
				providers: [
					{
						provider_id: id,
						auth_kind: "secret_reference",
						models: ["legacy-first", "legacy-second"],
					},
				],
				primary_model: { provider_id: id, model: "legacy-first" },
				features: [],
			},
		},
	};
	const updates: Array<{ body: string; idempotencyKey: string | null; ifMatch: string | null }> =
		[];
	await stubHostedApi(page, {
		deployments: [deployment],
		cloudAgents: [railHostedCloudAgent],
		aiProviders: [provider],
		updateDeploymentRequests: updates,
	});
	await page.goto(`/agents/${railHostedEnvironmentId}`);
	// Wait for the loaded card, excluding hidden SSR segments and Suspense skeletons.
	const modelProvider = page
		.getByRole("main")
		.getByRole("article")
		.filter({ has: page.getByRole("link", { name: "AI Providers", exact: true }) });
	await expect(modelProvider).toContainText("Managed in agent");
	await page.goto(`/agents/${railHostedEnvironmentId}/model-provider`);
	await expect(page.getByTestId("managed-model-controls")).toHaveCount(0);
	await expect(page.locator("main").getByRole("button", { name: "Save changes" })).toBeDisabled();
	expect(updates).toEqual([]);
});

test("Clawdi AI model selection saves the chosen managed model", async ({ page }, testInfo) => {
	const updateDeploymentRequests: Array<{
		body: string;
		idempotencyKey: string | null;
		ifMatch: string | null;
	}> = [];
	await stubHostedApi(page, {
		deployments: [railHostedDeployment],
		cloudAgents: [railHostedCloudAgent],
		updateDeploymentRequests,
	});
	await page.goto(`/agents/${railHostedEnvironmentId}/model-provider`);
	await page
		.getByTestId("provider-choice-grid")
		.getByRole("button", { name: /^Clawdi AI/ })
		.click();
	const models = page.getByTestId("managed-model-controls");
	await expect(models.getByRole("button", { name: /^GPT-5.6 Luna/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await models.getByRole("combobox", { name: "More managed models" }).click();
	await page.getByRole("option", { name: /GPT-5.6 Sol/ }).click();
	await expect(models.getByRole("combobox")).toContainText("GPT-5.6 Sol");
	await expect(page.getByText("Add, validate, or remove providers on")).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath("managed-model-picker.png") });
	await page.locator("main").getByRole("button", { name: "Save changes" }).click();
	await expect.poll(() => updateDeploymentRequests.length).toBe(1);
	expect(JSON.parse(updateDeploymentRequests[0]?.body ?? "{}")).toMatchObject({
		ai_provider_auth_kind: "managed",
		primary_model: { provider_id: "clawdi", model: "gpt-5.6-sol" },
	});
});

test("provider conflict notice keeps the agent's own settings through the canonical update", async ({
	page,
}, testInfo) => {
	const providerId = "custom-openrouter";
	const deployment: DeploymentMutationFixture = {
		...railHostedDeployment,
		hermes_control_ui_url: "https://runtime.example/",
		serving_advisory: "ProviderConflict",
		provider_conflicts: [nativeProviderConflict("hermes", providerId, "native_provider_exists")],
		config_info: {
			...railHostedDeployment.config_info,
			ai_provider_auth_kind: "api_key",
			runtime_configuration: {
				providers: [{ provider_id: providerId, auth_kind: "secret_reference", models: ["m-1"] }],
				primary_model: { provider_id: providerId, model: "m-1" },
				features: [],
			},
		},
	};
	const updateDeploymentRequests: Array<{
		body: string;
		idempotencyKey: string | null;
		ifMatch: string | null;
	}> = [];
	await stubHostedApi(page, {
		deployments: [deployment],
		cloudAgents: [railHostedCloudAgent],
		aiProviders: [userProvider(providerId, "OpenRouter", [{ id: "m-1" }])],
		updateDeploymentRequests,
	});

	// The advisory never reads as a failure: the agent is running.
	await page.goto(`/agents/${railHostedEnvironmentId}`);
	const computeStatus = page
		.locator("main")
		.locator('[data-overview-status="compute"] [data-overview-compute-status]');
	await expect(computeStatus).toHaveText("Running");
	// A provider conflict leaves the dashboard available.
	await expect(page.getByRole("link", { name: "Chat on the web", exact: true })).toBeVisible();

	await page.goto(`/agents/${railHostedEnvironmentId}/model-provider`);
	const notice = page.locator(`[data-provider-conflict="${providerId}"]`);
	await expect(notice).toContainText("OpenRouter isn’t applied");
	await expect(notice).toContainText(
		"The agent’s own Hermes settings already set up this provider, so Clawdi kept them. Nothing was changed.",
	);
	await expect(notice).toContainText(
		"To let Clawdi manage it instead, remove it from the agent’s Hermes settings. Clawdi applies it within about 5 minutes.",
	);
	await page.screenshot({ path: testInfo.outputPath("provider-conflict-notice.png") });
	await notice.getByRole("button", { name: "Keep the agent’s own settings" }).click();
	await expect.poll(() => updateDeploymentRequests.length).toBe(1);
	expect(updateDeploymentRequests[0]?.idempotencyKey).toMatch(/^deployment-update-/);
	expect(JSON.parse(updateDeploymentRequests[0]?.body ?? "{}")).toEqual({
		ai_provider_auth_kind: "unmanaged",
		ai_provider_id: null,
		provider_ids: [],
		primary_model: null,
		ai_provider_bootstrap: null,
	});
});

test("switching to an agent-owned provider explains that the model is chosen in the agent", async ({
	page,
}) => {
	const current = {
		...userProvider("custom-current", "Current", [{ id: "m-1" }]),
		configuration_mode: "custom" as const,
	};
	const next = {
		...userProvider("custom-next", "Next Provider", [{ id: "m-2" }]),
		configuration_mode: "custom" as const,
	};
	await stubHostedApi(page, {
		deployments: [
			{
				...railHostedDeployment,
				config_info: {
					...railHostedDeployment.config_info,
					ai_provider_auth_kind: "api_key",
					runtime_configuration: {
						providers: [{ provider_id: current.provider_id, auth_kind: "secret_reference" }],
						primary_model: null,
						features: [],
					},
				},
			},
		],
		cloudAgents: [railHostedCloudAgent],
		aiProviders: [current, next],
	});

	await page.goto(`/agents/${railHostedEnvironmentId}/model-provider`);
	const hint = page.getByText("The agent keeps its current model.");
	await expect(hint).toHaveCount(0);
	await page.getByRole("button", { name: /Next Provider/ }).click();
	await expect(hint).toContainText(
		"choose a model from Next Provider in the agent's own settings.",
	);
	await page.getByRole("button", { name: /Current/ }).click();
	await expect(hint).toHaveCount(0);
});

test("a withdrawn dashboard is explained while the agent keeps running", async ({
	page,
}, testInfo) => {
	await stubHostedApi(page, {
		deployments: [
			{
				...railHostedDeployment,
				hermes_control_ui_url: "https://runtime.example/",
				serving_advisory: "RuntimeUiUnavailable",
			},
		],
		cloudAgents: [railHostedCloudAgent],
	});
	let runtimeDocuments = 0;
	await page.route("https://runtime.example/**", (route) => {
		runtimeDocuments += 1;
		return route.abort();
	});

	await page.goto(`/agents/${railHostedEnvironmentId}`);
	const main = page.locator("main");
	await expect(
		main.locator('[data-overview-status="compute"] [data-overview-compute-status]'),
	).toHaveText("Running");
	const dashboard = main.getByRole("button", { name: "Chat on the web", exact: true });
	await expect(dashboard).toBeDisabled();
	await expect(dashboard).toContainText(
		"Hermes Dashboard is unavailable. Your agent keeps running.",
	);

	await page.goto(`/agents/${railHostedEnvironmentId}/console`);
	await expect(main.getByText("Hermes Dashboard is unavailable", { exact: true })).toBeVisible();
	await expect(
		main.getByText("Your agent keeps running. Chat with it through channels, or use Terminal.", {
			exact: true,
		}),
	).toBeVisible();
	// Chat and Terminal stay available as the way to reach the running agent.
	await expect(main.getByRole("button", { name: "Open channels" })).toHaveAttribute(
		"href",
		`/agents/${railHostedEnvironmentId}/channel-links`,
	);
	await expect(main.getByRole("button", { name: "Use Terminal" })).toHaveAttribute(
		"href",
		`/agents/${railHostedEnvironmentId}/terminal`,
	);
	await expect(page.locator("iframe")).toHaveCount(0);
	expect(runtimeDocuments).toBe(0);
	await page.screenshot({ path: testInfo.outputPath("runtime-ui-withdrawn.png") });
});

for (const kind of ["native", "custom"] as const) {
	test(`${kind} provider creation stays in context and binds without choosing a model`, async ({
		page,
	}) => {
		const providerAcceptRequests: string[] = [];
		const updateDeploymentRequests: Array<{
			body: string;
			idempotencyKey: string | null;
			ifMatch: string | null;
		}> = [];
		const providerId = kind === "native" ? "openai" : "custom-gateway";
		const providerName = kind === "native" ? "OpenAI" : "Custom gateway";
		const createdProvider: AiProvider = {
			...userProvider(providerId, providerName, []),
			configuration_mode: kind,
			native_provider: kind === "native" ? "openai" : null,
			models: null,
			api_mode: kind === "native" ? "openai_responses" : "openai_chat",
			type: kind === "native" ? "openai" : "custom_openai_compatible",
			base_url: kind === "native" ? "https://api.openai.com/v1" : "https://custom.example/v1",
			runtime_env_name: "OPENAI_API_KEY",
		};
		await stubHostedApi(page, {
			deployments: [railHostedDeployment],
			cloudAgents: [railHostedCloudAgent],
			providerAcceptRequests,
			providerAcceptResponses: [
				{ status: 200, body: { status: "ready", provider: createdProvider } },
			],
			updateDeploymentRequests,
		});
		const agentPath = `/agents/${railHostedEnvironmentId}/model-provider`;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await page.goto(agentPath);
			try {
				await expect(page.getByRole("heading", { name: "AI Providers" })).toBeVisible();
				break;
			} catch (error) {
				if (attempt === 1) throw error;
			}
		}
		const agentPageUrl = page.url();

		await page.getByRole("button", { name: /Add a provider/ }).click();
		expect(page.url()).toBe(agentPageUrl);
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog).toHaveAccessibleName("Add a provider");
		await dialog
			.getByRole("button", { name: kind === "native" ? /^OpenAI/ : /^Custom endpoint/ })
			.click();
		if (kind === "native")
			await dialog.getByRole("button", { name: "OpenAI API", exact: true }).click();
		if (kind === "custom") {
			await dialog.getByLabel("Name", { exact: true }).fill(providerName);
			await dialog.getByLabel("Endpoint").fill("https://custom.example/v1");
		}
		await dialog.getByRole("textbox", { name: "API key" }).fill("sk-e2e-agent-provider");
		await dialog.getByRole("button", { name: "Add provider", exact: true }).click();

		await expect(dialog).toBeHidden();
		await expect.poll(() => providerAcceptRequests.length).toBe(1);
		const saved = JSON.parse(providerAcceptRequests[0] ?? "{}").provider;
		expect(saved).toMatchObject({ configuration_mode: kind, label: providerName });
		expect(saved).not.toHaveProperty("models");
		expect(page.url()).toBe(agentPageUrl);
		const providerCard = page
			.getByTestId("provider-choice-grid")
			.getByRole("button", { pressed: true })
			.filter({ hasText: providerName });
		await expect(providerCard).toHaveAttribute("aria-pressed", "true");
		const mainModel = page.getByRole("combobox", { name: "Main model" });
		await expect(mainModel).toHaveCount(0);
		await expect(page.getByText("Add, validate, or remove providers on")).toHaveCount(0);
		await expect(page.getByTestId("managed-model-controls")).toHaveCount(0);
		expect(updateDeploymentRequests).toEqual([]);
		await page.locator("main").getByRole("button", { name: "Save changes" }).click();
		await expect.poll(() => updateDeploymentRequests.length).toBe(1);
		expect(JSON.parse(updateDeploymentRequests[0]?.body ?? "{}")).toMatchObject({
			ai_provider_auth_kind: "api_key",
			ai_provider_id: providerId,
			provider_ids: [providerId],
			primary_model: null,
		});
	});
}

test("hosted live-tool routes keep scrolling inside their viewport", async ({ page }) => {
	let releaseDeploymentList: (() => void) | undefined;
	const deploymentListGate = new Promise<void>((resolve) => {
		releaseDeploymentList = resolve;
	});
	const liveToolDeployment = {
		...mutationDeploymentReadFixture(railHostedDeployment),
		files_endpoint: { url: "https://files.example.test/" },
	};
	await stubHostedApi(page, {
		cloudAgents: [railHostedCloudAgent],
		deployments: [liveToolDeployment],
		deploymentListResponses: [[liveToolDeployment]],
		deploymentListResponseGates: [deploymentListGate],
	});

	try {
		await page.goto(`/agents/${railHostedEnvironmentId}/console`);
		const loadingShell = page.getByTestId("agent-live-tool-loading-shell");
		await expect(loadingShell).toBeVisible();
		await expect(page.getByTestId("overview-status-card-skeleton")).toHaveCount(0);
		await expectLiveToolFillsDashboard(page, loadingShell);
		const loadingBox = await loadingShell.boundingBox();
		if (!loadingBox) throw new Error("Live-tool loading shell should have stable geometry.");

		releaseDeploymentList?.();
		const liveSurface = page.getByTestId("hosted-agent-live-surface");
		await expect(liveSurface).toBeVisible();
		const liveBox = await liveSurface.boundingBox();
		if (!liveBox) throw new Error("Hosted live-tool surface should have stable geometry.");
		expect(Math.abs(liveBox.x - loadingBox.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(liveBox.width - loadingBox.width)).toBeLessThanOrEqual(1);
		expect(Math.abs(liveBox.height - loadingBox.height)).toBeLessThanOrEqual(1);
		await expectLiveToolFillsDashboard(page, liveSurface);

		await page.setViewportSize({ width: 390, height: 844 });
		await expectLiveToolFillsDashboard(page, liveSurface);

		for (const section of ["files", "terminal"] as const) {
			await page.goto(`/agents/${railHostedEnvironmentId}/${section}`);
			const routeSurface = page.getByTestId("hosted-agent-live-surface");
			await expect(routeSurface).toBeVisible();
			await expectLiveToolFillsDashboard(page, routeSurface);
		}
	} finally {
		releaseDeploymentList?.();
	}
});

test("hosted terminal opens a standalone fitted window", async ({ page, context }) => {
	const liveToolDeployment = mutationDeploymentReadFixture(railHostedDeployment);
	await stubHostedApi(page, {
		cloudAgents: [railHostedCloudAgent],
		deployments: [liveToolDeployment],
		deploymentListResponses: [[liveToolDeployment]],
	});
	const terminalPath = `/agents/${railHostedEnvironmentId}/terminal`;
	const terminalWindowPath = `/terminal/${railHostedEnvironmentId}`;

	await page.goto(terminalPath);
	const openButton = page.getByRole("button", { name: "Open Terminal in new window" });
	await expect(openButton).toContainText("Open in new window");
	const popupPromise = context.waitForEvent("page");
	await openButton.click();
	const popup = await popupPromise;
	await expect(popup).toHaveURL(terminalWindowPath);
	await popup.close();

	for (const viewportSize of [
		{ width: 1440, height: 900 },
		{ width: 390, height: 844 },
	] as const) {
		await page.setViewportSize(viewportSize);
		await page.goto(terminalPath);
		const terminal = page.locator(".hosted-terminal");
		await expect(terminal.locator(".xterm-screen")).toBeVisible();
		await expect(page.getByRole("button", { name: "Retry terminal" })).toBeEnabled();
		await expectTerminalFitsHost(terminal);

		await page.goto(terminalWindowPath);
		const standaloneSurface = page.getByTestId("hosted-agent-live-surface");
		const standaloneTerminal = standaloneSurface.locator(".hosted-terminal");
		await expect(standaloneTerminal.locator(".xterm-screen")).toBeVisible();
		await expect(page.getByRole("button", { name: "Open Terminal in new window" })).toHaveCount(0);
		await expect(page.getByTestId("app-sidebar")).toHaveCount(0);
		await expect(page.getByTestId("dashboard-page-content")).toHaveCount(0);
		const standaloneGeometry = await standaloneSurface.evaluate((surface) => ({
			surface: surface.getBoundingClientRect().toJSON(),
			viewport: { width: window.innerWidth, height: window.innerHeight },
			body: { clientHeight: document.body.clientHeight, scrollHeight: document.body.scrollHeight },
			document: {
				clientHeight: document.documentElement.clientHeight,
				scrollHeight: document.documentElement.scrollHeight,
			},
		}));
		expect(Math.abs(standaloneGeometry.surface.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(standaloneGeometry.surface.y)).toBeLessThanOrEqual(1);
		expect(
			Math.abs(standaloneGeometry.surface.width - standaloneGeometry.viewport.width),
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(standaloneGeometry.surface.height - standaloneGeometry.viewport.height),
		).toBeLessThanOrEqual(1);
		expect(standaloneGeometry.body.scrollHeight).toBeLessThanOrEqual(
			standaloneGeometry.body.clientHeight + 1,
		);
		expect(standaloneGeometry.document.scrollHeight).toBeLessThanOrEqual(
			standaloneGeometry.document.clientHeight + 1,
		);
		await expectTerminalFitsHost(standaloneTerminal);
	}
});

for (const runtime of ["hermes", "openclaw"] as const) {
	test(`${runtime} overview entries preserve navigation and layout`, async ({ page, context }) => {
		const label = runtime === "hermes" ? "Hermes Dashboard" : "OpenClaw Control UI";
		const endpoint = "https://runtime.example/";
		const deployment = {
			...railHostedDeployment,
			hermes_control_ui_url: endpoint,
			openclaw_control_ui_url: endpoint,
			config_info: { ...railHostedDeployment.config_info, runtime },
		};
		const credentialRequests: string[] = [];
		const sessionsPage = hostedOverviewSessionsPage(3, runtime);
		await stubHostedApi(page, {
			deployments: [deployment],
			cloudAgents: [{ ...railHostedCloudAgent, agent_type: runtime }],
			plans: [basicPlan, performancePlan],
			agentResourceFixtures: true,
			sessionsPage,
			runtimeUiRedemptionRequests: credentialRequests,
			runtimeUiRedemptionResponses: Array.from({ length: runtime === "openclaw" ? 6 : 1 }, () => ({
				status: 200,
				body: {
					runtime,
					url: endpoint,
					deployment_resource_version: `rv_${deployment.id}`,
					...(runtime === "hermes"
						? {
								auth_mode: "oidc",
								browser_session_url:
									"https://api.example.test/v2/deployments/hdep_fixture/hermes-oidc/session",
								access_revision: 1,
							}
						: {
								auth_mode: "openclaw_token",
								token: "test-token",
								handoff_url: `${endpoint}#token=test-token`,
							}),
				},
			})),
		});
		await context.route("https://runtime.example/**", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><title>Runtime</title><main>Runtime dashboard</main>",
			}),
		);
		for (const { sessionCount, ...viewport } of [
			{ width: 1440, height: 900, sessionCount: 0 },
			{ width: 1440, height: 900, sessionCount: 1 },
			{ width: 1440, height: 900, sessionCount: 3 },
			{ width: 390, height: 844, sessionCount: 3 },
			{ width: 320, height: 800, sessionCount: 3 },
		]) {
			Object.assign(sessionsPage, hostedOverviewSessionsPage(sessionCount, runtime));
			await page.setViewportSize(viewport);
			await page.goto(`/agents/${railHostedEnvironmentId}`);
			const module = page.locator('[data-overview-module="dashboard"]');
			const open = page.getByRole("link", { name: "Chat on the web", exact: true });
			await expect(open).toHaveCount(1);
			await expect(open).toBeEnabled();
			await expect(open.getByText(label, { exact: true })).toBeVisible();
			await expect(module.getByRole("link")).toHaveCount(1);
			await expect(module.locator('[role="status"], #agent-dashboard-status')).toHaveCount(0);
			await expectContainedInOwnerAndViewport(page, open, module, "Dashboard action");
			await expectNoHorizontalOverflow(module, "Dashboard module");
			await expectNoHorizontalOverflow(
				open.locator('[data-slot="card-description"]'),
				"Dashboard subtitle",
			);
			const entry = page.locator('[data-overview-section="entry"]');
			const channels = page.locator('[data-overview-module="channels"]');
			await expect(channels).toContainText("Telegram, Discord, or WhatsApp");
			await expect(entry.locator('[data-overview-status="compute"]')).toBeVisible();
			const compute = entry.locator('[data-overview-status="compute"]');
			await expect(compute.getByRole("button", { name: "Upgrade", exact: true })).toBeVisible();
			await expect(compute.locator('[data-slot="card-content"]')).toContainText("Basic plan");
			await expect(compute.locator("a a, a button, button a")).toHaveCount(0);
			const sessionGrid = page.getByTestId("overview-session-grid");
			await expect(sessionGrid.getByRole("article")).toHaveCount(sessionCount);
			const placeholders = sessionGrid.getByTestId("overview-session-placeholder");
			await expect(placeholders).toHaveCount(3 - sessionCount);
			await expect(placeholders.locator("a, button, [tabindex]")).toHaveCount(0);
			if (sessionCount === 0) {
				await expect(placeholders.first()).toHaveText("No sessions from this agent yet.");
			} else {
				await expect(sessionGrid).not.toContainText("No sessions from this agent yet.");
			}
			await expectNoHorizontalOverflow(page.locator("main"), "Overview");
		}
		await page
			.locator('[data-overview-module="channels"]')
			.getByRole("link", { name: "Chat via channels", exact: true })
			.click();
		await expect(page).toHaveURL(`/agents/${railHostedEnvironmentId}/channel-links`);
		await page.goto(`/agents/${railHostedEnvironmentId}`);
		await page.getByRole("link", { name: "Chat on the web", exact: true }).click();
		await expect(page).toHaveURL(`/agents/${railHostedEnvironmentId}/console`);
		await expect(page.locator('[data-slot="breadcrumb-page"]').last()).toHaveText(label);
		const target = runtime === "hermes" ? `${endpoint}chat` : `${endpoint}#token=test-token`;
		await expect(page.locator(`iframe[title="${label}"]`)).toHaveAttribute("src", target);
		if (runtime === "hermes") {
			const frame = await page.locator('iframe[title="Hermes Dashboard"]').elementHandle();
			if (!frame) throw new Error("Hermes Dashboard should already be mounted.");
			await page.getByRole("button", { name: "Access Hermes Dashboard", exact: true }).click();
			await expect(page.getByRole("dialog").getByText("admin", { exact: true })).toBeVisible();
			expect(await frame.evaluate((element) => element.isConnected)).toBe(true);
			await frame.dispose();
		}
		expect(credentialRequests).toHaveLength(runtime === "openclaw" ? 6 : 1);
		const popupPromise = context.waitForEvent("page");
		await page
			.getByRole("button", { name: `Open ${label} in new window`, exact: true })
			.last()
			.click();
		const popup = await popupPromise;
		await expect(popup).toHaveURL(target);
		await popup.close();
	});
}

test("accepted detail delete dismisses immediately while teardown finishes in the background", async ({
	page,
}) => {
	const deleteRequestBodies: string[] = [];
	const deleteRequests: string[] = [];
	const deploymentListRequests: string[] = [];
	const completedDeleteIds = new Set<string>();
	await stubHostedApi(page, {
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
		completedDeleteIds,
		deleteRequestBodies,
		deleteRequests,
		deploymentListRequests,
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(includedBasicDeployment), "Basic");
	const historyLengthBeforeDelete = await page.evaluate(() => window.history.length);
	await page.evaluate(() => {
		document.documentElement.dataset.deleteNotFoundFlash = "false";
		const observer = new MutationObserver(() => {
			if (document.body.textContent?.includes("Agent not found")) {
				document.documentElement.dataset.deleteNotFoundFlash = "true";
			}
			if (window.location.pathname === "/") observer.disconnect();
		});
		observer.observe(document.body, { childList: true, subtree: true });
	});

	await page.locator("main").getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete agent", exact: true })
		.click();

	await expect.poll(() => deleteRequests).toEqual(["/v2/deployments/hdep_included"]);
	await expect
		.poll(() => deleteRequestBodies.map((body) => JSON.parse(body)))
		.toEqual([{ subscription_choice: "cancel_subscription" }]);
	await expect.poll(() => new URL(page.url()).pathname).toBe("/");
	await expect
		.poll(() => page.evaluate(() => window.history.length))
		.toBe(historyLengthBeforeDelete);
	await expect(page.locator("html")).toHaveAttribute("data-delete-not-found-flash", "false");
	await expect(page.getByText("Agent removed", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Open Basic", exact: true })).toHaveCount(0);
	await expect(page.getByTestId("app-sidebar-agent-tiles").getByLabel("Basic")).toHaveCount(0);
	// The deployment is still in the stubbed inventory as `deleting`; dismissal
	// therefore precedes teardown rather than waiting for a completed list read.
	expect(completedDeleteIds.has("hdep_included")).toBe(false);

	const readsBeforeCompletion = deploymentListRequests.length;
	completedDeleteIds.add("hdep_included");
	await page.reload();
	await expect.poll(() => deploymentListRequests.length).toBeGreaterThan(readsBeforeCompletion);
	await expect(page.getByRole("link", { name: "Open Basic", exact: true })).toHaveCount(0);
});

test("hosted locale settings submit canonical deployment PATCH", async ({ page }) => {
	const updateDeploymentRequests: Array<{
		body: string;
		idempotencyKey: string | null;
		ifMatch: string | null;
	}> = [];
	await stubHostedApi(page, {
		deployments: [railHostedDeployment],
		cloudAgents: [railHostedCloudAgent],
		plans: [basicPlan],
		updateDeploymentRequests,
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(railHostedDeployment), "Basic");

	const displayName = page.getByRole("textbox", { name: "Agent name" });
	await displayName.fill("Unsaved Cloud name");
	await page.locator("#hosted-agent-language").click();
	await page.getByRole("option", { name: "Español" }).click();
	await page.getByRole("link", { name: "Sessions", exact: true }).click();
	const discardDialog = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
	await expect(discardDialog).toHaveCount(1);
	await discardDialog.getByRole("button", { name: "Keep editing" }).click();
	await expect(displayName).toHaveValue("Unsaved Cloud name");
	await expect(page.locator("#hosted-agent-language")).toContainText("Español");
	await page.locator("main").getByRole("button", { name: "Save changes" }).click();
	await expect.poll(() => updateDeploymentRequests.length).toBe(1);

	expect(updateDeploymentRequests[0]?.idempotencyKey).toMatch(/^deployment-update-/);
	expect(updateDeploymentRequests[0]?.ifMatch).toBe('"rv_hdep_rail_cloud"');
	expect(JSON.parse(updateDeploymentRequests[0]?.body ?? "{}")).toMatchObject({
		language: "es",
	});
});

test("env-keyed failed overview is action-free while Settings keeps management", async ({
	page,
}) => {
	const restartRequests: string[] = [];
	const deleteRequests: string[] = [];
	const failedRestartRead = mutationDeploymentReadFixture(failedMissingProjectionDeployment);
	failedRestartRead.accepted_operation = completedDeploymentOperation(
		failedMissingProjectionDeployment,
		"restart",
	);
	const runtimeFailure = failedRestartRead.resource.status?.failure;
	if (!runtimeFailure) throw new Error("Expected runtime failure fixture");
	runtimeFailure.phase = "reconcile";
	runtimeFailure.detail = "runtime apply failed: internal dashboard prerequisite output";
	runtimeFailure.conditionMessage = "internal runtime health error";
	await stubHostedApi(page, {
		deployments: [failedMissingProjectionDeployment],
		deploymentListResponses: [[failedRestartRead]],
		plans: [basicPlan, performancePlan],
		cloudAgentNotFoundIds: [missingProjectionEnvironmentId],
		restartRequests,
		deleteRequests,
	});

	await page.goto(`/agents/${missingProjectionEnvironmentId}`);
	const main = page.locator("main");
	await expect.poll(() => new URL(page.url()).search).toBe("");
	// The overview renders from deployment authority even while the agent
	// projection 404s; internal failure details never reach the page.
	await expect(main.getByText("Recent sessions", { exact: true })).toBeVisible();
	await expect(main.getByText(missingProjectionFailureReason, { exact: true })).toHaveCount(0);
	await expect(
		main.getByText("Clawdi is checking this agent.", {
			exact: true,
		}),
	).toHaveCount(0);
	await expect(main.getByText("Agent temporarily unavailable", { exact: true })).toHaveCount(0);
	await expect(main.getByText("Agent restart failed", { exact: true })).toHaveCount(0);
	await expect(main.getByText("internal runtime health error", { exact: true })).toHaveCount(0);
	await expect(main.getByText(/dashboard prerequisite/i)).toHaveCount(0);
	const compute = main.locator('[data-overview-status="compute"]');
	await expect(main.getByRole("button", { name: "Chat on the web", exact: true })).toBeDisabled();
	const computeStatus = compute.locator("[data-overview-compute-status]");
	await expect(computeStatus).toHaveText("Temporarily unavailable");
	await expect(computeStatus.locator('[data-slot="status-dot"]')).toHaveAttribute(
		"data-status",
		"warning",
	);
	await expect(compute.getByText("Failed", { exact: true })).toHaveCount(0);
	const sidebarStatus = page.getByTestId("app-sidebar-agent-status");
	await expect(sidebarStatus).toContainText("Temporarily unavailable");
	await expect(sidebarStatus.getByText("Failed", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("alert")).toHaveCount(0);
	await expect(main.getByText("Basic plan", { exact: true })).toBeVisible();
	for (const action of ["Retry startup", "Retry restart", "Start", "Restart", "Delete"])
		await expect(compute.getByRole("button", { name: action, exact: true })).toHaveCount(0);
	await expect(compute.getByRole("button")).toHaveCount(0);
	const computeSettingsLink = compute.getByRole("link", { name: "Compute", exact: true });
	await expect(computeSettingsLink).toHaveAttribute("href", /\/settings/);
	await expect(compute.locator("a a, a button, button a")).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Terminal", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Hermes Dashboard", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Sessions", exact: true })).toBeVisible();

	expect(restartRequests).toEqual([]);
	await page.setViewportSize({ width: 1280, height: 1400 });

	await computeSettingsLink.click();
	await expect(page).toHaveURL(/\/settings/);
	await expect(
		main.getByText("Clawdi is checking this agent.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(main.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
	await main.getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete agent", exact: true })
		.click();
	await expect.poll(() => deleteRequests).toEqual(["/v2/deployments/hdep_failed_projection"]);
});
