import { expect, test } from "@playwright/test";
import { mutationDeploymentReadFixture } from "./hosted-stub-api";
import { expectRecordedLiveToolGeometry, recordLiveToolGeometry } from "./live-tool-geometry";

import {
	collectBrowserErrors,
	DEPLOY_API,
	expectLiveToolFillsDashboard,
	expectOpenClawWindow,
	openClawRuntimeEndpoint,
	openClawRuntimeToken,
	railHostedDeployment,
	railHostedEnvironmentId,
	stubHostedApi,
	stubOpenClawRuntime,
} from "./support/hosted-api-stub";

test("native OpenClaw windows wait for the handoff iframe load and reuse the clean endpoint", async ({
	page,
	context,
}) => {
	const nativeHandoff = `${openClawRuntimeEndpoint}#bootstrapToken=one-time-token&bootstrapProfile=owner`;
	const runtime = await stubOpenClawRuntime(page, context, nativeHandoff);
	const initialFrame = runtime.pauseNextIframe();

	await page.goto(`/agents/${runtime.agentId}/console`, { waitUntil: "domcontentloaded" });
	await expect.poll(() => runtime.credentialRequests.length).toBe(1);
	await expect.poll(initialFrame.isStarted).toBe(true);
	const openButton = page.getByRole("button", {
		name: "Open OpenClaw Control UI in new window",
	});
	const iframe = page.locator('iframe[title="OpenClaw Control UI"]');
	await expect(openButton).toBeDisabled();
	await expect(openButton).toContainText("Open in new window");
	await expect(page.getByRole("button", { name: "Reconnect" })).toBeEnabled();
	await expect(iframe).toHaveAttribute("src", nativeHandoff);
	expect(runtime.credentialRequests).toHaveLength(1);

	initialFrame.release();
	await expect(openButton).toBeEnabled();
	await expectOpenClawWindow(context, openButton, openClawRuntimeEndpoint);
	expect(runtime.credentialRequests).toHaveLength(1);

	const remountedFrame = runtime.pauseNextIframe();
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect.poll(remountedFrame.isStarted).toBe(true);
	await expect(openButton).toBeDisabled();
	await expect(iframe).toHaveAttribute("src", openClawRuntimeEndpoint);
	expect(runtime.credentialRequests).toHaveLength(1);

	remountedFrame.release();
	await expect(openButton).toBeEnabled();
	await expectOpenClawWindow(context, openButton, openClawRuntimeEndpoint);
	expect(runtime.credentialRequests).toHaveLength(1);
});

