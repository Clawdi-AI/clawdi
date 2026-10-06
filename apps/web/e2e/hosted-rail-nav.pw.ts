import { expect, test } from "@playwright/test";
import { mutationDeploymentReadFixture } from "./hosted-stub-api";
import { measureNavigation } from "./navigation-measurement";

import {
	basicPlan,
	CLOUD_API,
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

	const connectors = main.getByRole("link", { name: /^Connectors/ });
	await connectors.focus();
	await page.keyboard.press("Tab");
	await expect(main.getByRole("button", { name: "View all" })).toBeFocused();
});
