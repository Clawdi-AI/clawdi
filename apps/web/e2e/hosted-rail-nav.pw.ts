import { expect, test } from "@playwright/test";
import { mutationDeploymentReadFixture } from "./hosted-stub-api";
import { measureNavigation } from "./navigation-measurement";

import {
	basicPlan,
	CLOUD_API,
	completedDeploymentOperation,
	expectContainedInOwnerAndViewport,
	expectNoHorizontalOverflow,
	hostedOverviewSessionsPage,
	performancePlan,
	railConnectedCloudAgent,
	railConnectedEnvironmentId,
	railHostedCloudAgent,
	railHostedDeployment,
	railHostedEnvironmentId,
	sharedLegacyCloudAgent,
	sharedLegacyEnvironmentId,
	stubHostedApi,
} from "./support/hosted-api-stub";

test("navigation timing preserves the outgoing iframe geometry", async ({
	page,
	context,
}, testInfo) => {
	await stubHostedApi(page, {
		deployments: [
			{
				...mutationDeploymentReadFixture({
					...railHostedDeployment,
					hermes_control_ui_url: "https://runtime.example/",
				}),
				files_endpoint: { url: "https://files.example.test/" },
			},
		],
		cloudAgents: [railHostedCloudAgent],
		plans: [basicPlan, performancePlan],
		agentResourceFixtures: true,
		sessionsPage: hostedOverviewSessionsPage(3),
	});
	let runtimeDocuments = 0;
	await context.route("https://runtime.example/**", (route) => {
		if (route.request().resourceType() === "document") runtimeDocuments += 1;
		return route.fulfill({
			contentType: "text/html",
			body: '<!doctype html><style>body{margin:0;background:#fafafa;color:#222;font:16px system-ui}header{background:#eceef0;padding:20px}main{padding:24px}textarea{width:80%;height:100px}</style><header>Runtime dashboard</header><main><h1>Chat</h1><textarea aria-label="Message">Retained conversation</textarea></main>',
		});
	});
	await context.route("https://files.example.test/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			headers: {
				"access-control-allow-origin": "http://127.0.0.1:3100",
				"access-control-allow-credentials": "true",
				"access-control-allow-headers": "authorization",
			},
			body: "<!doctype html><style>body{background:#fff;color:#222;font:16px system-ui}</style><h1>Workspace files</h1><p>notes.txt</p>",
		}),
	);
	let slow = false;
	let apiDelay = 300;
	await page.route("**/*", async (route) => {
		const request = route.request();
		if (slow && ["script", "fetch", "xhr"].includes(request.resourceType())) {
			await new Promise((resolve) =>
				setTimeout(resolve, request.resourceType() === "script" ? 400 : apiDelay),
			);
		}
		await route.fallback();
	});
	const results = [];
	for (const [section, destination] of [
		["", '[data-overview-section="tools"]'],
		["sessions", '[data-slot="page-header"] h1'],
		["channel-links", '[data-slot="page-header"] h1'],
		["model-provider", '[data-slot="page-header"] h1'],
		["settings", '[data-slot="page-header"] h1'],
	] as const) {
		for (const temperature of ["cold", "warm"] as const) {
			slow = false;
			if (temperature === "cold") await page.goto(`/agents/${railHostedEnvironmentId}/console`);
			else
				await page
					.getByTestId("app-sidebar")
					.getByRole("link", { name: "Hermes Dashboard", exact: true })
					.click();
			await expect(page.locator("main iframe")).toBeVisible();
			await page.evaluate(() => document.fonts.ready);
			slow = true;
			results.push(
				await measureNavigation(page, testInfo, {
					name: `${section || "overview"}-${temperature}`,
					href: `/agents/${railHostedEnvironmentId}${section ? `/${section}` : ""}`,
					destination,
				}),
			);
		}
	}
	for (const [section, title] of [
		["files", "Files"],
		["console", "Hermes Dashboard"],
	] as const) {
		if (section === "files") {
			slow = false;
			await page
				.getByTestId("app-sidebar")
				.getByRole("link", { name: "Hermes Dashboard", exact: true })
				.click();
			await expect(page.locator("main iframe")).toBeVisible();
		}
		slow = true;
		results.push(
			await measureNavigation(page, testInfo, {
				name: `iframe-to-${section}`,
				href: `/agents/${railHostedEnvironmentId}/${section}`,
				destination: `main iframe[title="${title}"]`,
			}),
		);
	}
	const runtimeFrame = page.frameLocator('iframe[title="Hermes Dashboard"]');
	await runtimeFrame.getByRole("textbox", { name: "Message" }).fill("Unsaved runtime draft");
	await runtimeFrame.locator("body").evaluate(() => history.pushState(null, "", "#retained"));
	const documentsBeforeSettings = runtimeDocuments;
	await page.getByRole("button", { name: /^Wallet balance/ }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(runtimeFrame.getByRole("textbox", { name: "Message" })).toHaveValue(
		"Unsaved runtime draft",
	);
	expect(await runtimeFrame.locator("body").evaluate(() => location.hash)).toBe("#retained");
	expect(runtimeDocuments).toBe(documentsBeforeSettings);
	apiDelay = 1500;
	results.push(
		await measureNavigation(page, testInfo, {
			name: "overview-pending",
			href: `/agents/${railHostedEnvironmentId}`,
			destination: '[data-overview-section="tools"]',
		}),
	);
	await testInfo.attach("navigation-summary", {
		body: JSON.stringify(results, null, 2),
		contentType: "application/json",
	});
});