test("legacy OpenClaw windows reuse the exact token handoff", async ({ page, context }) => {
	const legacyHandoff = `${openClawRuntimeEndpoint}#token=${openClawRuntimeToken}`;
	const runtime = await stubOpenClawRuntime(page, context, legacyHandoff);
	const frame = runtime.pauseNextIframe();

	await page.goto(`/agents/${runtime.agentId}/console`, { waitUntil: "domcontentloaded" });
	await expect.poll(() => runtime.credentialRequests.length).toBe(1);
	const iframe = page.locator('iframe[title="OpenClaw Control UI"]');
	await expect(iframe).toHaveAttribute("src", legacyHandoff);
	await expect.poll(frame.isStarted).toBe(true);
	const openButton = page.getByRole("button", {
		name: "Open OpenClaw Control UI in new window",
	});
	await expect(openButton).toBeDisabled();
	await expect(openButton).toContainText("Open in new window");
	expect(runtime.credentialRequests).toHaveLength(1);

	frame.release();
	await expect(openButton).toBeEnabled();
	await expectOpenClawWindow(context, openButton, legacyHandoff);
	expect(runtime.credentialRequests).toHaveLength(1);
});

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
]) {
	test(`OpenClaw retains the same background document across sections at ${viewport.width}px`, async ({
		page,
		context,
	}, testInfo) => {
		await recordLiveToolGeometry(page);
		const errors = collectBrowserErrors(page);
		await page.setViewportSize(viewport);
		const nativeHandoff = `${openClawRuntimeEndpoint}#bootstrapToken=one-time-token&bootstrapProfile=owner`;
		const runtime = await stubOpenClawRuntime(page, context, nativeHandoff);
		await page.goto(`/agents/${runtime.agentId}`);
		const iframe = page.locator('iframe[title="OpenClaw Control UI"]');
		await expect(iframe).toHaveAttribute("src", nativeHandoff);
		await expect.poll(runtime.documentLoads).toBe(1);
		await expect(iframe).toBeHidden();
		const consoleHeading = page.getByRole("heading", {
			level: 1,
			name: "OpenClaw Control UI",
			exact: true,
		});
		await expect(consoleHeading).toHaveCount(0);
		expect(await iframe.evaluate((element) => Boolean(element.closest("[inert]")))).toBe(true);
		const original = await iframe.elementHandle();
		if (!original) throw new Error("Background iframe must already exist.");
		const document = await (await original.contentFrame())?.evaluateHandle(() => window.document);
		if (!document) throw new Error("Background document must already exist.");
		// SPA navigation through the product links, including the mobile sidebar.
		const navigate = async (section: string) => {
			if (viewport.width < 768) {
				// Wait for the previous drawer's exit animation and dismissal listeners.
				await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
				await page.getByRole("button", { name: "Toggle Sidebar" }).click();
			}
			const sidebar =
				viewport.width < 768 ? page.getByRole("dialog") : page.getByTestId("app-sidebar");
			await expect(sidebar).toBeVisible();
			await sidebar.locator(`a[href="/agents/${runtime.agentId}${section}"]`).click();
			await expect(page).toHaveURL(`/agents/${runtime.agentId}${section}`);
			if (viewport.width < 768) await expect(sidebar).toBeHidden();
		};
		for (const section of ["/console", "/sessions", "", "/console"]) {
			await navigate(section);
			await expect(iframe).toHaveAttribute("src", nativeHandoff);
			expect(
				await original.evaluate(
					(element) =>
						element === window.document.querySelector('iframe[title="OpenClaw Control UI"]'),
				),
			).toBe(true);
			expect(
				await document.evaluate((originalDocument) => originalDocument === window.document),
			).toBe(true);
			expect(runtime.documentLoads()).toBe(1);
			expect(runtime.credentialRequests).toHaveLength(1);
			if (section === "/console") {
				await expect(consoleHeading).toHaveCount(1);
				await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
				await expect(iframe).toBeVisible();
				await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(1);
				const box = await iframe.boundingBox();
				if (!box) throw new Error("Console iframe must fit the product layout.");
				expect(box.width).toBeGreaterThan(viewport.width < 768 ? 300 : 800);
				expect(box.height).toBeGreaterThan(500);
				expect(box.x).toBeGreaterThanOrEqual(0);
				expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
				expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
			} else {
				await expect(iframe).toBeHidden();
				await expect(consoleHeading).toHaveCount(0);
			}
		}
		await page.screenshot({ path: `test-results/persistent-control-ui-${viewport.width}.png` });
		await page.getByRole("button", { name: "Reconnect", exact: true }).click();
		await expect.poll(() => runtime.credentialRequests.length).toBe(2);
		await expect.poll(runtime.documentLoads).toBe(2);
		expect(await original.evaluate((element) => element.isConnected)).toBe(false);
		await expect(iframe).toBeVisible();
		const replacement = await iframe.elementHandle();
		if (viewport.width < 768) await page.getByRole("button", { name: "Toggle Sidebar" }).click();
		await page.getByRole("link", { name: "Console", exact: true }).click();
		await expect(iframe).toHaveCount(0);
		expect(await replacement?.evaluate((element) => element.isConnected)).toBe(false);
		await expectRecordedLiveToolGeometry(page, testInfo);
		await original.dispose();
		await document.dispose();
		await replacement?.dispose();
		expect(errors).toEqual([]);
	});
}