test("agent navigation retains keyboard focus as inventory resolves", async ({ page }) => {
	await stubHostedApi(page, {
		deployments: [mutationDeploymentReadFixture(railHostedDeployment)],
		cloudAgents: [railHostedCloudAgent],
	});
	let release = () => {};
	const inventory = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`${CLOUD_API}/v1/agents`, async (route) => {
		await inventory;
		await route.fallback();
	});
	try {
		await page.goto(`/agents/${railHostedEnvironmentId}`);
		const sidebar = page.getByTestId("app-sidebar");
		const overview = sidebar.getByRole("link", { name: "Overview", exact: true });
		await expect(sidebar.getByRole("group", { name: "Navigation loading" })).toBeVisible();
		await overview.focus();
		release();
		await expect(sidebar.getByRole("link", { name: "Sessions", exact: true })).toBeVisible();
		await expect(overview).toBeFocused();
	} finally {
		release();
	}
});

test("agent layout does not mount the runtime before its provider is loaded", async ({
	page,
	context,
}) => {
	let release = () => {};
	let requested = false;
	let documents = 0;
	const provider = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(/hosted-agent-event-stream-layout/, async (route) => {
		requested = true;
		await provider;
		await route.fallback();
	});
	await stubHostedApi(page, {
		deployments: [{ ...railHostedDeployment, hermes_control_ui_url: "https://runtime.example/" }],
		cloudAgents: [railHostedCloudAgent],
	});
	await context.route("https://runtime.example/**", (route) => {
		if (route.request().isNavigationRequest()) documents += 1;
		return route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><p>Runtime document</p>",
		});
	});
	try {
		await page.goto(`/agents/${railHostedEnvironmentId}/console`, {
			waitUntil: "domcontentloaded",
		});
		await expect.poll(() => requested).toBe(true);
		expect(documents).toBe(0);
		release();
		await expect(
			page.frameLocator('iframe[title="Hermes Dashboard"]').getByText("Runtime document"),
		).toBeVisible();
		expect(documents).toBe(1);
	} finally {
		release();
	}
});

test("dismissed hosted agents never reappear as connected during projection cleanup", async ({
	page,
}) => {
	for (const status of ["deleting", "deleted"]) {
		await page.unrouteAll({ behavior: "wait" });
		await stubHostedApi(page, {
			deployments: [{ ...railHostedDeployment, status }],
			cloudAgents: [railHostedCloudAgent],
		});
		await page.goto(`/agents/${railHostedEnvironmentId}`);
		await expect(page).toHaveURL("/");
		await expect(page.locator("[data-overview-status]")).toHaveCount(0);
	}
});

test("agent rail keeps New agent after agents and retains cache after list failure", async ({
	page,
}) => {
	let releaseColdList: (() => void) | undefined;
	let releaseFailedRefetch: (() => void) | undefined;
	const coldListGate = new Promise<void>((resolve) => {
		releaseColdList = resolve;
	});
	const failedRefetchGate = new Promise<void>((resolve) => {
		releaseFailedRefetch = resolve;
	});
	const deploymentListRequests: string[] = [];
	const failedList = { body: { detail: "projection failed" }, status: 500 };
	await stubHostedApi(page, {
		cloudAgents: [railHostedCloudAgent],
		deploymentListRequests,
		deploymentListResponses: [[railHostedDeployment], failedList, failedList, failedList],
		deploymentListResponseGates: [coldListGate, failedRefetchGate],
	});

	try {
		await page.goto("/agents");
		const rail = page.getByTestId("app-sidebar-agent-rail");
		const newAgent = rail.getByRole("button", { name: "New agent" });
		await expect(rail.getByTestId("app-sidebar-agent-tile")).toHaveCount(0);
		await expect(rail.getByRole("button", { name: "e2e-2", exact: true })).toHaveCount(0);

		releaseColdList?.();
		const agentTile = rail.getByTestId("app-sidebar-agent-tile");
		await expect(agentTile).toHaveCount(1);
		await expect(rail.getByTestId("app-sidebar-agent-loading-slot")).toHaveCount(0);
		const agentTileBox = await agentTile.boundingBox();
		const loadedNewAgentBox = await newAgent.boundingBox();
		if (!agentTileBox || !loadedNewAgentBox) {
			throw new Error("Loaded agent rail controls should be visible.");
		}
		expect(loadedNewAgentBox.y).toBeGreaterThan(agentTileBox.y);

		await rail.getByRole("button", { name: "e2e-2", exact: true }).click();
		await expect(page.locator('[data-agent-overview="hosted"]')).toBeVisible();
		const currentTime = await page.evaluate(() => Date.now());
		await page.clock.setFixedTime(currentTime + 31_000);
		await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
		await expect.poll(() => deploymentListRequests.length).toBeGreaterThanOrEqual(2);
		await expect(rail.getByTestId("app-sidebar-agent-tile")).toHaveCount(1);
		await expect(page.locator('[data-agent-overview="hosted"]')).toBeVisible();

		releaseFailedRefetch?.();
		await expect.poll(() => deploymentListRequests.length).toBe(4);
		await expect(rail.getByTestId("app-sidebar-agent-tile")).toHaveCount(1);
		await expect(page.locator('[data-agent-overview="hosted"]')).toBeVisible();
	} finally {
		releaseColdList?.();
		releaseFailedRefetch?.();
	}
});

test("hosted mixed agent rail uses whole semantic buttons for context switching", async ({
	page,
	browser,
	baseURL,
}) => {
	if (!baseURL) throw new Error("Playwright baseURL is required for the hosted rail test.");
	const agentOrderRequests: string[] = [];
	await stubHostedApi(page, {
		agentOrderRequests,
		deployments: [railHostedDeployment],
		cloudAgents: [railHostedCloudAgent, railConnectedCloudAgent, sharedLegacyCloudAgent],
		legacyAgentEnvironmentIds: [sharedLegacyEnvironmentId],
		canUseLegacyHostedDashboard: true,
	});

	await page.goto("/agents");
	const rail = page.getByTestId("app-sidebar-agent-rail");
	const consoleLink = rail.getByRole("link", { name: "Console", exact: true });
	const cloudButton = rail.getByRole("button", { name: "e2e-2", exact: true });
	const connectedButton = rail.getByRole("button", { name: /Rail Connected/ });

	await expect(consoleLink).toHaveAttribute("href", "/");
	await expect(cloudButton).toHaveAttribute("type", "button");
	await expect(connectedButton).toHaveAttribute("type", "button");
	await expect(rail.getByRole("button", { name: /^Reorder / })).toHaveCount(0);
	await expect(rail.getByTitle(/^Reorder /)).toHaveCount(0);
	const cloudMarker = rail.locator('[data-agent-rail-corner-marker="cloud"]');
	const legacyMarker = rail.locator('[data-agent-rail-corner-marker="legacy"]');
	await expect(cloudMarker).toHaveCount(1);
	await expect(legacyMarker).toHaveCount(1);
	const connectedTileBox = await rail
		.getByTestId("app-sidebar-agent-tile")
		.filter({ hasText: "Rail Connected" })
		.boundingBox();
	const connectedButtonBox = await connectedButton.boundingBox();
	if (!connectedTileBox || !connectedButtonBox) {
		throw new Error("Hosted rail agent tile should be a whole interactive button.");
	}
	expect(connectedButtonBox.x).toBeCloseTo(connectedTileBox.x, 0);
	expect(connectedButtonBox.y).toBeCloseTo(connectedTileBox.y, 0);
	expect(connectedButtonBox.height).toBeCloseTo(connectedTileBox.height, 0);
	expect(connectedButtonBox.width).toBeCloseTo(connectedTileBox.width, 0);

	await consoleLink.click();
	await expect(page).toHaveURL("/");
	await cloudButton.click();
	await expect(page).toHaveURL(`/agents/${railHostedEnvironmentId}`);
	await connectedButton.click();
	await expect(page).toHaveURL(`/agents/${railConnectedEnvironmentId}`);
	await consoleLink.click();
	await expect(page).toHaveURL("/");

	await page.goto("/");
	await connectedButton.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(`/agents/${railConnectedEnvironmentId}`);

	const touchContext = await browser.newContext({
		baseURL,
		hasTouch: true,
		viewport: { width: 1280, height: 720 },
	});
	const touchPage = await touchContext.newPage();
	const touchOrderRequests: string[] = [];
	try {
		await stubHostedApi(touchPage, {
			agentOrderRequests: touchOrderRequests,
			deployments: [railHostedDeployment],
			cloudAgents: [railHostedCloudAgent, railConnectedCloudAgent],
		});
		await touchPage.goto("/");
		const touchConnectedButton = touchPage
			.getByTestId("app-sidebar-agent-rail")
			.getByRole("button", { name: /Rail Connected/ });
		await touchConnectedButton.tap();
		await expect(touchPage).toHaveURL(`/agents/${railConnectedEnvironmentId}`);
	} finally {
		await touchContext.close();
	}
	expect(agentOrderRequests).toEqual([]);
	expect(touchOrderRequests).toEqual([]);
});