test("OpenClaw retries a new resource version after a pending 412 without replacing an established document", async ({
	page,
	context,
}) => {
	const deployment = mutationDeploymentReadFixture({
		...railHostedDeployment,
		openclaw_control_ui_url: "https://runtime.example/",
		config_info: { ...railHostedDeployment.config_info, runtime: "openclaw" },
	});
	deployment.resource.metadata.resourceVersion = "rv_initial";
	const requests: Array<string | undefined> = [];
	let documents = 0;
	let release = () => {};
	const firstResponse = new Promise<void>((resolve) => {
		release = resolve;
	});
	await stubHostedApi(page, {
		deployments: [deployment],
		cloudAgentNotFoundIds: [railHostedEnvironmentId],
	});
	await context.route("https://runtime.example/**", (route) => {
		if (route.request().isNavigationRequest()) documents += 1;
		return route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><p>Runtime document</p>",
		});
	});
	await page.route(`${DEPLOY_API}/v2/deployments/*/runtime-ui/credentials`, async (route) => {
		const version = deployment.resource.metadata.resourceVersion;
		requests.push(route.request().headers()["if-match"]);
		const attempt = requests.length;
		expect(requests.at(-1)).toBe(`"${version}"`);
		if (attempt === 1) await firstResponse;
		if (attempt <= 2)
			return route.fulfill({ status: 412, json: { detail: "Resource version changed" } });
		return route.fulfill({
			json: {
				runtime: "openclaw",
				auth_mode: "openclaw_token",
				url: "https://runtime.example/",
				deployment_resource_version: version,
				token: "fixture-token",
				handoff_url: `https://runtime.example/#bootstrapToken=handoff-${attempt}&bootstrapProfile=owner`,
			},
		});
	});
	const updateVersion = async (version: string) => {
		deployment.resource.metadata.resourceVersion = version;
		deployment.resource.name = `Agent ${version}`;
		await page.clock.setFixedTime(await page.evaluate(() => Date.now() + 31_000));
		await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
		// The title confirms React has observed this inventory snapshot, not just its HTTP response.
		await expect(page.locator("main h1")).toHaveText(deployment.resource.name);
	};
	const navigate = (section: string) =>
		page
			.getByTestId("app-sidebar")
			.locator(`a[href="/agents/${railHostedEnvironmentId}${section}"]`)
			.click();
	try {
		await page.goto(`/agents/${railHostedEnvironmentId}`);
		await expect.poll(() => requests.length).toBe(1);
		await updateVersion("rv_pending");
		expect(requests).toEqual(['"rv_initial"']);
		release();
		await expect.poll(() => requests.length).toBe(2);
		await navigate("/console");
		await expect(page.getByText("Clawdi couldn't establish this browser session.")).toBeVisible();
		await navigate("");
		await navigate("/console");
		await expect(page.getByText("Clawdi couldn't establish this browser session.")).toBeVisible();
		expect(requests).toHaveLength(2);
		await navigate("");
		await updateVersion("rv_retry");
		const iframe = page.locator('iframe[title="OpenClaw Control UI"]');
		await expect(iframe).toHaveAttribute(
			"src",
			"https://runtime.example/#bootstrapToken=handoff-3&bootstrapProfile=owner",
		);
		await expect(iframe).toBeHidden();
		await expect.poll(() => documents).toBe(1);
		const original = await iframe.elementHandle();
		if (!original) throw new Error("Expected an established background iframe.");
		const document = await (await original.contentFrame())?.evaluateHandle(() => window.document);
		if (!document) throw new Error("Expected the runtime document.");
		await updateVersion("rv_cosmetic");
		await navigate("/console");
		await expect(iframe).toBeVisible();
		expect(
			await original.evaluate(
				(element) =>
					element === window.document.querySelector('iframe[title="OpenClaw Control UI"]'),
			),
		).toBe(true);
		expect(
			await document.evaluate((originalDocument) => originalDocument === window.document),
		).toBe(true);
		expect(documents).toBe(1);
		expect(requests).toHaveLength(3);
		await page.getByRole("button", { name: "Reconnect", exact: true }).click();
		await expect.poll(() => documents).toBe(2);
		expect(await original.evaluate((element) => element.isConnected)).toBe(false);
		expect(requests).toEqual(['"rv_initial"', '"rv_pending"', '"rv_retry"', '"rv_cosmetic"']);
		await original.dispose();
		await document.dispose();
	} finally {
		release();
	}
});

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
	{ width: 320, height: 568 },
]) {
	for (const direct of [true, false]) {
		test(`OpenClaw fills the viewport with AgentHome pending (${direct ? "direct" : "overview"}, ${viewport.width}px)`, async ({
			page,
			context,
		}, testInfo) => {
			await page.setViewportSize(viewport);
			await recordLiveToolGeometry(page);
			const runtime = await stubOpenClawRuntime(
				page,
				context,
				`${openClawRuntimeEndpoint}#bootstrapToken=one-time-token&bootstrapProfile=owner`,
			);
			let releaseHome = () => {};
			const homeGate = new Promise<void>((resolve) => {
				releaseHome = resolve;
			});
			let homeRequested = false;
			await page.route("**/src/hosted/agents/agent-home.tsx*", async (route) => {
				homeRequested = true;
				await homeGate;
				await route.continue();
			});
			let releaseCredentials = () => {};
			const credentialsGate = new Promise<void>((resolve) => {
				releaseCredentials = resolve;
			});
			await page.route("**/runtime-ui/credentials", async (route) => {
				await credentialsGate;
				await route.fallback();
			});
			try {
				await page.goto(`/agents/${runtime.agentId}${direct ? "/console" : ""}`);
				await expect.poll(() => homeRequested).toBe(true);
				if (!direct) {
					if (viewport.width < 768)
						await page.getByRole("button", { name: "Toggle Sidebar" }).click();
					const sidebar =
						viewport.width < 768 ? page.getByRole("dialog") : page.getByTestId("app-sidebar");
					await sidebar.locator(`a[href="/agents/${runtime.agentId}/console"]`).click();
					await expect(page).toHaveURL(`/agents/${runtime.agentId}/console`);
					if (viewport.width < 768) await expect(sidebar).toBeHidden();
				}
				const surface = page.getByTestId("hosted-agent-live-surface");
				await expect(
					page.getByRole("heading", {
						level: 1,
						name: "OpenClaw Control UI",
						exact: true,
					}),
				).toHaveCount(1);
				await expect(
					surface.getByText("Opening OpenClaw Control UI…", { exact: true }),
				).toBeVisible();
				await testInfo.attach("credentials-pending", {
					body: await page.screenshot(),
					contentType: "image/png",
				});
				releaseCredentials();
				const iframe = page.locator('iframe[title="OpenClaw Control UI"]');
				await expect(iframe).toBeVisible();
				await expect.poll(runtime.documentLoads).toBe(1);
				// The real lazy route remains suspended while its sibling iframe is visible.
				await expect(page.getByTestId("agent-live-tool-loading-shell")).toHaveCount(1);
				await testInfo.attach("agent-home-pending", {
					body: await page.screenshot(),
					contentType: "image/png",
				});
				releaseHome();
				await expect(page.getByTestId("agent-live-tool-loading-shell")).toHaveCount(0);
				await expectLiveToolFillsDashboard(page, surface);
				await testInfo.attach("agent-home-ready", {
					body: await page.screenshot(),
					contentType: "image/png",
				});
				await page.setViewportSize({ width: viewport.height, height: viewport.width });
				await expectLiveToolFillsDashboard(page, surface);
				await page.setViewportSize(viewport);
				await expectLiveToolFillsDashboard(page, surface);
				await expectRecordedLiveToolGeometry(page, testInfo);
			} finally {
				releaseHome();
				releaseCredentials();
			}
		});
	}
}