test("Breadcrumbs show the full trail on desktop and only the current page on narrow screens", async ({
	page,
}) => {
	await stubHostedApi(page, {
		agentResourceFixtures: true,
		deployments: [railHostedDeployment],
		cloudAgents: [railHostedCloudAgent],
	});
	const query = "";
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/agents/${railHostedEnvironmentId}/memories${query}`);

	const breadcrumb = page.locator('[data-slot="breadcrumb-list"]');
	await expect(breadcrumb.locator('[data-slot="breadcrumb-item"]:visible')).toHaveText([
		"e2e-2",
		"Memories",
	]);
	await expect(breadcrumb.locator('[data-slot="breadcrumb-separator"]:visible')).toHaveCount(1);

	await page.setViewportSize({ width: 320, height: 568 });
	await expect(breadcrumb.locator('[data-slot="breadcrumb-item"]:visible')).toHaveText([
		"Memories",
	]);
	await expect(breadcrumb.locator('[data-slot="breadcrumb-separator"]:visible')).toHaveCount(0);
	await expectNoHorizontalOverflow(page.locator("header"), "breadcrumb header at 320px");
});

test("Console shows every agent when the fleet exceeds six", async ({ page }) => {
	const agents = Array.from({ length: 8 }, (_, index) => ({
		...railConnectedCloudAgent,
		id: `99999999-9999-4999-8999-${String(index).padStart(12, "0")}`,
		display_name: `Console Agent ${index + 1}`,
		sort_order: index,
	}));
	await stubHostedApi(page, { cloudAgents: agents });
	await page.goto("/");
	const main = page.locator("main");
	for (const agent of agents) {
		await expect(
			main.getByRole("link", { name: `Open ${agent.display_name}.`, exact: false }),
		).toBeVisible();
	}
});

test("Console actions remain reachable on narrow screens", async ({ page }) => {
	await stubHostedApi(page);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/");

	const main = page.locator("main");
	await page.setViewportSize({ width: 320, height: 568 });
	const connectAgent = main.getByRole("button", { name: "Connect your own agent" });
	await expect(connectAgent).toBeVisible();
	await expectContainedInOwnerAndViewport(
		page,
		connectAgent,
		connectAgent.locator(".."),
		"320px onboarding action",
	);
	await expectNoHorizontalOverflow(page.locator("html"), "320px Console document");

	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoHorizontalOverflow(page.locator("html"), "390px Console document");

	await connectAgent.click();
	const dialog = page.getByRole("dialog", { name: "Add an agent" });
	await expect(dialog.getByRole("tab", { name: "Ask your agent", exact: true })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(dialog.getByRole("tabpanel")).toContainText("/skill.md");
	await dialog.getByRole("tab", { name: "Run commands", exact: true }).click();
	await expect(dialog.getByRole("tabpanel")).toContainText("clawdi setup");
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();

	const connectors = main.getByRole("link", { name: /^Connectors/ });
	await connectors.focus();
	await page.keyboard.press("Tab");
	await expect(main.getByRole("button", { name: "View all" })).toBeFocused();
});

test("first setup disables runtime sections until the agent opens itself", async ({ page }) => {
	const fixture = {
		...railHostedDeployment,
		status: "starting" as const,
		provisioning_path: "warm" as const,
	};
	const deployment = mutationDeploymentReadFixture(fixture);
	deployment.runtime_ui_endpoint = null;
	// A create accepted just now, so the wait is on track rather than delayed.
	const operation = completedDeploymentOperation(fixture, "create");
	const createTime = new Date().toISOString();
	deployment.accepted_operation = {
		...operation,
		done: false,
		response: null,
		metadata: { ...operation.metadata, createTime, updateTime: createTime },
	};
	await stubHostedApi(page, {
		deployments: [deployment],
		cloudAgents: [railHostedCloudAgent],
		agentResourceFixtures: true,
	});

	// A deep link to a runtime section returns to the setup screen.
	await page.goto(`/agents/${railHostedEnvironmentId}/channel-links`);
	// The first agent page load includes the dev server's cold compile.
	await expect(page).toHaveURL(`/agents/${railHostedEnvironmentId}`, { timeout: 30_000 });
	const panel = page.getByTestId("hosted-initial-deployment-panel");
	await expect(panel.getByRole("heading", { name: "Starting your agent" })).toBeVisible();

	const sidebar = page.locator('[data-sidebar="sidebar"]').first();
	for (const section of ["console", "channels", "ai", "sessions", "plugins", "settings"]) {
		await expect(
			sidebar.locator(`[data-sidebar-item-disabled="${section}"] button`),
		).toBeDisabled();
	}
	await expect(sidebar.getByRole("link", { name: "Channels" })).toHaveCount(0);
	await expect(sidebar.getByRole("link", { name: "Overview" })).toBeVisible();
	await expect(sidebar.getByRole("link", { name: "Memories" })).toBeVisible();
	await expect(sidebar.getByRole("link", { name: "Connectors" })).toBeVisible();
	await sidebar.locator('[data-sidebar-item-disabled="channels"]').hover();
	await expect(page.getByText("Available when your agent is ready", { exact: true })).toBeVisible();

	// The real overview waits behind the card in place, so revealing it shifts nothing.
	const preview = page.locator("[data-setup-preview]");
	await expect(preview).toHaveAttribute("inert", "");
	await expect(preview).toHaveAttribute("aria-hidden", "true");
	const overviewBoxes = () =>
		page
			.locator("[data-overview-section], [data-overview-module], [data-overview-status]")
			.evaluateAll((elements) =>
				elements.map((element) => {
					const box = element.getBoundingClientRect();
					const id =
						element.getAttribute("data-overview-module") ??
						element.getAttribute("data-overview-status") ??
						element.getAttribute("data-overview-section");
					return [
						id,
						Math.round(box.x),
						Math.round(box.y),
						Math.round(box.width),
						Math.round(box.height),
					];
				}),
			);
	await page.waitForLoadState("networkidle");
	const previewBoxes = await overviewBoxes();
	expect(previewBoxes.length).toBeGreaterThan(3);

	// A running runtime is not done: setup waits until chat on the web is usable.
	const running = mutationDeploymentReadFixture({
		...fixture,
		status: "running" as const,
		hermes_control_ui_url: "https://runtime.example/",
	});
	// Two inventory reads after the change guarantee the running runtime was observed.
	const inventoryRead = () =>
		page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === "/v2/deployments" &&
				response.request().method() === "GET",
			{ timeout: 20_000 },
		);
	deployment.resource.status = running.resource.status;
	await inventoryRead();
	await inventoryRead();
	await expect(panel.getByRole("heading", { name: "Starting your agent…" })).toBeVisible();
	await expect(panel.getByText("Your agent is ready")).toHaveCount(0);
	await expect(sidebar.locator('[data-sidebar-item-disabled="channels"] button')).toBeDisabled();

	// Once chat is usable, the completed state stays readable before the reveal, and
	// runtime sections stay disabled until the reveal starts.
	deployment.runtime_ui_endpoint = running.runtime_ui_endpoint;
	await expect(panel.getByRole("heading", { name: "Your agent is ready" })).toBeVisible({
		timeout: 20_000,
	});
	await expect(panel.locator(".lucide-check")).toHaveCount(1);
	await expect(sidebar.locator('[data-sidebar-item-disabled="channels"] button')).toBeDisabled();
	await expect(page.locator('[data-setup-overlay="leaving"]')).toHaveCount(1, { timeout: 3_000 });
	await expect(panel).toHaveCount(0, { timeout: 5_000 });
	await expect(page.locator('[data-overview-module="dashboard"] :disabled')).toHaveCount(0);
	await expect(page.locator("[data-setup-preview]")).toHaveCount(0);
	await page.waitForLoadState("networkidle");
	await expect.poll(overviewBoxes).toEqual(previewBoxes);
	await expect(page.getByRole("button", { name: "Open agent" })).toHaveCount(0);
	await expect(page.getByText("Your agent is ready.", { exact: true })).toHaveCount(1);
	await expect(sidebar.locator("[data-sidebar-item-disabled]")).toHaveCount(0);
	await sidebar.getByRole("link", { name: "Channels" }).click();
	await expect(page).toHaveURL(`/agents/${railHostedEnvironmentId}/channel-links`);
});

test("a stuck first setup offers support with its context instead of check and cancel", async ({
	page,
}) => {
	await page.addInitScript(() => {
		const calls: [string, unknown][] = [];
		window.__chatwootCalls = calls;
		const record = (method: string) => (argument?: unknown) => {
			calls.push([method, argument]);
		};
		window.$chatwoot = {
			hasLoaded: true,
			darkMode: "light",
			setColorScheme: () => {},
			setUser: () => {},
			reset: () => {},
			toggleBubbleVisibility: () => {},
			toggle: record("toggle"),
			setConversationCustomAttributes: record("setConversationCustomAttributes"),
			setLabel: record("setLabel"),
		};
	});
	const fixture = {
		...railHostedDeployment,
		status: "starting" as const,
		provisioning_path: "standard" as const,
	};
	const deployment = mutationDeploymentReadFixture(fixture);
	deployment.runtime_ui_endpoint = null;
	// Accepted long enough ago that the wait has escalated to stuck.
	const operation = completedDeploymentOperation(fixture, "create");
	const createTime = new Date(Date.now() - 16 * 60_000).toISOString();
	deployment.accepted_operation = {
		...operation,
		done: false,
		response: null,
		metadata: { ...operation.metadata, createTime, updateTime: createTime },
	};
	await stubHostedApi(page, {
		deployments: [deployment],
		cloudAgents: [railHostedCloudAgent],
		agentResourceFixtures: true,
	});

	await page.goto(`/agents/${railHostedEnvironmentId}`);
	const panel = page.getByTestId("hosted-initial-deployment-panel");
	// The first agent page load includes the dev server's cold compile.
	await expect(panel.getByRole("heading", { name: "Setup appears to be stuck" })).toBeVisible({
		timeout: 30_000,
	});
	await expect(panel.getByRole("button", { name: "Check again" })).toHaveCount(0);
	await expect(panel.getByRole("button", { name: /Cancel/ })).toHaveCount(0);

	await panel.getByRole("button", { name: "Contact support" }).click();
	const calls = await page.evaluate(() => window.__chatwootCalls ?? []);
	const attributes = calls.find(([method]) => method === "setConversationCustomAttributes")?.[1];
	expect(attributes).toMatchObject({
		setup_deployment_id: deployment.resource.id,
		setup_runtime: deployment.resource.spec.runtime,
		setup_provisioning_path: "standard",
		setup_status: "starting",
		setup_state: "stuck",
	});
	expect(attributes).toHaveProperty("setup_elapsed_seconds");
	expect(attributes).toHaveProperty("setup_reported_at");
	expect(calls).toContainEqual(["setLabel", "agent-setup"]);
	// Context is attached before the widget opens.
	const order = calls.map(([method, argument]) =>
		method === "toggle" ? `toggle:${argument}` : method,
	);
	expect(order.indexOf("toggle:open")).toBeGreaterThan(
		order.indexOf("setConversationCustomAttributes"),
	);
	// Setup keeps polling behind the conversation.
	await expect(panel).toBeVisible();
});
