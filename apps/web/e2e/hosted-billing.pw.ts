import type { DeploymentRead } from "@clawdi/shared/api";
import { expect, test } from "@playwright/test";
import {
	type DeploymentMutationFixture,
	fixtureAgentId,
	mutationDeploymentReadFixture,
} from "./hosted-stub-api";

import {
	_expectControlsDoNotOverlap,
	_gotoHostedSettingsDialog,
	basicPlan,
	collectBrowserErrors,
	DEPLOY_API,
	expectContainedInOwnerAndViewport,
	expectNoHorizontalOverflow,
	fulfillJson,
	gotoHostedAgentSettings,
	hostedOverviewSessionsPage,
	includedBasicDeployment,
	paidBasicDeployment,
	performancePlan,
	planChangeQuoteResponse,
	planChangeResponse,
	railHostedCloudAgent,
	railHostedDeployment,
	railHostedEnvironmentId,
	stubCompletedStripeCheckout,
	stubHostedApi,
	stubWalletStripeSetup,
	terminalFallbackDeployment,
	walletState,
} from "./support/hosted-api-stub";

test("overview billing facts and shortcuts follow subscription authority", async ({ page }) => {
	await page.clock.setFixedTime(new Date("2026-09-07T12:00:00Z"));
	const included = includedBasicDeployment.compute_subscription;
	const paid = paidBasicDeployment.compute_subscription;
	if (!included || !paid) throw new Error("Missing subscription fixtures");
	const deployment = mutationDeploymentReadFixture({
		...railHostedDeployment,
		hermes_control_ui_url: "https://runtime.example/",
	});
	const commercial = deployment.commercial_display;
	const runtimeStatus = deployment.resource.status;
	if (!commercial || !runtimeStatus) throw new Error("Missing deployment projection");
	const future = "2027-07-15T00:00:00Z";
	const ended = "2026-08-15T00:00:00Z";
	const billingMutations: string[] = [];
	page.on("request", (request) => {
		if (
			["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
			new URL(request.url()).host === "127.0.0.1:8001"
		)
			billingMutations.push(request.url());
	});
	await stubHostedApi(page, {
		deployments: [deployment],
		cloudAgents: [railHostedCloudAgent],
		plans: [basicPlan, performancePlan],
		agentResourceFixtures: true,
		sessionsPage: hostedOverviewSessionsPage(3),
	});
	for (const scenario of [
		{
			name: "included",
			subscription: included,
			value: "Included with your plan",
			date: null,
			action: "Upgrade",
		},
		{
			name: "stopped",
			subscription: included,
			value: "Included with your plan",
			date: null,
			action: "Upgrade",
		},
		{
			name: "paid",
			subscription: paid,
			value: "Active",
			date: ["Next renewal", "Jul 15, 2027"],
			action: null,
		},
		{
			name: "canceling",
			subscription: { ...paid, cancel_at_period_end: true, cancel_at: future },
			value: "Canceling",
			date: ["Ends on", "Jul 15, 2027"],
			action: null,
		},
		{
			name: "trial",
			subscription: {
				...paid,
				status: "trialing",
				actions: { cancel: "end_trial", resume: false, command_state: null },
			},
			value: "Trial",
			date: ["Trial ends", "Jul 15, 2027"],
			action: null,
		},
		{
			name: "payment-retry",
			subscription: {
				...paid,
				payment_state: "past_due",
				recovery_action: "fix_payment",
				next_payment_attempt_at: "2026-09-08T12:00:00Z",
			},
			value: "Past due",
			date: ["Next payment attempt", "Sep 8, 2026"],
			action: "Fix payment",
		},
		{
			name: "missing-retry",
			subscription: {
				...paid,
				payment_state: "past_due",
				recovery_action: "fix_payment",
				next_payment_attempt_at: null,
			},
			value: "Past due",
			date: null,
			action: "Fix payment",
		},
		{
			name: "wallet-recovery",
			subscription: {
				...paid,
				funding_source: "wallet",
				payment_state: "past_due",
				recovery_action: "top_up",
			},
			value: "Past due",
			date: null,
			action: "Top up",
		},
		{
			name: "ended",
			subscription: {
				...paid,
				status: "canceled",
				canceled_at: ended,
				recovery_action: "start_new",
			},
			value: "Ended",
			date: ["Ended on", "Aug 15, 2026"],
			action: "Manage",
		},
		{
			name: "pending",
			subscription: { ...paid, recovery_blocked_reason: "authority_pending" },
			value: "Updating subscription",
			date: null,
			action: null,
		},
		{
			name: "missing-date",
			subscription: { ...paid, current_period_end: null },
			value: "Active",
			date: null,
			action: null,
		},
		{
			name: "unknown-subscription",
			subscription: { ...paid, status: "unrecognized" },
			value: "Status unavailable",
			date: null,
			action: null,
		},
		{
			name: "unknown-runtime",
			subscription: { ...paid, current_period_end: null },
			value: "Active",
			date: null,
			action: null,
		},
		{ name: "missing-subscription", subscription: null, value: null, date: null, action: null },
	] as const) {
		commercial.compute_subscription = scenario.subscription;
		deployment.resource.status =
			scenario.name === "unknown-runtime"
				? null
				: { ...runtimeStatus, summary_state: scenario.name === "stopped" ? "stopped" : "running" };
		deployment.upgrade_available = scenario.name === "included" || scenario.name === "stopped";
		for (const width of scenario.name === "payment-retry" || scenario.name === "included"
			? [1440, 390, 320]
			: scenario.name === "paid"
				? [1440, 390]
				: [1440]) {
			await page.setViewportSize({
				width,
				height: width === 1440 ? 900 : width === 320 ? 800 : 844,
			});
			await page.goto(`/agents/${railHostedEnvironmentId}`);
			const compute = page.locator('[data-overview-status="compute"]');
			const body = compute.locator('[data-slot="card-content"]');
			await expect(body).toContainText("Basic plan");
			const row = body.locator("[data-overview-subscription-row]");
			if (scenario.value) await expect(row).toContainText(scenario.value);
			else await expect(row).toHaveCount(0);
			if (scenario.value === "Included with your plan") {
				await expect(row.getByText("Subscription:", { exact: true })).toHaveCount(0);
				await expect(row.getByText("Active", { exact: true })).toHaveCount(0);
			}
			const date = row.locator("xpath=following-sibling::div[1]");
			await expect(date).toHaveCount(scenario.date ? 1 : 0);
			if (scenario.date) for (const text of scenario.date) await expect(date).toContainText(text);
			const actions = body.getByRole("button");
			await expect(actions).toHaveCount(scenario.action ? 1 : 0);
			await expect(body.locator("dl [data-slot=button]")).toHaveCount(0);
			if (scenario.action) {
				await expect(actions).toHaveText(scenario.action);
				await expect(
					page.locator('main [data-slot="alert"]').getByRole("button", {
						name: /^(Fix payment|Top up|Start a new subscription)$/,
					}),
				).toHaveCount(0);
			}
			await expect(compute.locator("a a, a button, button a, [data-slot=badge]")).toHaveCount(0);
			if (scenario.action) {
				const target =
					scenario.action === "Top up"
						? `/agents/${railHostedEnvironmentId}?settings=billing-wallet`
						: `/agents/${railHostedEnvironmentId}/settings#compute-plan-controls`;
				await expect(actions).toHaveAttribute("href", target);
				await actions.click();
				await expect(page).toHaveURL(target);
				if (scenario.action === "Top up") await expect(page.getByRole("dialog")).toBeVisible();
				else await expect(page.locator("#compute-plan-controls")).toBeVisible();
			}
		}
	}
	expect(billingMutations).toEqual([]);
});

test("header Wallet adapts long balances across narrow touch layouts", async ({
	page,
	browser,
	baseURL,
}) => {
	if (!baseURL) throw new Error("Playwright baseURL is required for the Wallet header test.");
	const longBalance = "$12,345,678,901,234,567,890.12";
	await stubHostedApi(page, {
		walletResponses: [
			{
				body: { ...walletState, balance_usd: "12345678901234567890.12" },
				status: 200,
			},
		],
	});

	await page.goto("/agents");
	const walletSlot = page.getByTestId("global-wallet-balance-slot");
	const walletControl = page.getByTestId("global-wallet-balance");
	await expect(walletControl).toContainText(longBalance);
	await expect(walletControl).toHaveAttribute(
		"aria-label",
		`Wallet balance ${longBalance}. Open Wallet settings`,
	);
	const balanceText = walletControl.locator("span").filter({ hasText: longBalance });
	expect(await balanceText.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
		true,
	);

	await page.setViewportSize({ width: 320, height: 568 });
	const header = page.locator("header");
	const sidebarTrigger = page.getByRole("button", { name: "Toggle Sidebar" });
	const separator = header.locator('[data-slot="separator"]');
	const breadcrumb = header.locator('[data-slot="breadcrumb-list"]');
	const notificationCenter = page.getByRole("button", { name: "Notifications", exact: true });
	await expectNoHorizontalOverflow(header, "Wallet header at 320px");
	await expectContainedInOwnerAndViewport(
		page,
		walletControl,
		walletSlot,
		"Wallet header control at 320px",
	);
	await _expectControlsDoNotOverlap(
		[sidebarTrigger, separator, breadcrumb, walletControl, notificationCenter],
		"Wallet header at 320px",
	);
	expect(await balanceText.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
		true,
	);

	const touchContext = await browser.newContext({
		baseURL,
		hasTouch: true,
		viewport: { width: 320, height: 568 },
	});
	const touchPage = await touchContext.newPage();
	try {
		await stubHostedApi(touchPage);
		await touchPage.goto("/agents");
		expect(await touchPage.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
		const walletControl = touchPage.getByTestId("global-wallet-balance");
		const balanceText = walletControl.locator("span").filter({ hasText: "$25.00" });
		await expect(walletControl).toContainText("$25.00");
		for (const viewport of [
			{ width: 320, height: 568 },
			{ width: 390, height: 844 },
		]) {
			await touchPage.setViewportSize(viewport);
			expect(
				await balanceText.evaluate((element) => element.scrollWidth <= element.clientWidth),
			).toBe(true);
			const header = touchPage.locator("header");
			const walletSlot = touchPage.getByTestId("global-wallet-balance-slot");
			await expectNoHorizontalOverflow(header, `Wallet header at ${viewport.width}px`);
			await expectContainedInOwnerAndViewport(
				touchPage,
				walletControl,
				walletSlot,
				`Wallet header control at ${viewport.width}px touch`,
			);
			await _expectControlsDoNotOverlap(
				[
					touchPage.getByRole("button", { name: "Toggle Sidebar" }),
					header.locator('[data-slot="separator"]'),
					header.locator('[data-slot="breadcrumb-list"]'),
					walletControl,
					touchPage.getByRole("button", { name: "Notifications", exact: true }),
				],
				`Wallet header at ${viewport.width}px touch`,
			);
		}
	} finally {
		await touchContext.close();
	}
});

test("Wallet auto-reload authorizes and replaces its dedicated card responsively", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const walletSetupCreates: Array<{ body: string; idempotencyKey: string | null }> = [];
	const walletSetupFinalizes: string[] = [];
	await stubWalletStripeSetup(page);
	await stubHostedApi(page, {
		walletSetupCreates,
		walletSetupFinalizeFailures: 1,
		walletSetupFinalizes,
	});
	await page.setViewportSize({ width: 1280, height: 800 });
	const settingsDialog = await _gotoHostedSettingsDialog(page, "billing-wallet");
	const autoReload = settingsDialog.getByTestId("auto-reload-section");
	await expect(autoReload.getByRole("switch", { name: "Auto-reload" })).not.toBeChecked();
	await autoReload.getByRole("switch", { name: "Auto-reload" }).click();
	await autoReload.getByRole("button", { name: "Review and authorize" }).click();

	let setupDialog = page.getByRole("dialog", { name: "Authorize a card for auto-reload" });
	await expect(setupDialog).toContainText(
		"Each reload adds $25.00, plus any amount needed to bring a negative balance back to $0.",
	);
	await expect(setupDialog).toContainText(
		"charges it off-session when your balance drops below $5.00",
	);
	await expect(setupDialog).toContainText("You can disable auto-reload at any time.");
	await expect(setupDialog.getByText("Mock Wallet card form", { exact: true })).toBeVisible();
	await expectNoHorizontalOverflow(setupDialog, "desktop Wallet card setup");
	await _expectControlsDoNotOverlap(
		[
			setupDialog.getByRole("button", { name: "Cancel" }),
			setupDialog.getByRole("button", { name: "Authorize card and enable auto-reload" }),
		],
		"desktop Wallet card setup actions",
	);
	await expect.poll(() => walletSetupCreates.length).toBe(1);
	const firstStart = walletSetupCreates[0];
	expect(firstStart?.idempotencyKey).toBeTruthy();
	expect(JSON.parse(firstStart?.body ?? "{}")).toEqual({
		auto_reload_amount_cents: 2_500,
		auto_reload_monthly_cap_cents: 10_000,
		auto_reload_threshold_usd: "5",
		consent_version: "wallet_auto_reload_off_session_v2",
	});
	expect(await page.evaluate(() => window.__stripeWalletAppearanceThemes)).toContain("stripe");
	const initialClientSecrets = await page.evaluate(() => window.__stripeWalletClientSecrets ?? []);
	expect(new Set(initialClientSecrets)).toEqual(new Set(["seti_wallet_1_secret_mock_1"]));

	await page.locator("html").evaluate((element) => element.classList.add("dark"));
	await expect
		.poll(() => page.evaluate(() => window.__stripeWalletAppearanceThemes))
		.toContain("night");
	expect(await page.evaluate(() => window.__stripeWalletClientSecrets)).toHaveLength(
		initialClientSecrets.length,
	);
	await setupDialog.getByRole("button", { name: "Authorize card and enable auto-reload" }).click();
	await expect.poll(() => walletSetupFinalizes.length).toBe(1);
	await expect(
		setupDialog.getByRole("button", { name: "Retry enabling auto-reload" }),
	).toBeVisible();
	expect(await page.evaluate(() => window.__stripeWalletConfirmCalls)).toBe(1);
	await setupDialog.getByRole("button", { name: "Retry enabling auto-reload" }).click();
	await expect.poll(() => walletSetupFinalizes.length).toBe(2);
	await expect(setupDialog).toHaveCount(0);
	await expect(autoReload.getByText("Visa ending in 4242", { exact: true })).toBeVisible();
	await expect(autoReload.getByRole("button", { name: "Replace card" })).toBeVisible();
	expect(JSON.parse(walletSetupFinalizes[0] ?? "{}")).toEqual({
		setup_identity: `wsetup_${"a".repeat(64)}`,
		setup_intent_id: "seti_wallet_1",
	});
	expect(walletSetupFinalizes[1]).toBe(walletSetupFinalizes[0]);
	const firstReturnUrl = new URL(
		(await page.evaluate(() => window.__stripeWalletReturnUrls?.[0])) ?? "",
	);
	expect(firstReturnUrl.searchParams.get("wallet_setup_return")).toBe("1");
	expect(firstReturnUrl.searchParams.get("wallet_setup_id")).toBe(`wsetup_${"a".repeat(64)}`);
	expect(firstReturnUrl.search).not.toContain("secret");

	await page.setViewportSize({ width: 375, height: 700 });
	await autoReload.getByRole("button", { name: "Replace card" }).click();
	setupDialog = page.getByRole("dialog", { name: "Replace auto-reload card" });
	await expect(setupDialog.getByText("Mock Wallet card form", { exact: true })).toBeVisible();
	await expectNoHorizontalOverflow(page.locator("html"), "mobile Wallet settings document");
	await expectNoHorizontalOverflow(setupDialog, "mobile Wallet card setup");
	await _expectControlsDoNotOverlap(
		[
			setupDialog.getByRole("button", { name: "Cancel" }),
			setupDialog.getByRole("button", { name: "Authorize card and enable auto-reload" }),
		],
		"mobile Wallet card setup actions",
	);
	await expect.poll(() => walletSetupCreates.length).toBe(2);
	const secondStart = walletSetupCreates[1];
	expect(secondStart?.body).toBe(firstStart?.body);
	expect(secondStart?.idempotencyKey).toBeTruthy();
	expect(secondStart?.idempotencyKey).not.toBe(firstStart?.idempotencyKey);
	expect(new Set(await page.evaluate(() => window.__stripeWalletClientSecrets ?? []))).toEqual(
		new Set(["seti_wallet_1_secret_mock_1", "seti_wallet_2_secret_mock_2"]),
	);
	await setupDialog.getByRole("button", { name: "Authorize card and enable auto-reload" }).click();
	await expect.poll(() => walletSetupFinalizes.length).toBe(3);
	await expect(autoReload.getByText("Mastercard ending in 4444", { exact: true })).toBeVisible();
	expect(await page.evaluate(() => window.__stripeWalletConfirmCalls)).toBe(2);
	await autoReload.getByRole("switch", { name: "Auto-reload" }).click();
	await autoReload.getByRole("button", { name: "Disable auto-reload" }).click();
	await expect(autoReload.getByRole("switch", { name: "Auto-reload" })).not.toBeChecked();
	await expect(autoReload.getByText("Mastercard ending in 4444", { exact: true })).toHaveCount(0);
	await expect(autoReload.getByRole("button", { name: "Replace card" })).toHaveCount(0);
	await page.goto(
		"/channels?settings=billing-wallet&keep=1&wallet_payment_return=1&wallet_payment_flow=auto_reload&payment_intent=pi_auto_reload_return&payment_intent_client_secret=pi_auto_reload_return_secret_mock&redirect_status=succeeded#billing",
	);
	await expect(page.getByText("Auto-reload payment confirmed", { exact: true })).toBeVisible();
	await expect(page.getByText("Payment accepted", { exact: true })).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => `${window.location.search}${window.location.hash}`))
		.toBe("?settings=billing-wallet&keep=1#billing");
	const expectedFinalizeErrors = errors.filter((error) =>
		error.includes("503 (Service Unavailable)"),
	);
	expect(expectedFinalizeErrors).toHaveLength(1);
	const unexpectedErrors = errors.filter((error) => !expectedFinalizeErrors.includes(error));
	expect(unexpectedErrors, `Wallet card authorization: ${unexpectedErrors.join(" | ")}`).toEqual(
		[],
	);
});

for (const entry of ["inline", "return"] as const) {
	test(`rejected trial refreshes eligibility after ${entry} checkout`, async ({ page }) => {
		let rejected = false;
		const checkoutRequests: string[] = [];
		await stubCompletedStripeCheckout(page);
		await stubHostedApi(page, {
			checkoutRequests,
			checkoutResponses: [
				{
					status: 200,
					body: {
						flow_type: "checkout_session",
						funding_source: "stripe",
						action_url: null,
						checkout_url: "https://checkout.stripe.test/session",
						client_secret: "cs_test_rejected_trial",
						trial_period_days: 7,
					},
				},
			],
			deployments: [includedBasicDeployment],
			plans: [basicPlan],
		});
		await page.route("**/v2/subscription/plans", (route) =>
			fulfillJson(route, [
				{
					...basicPlan,
					offers: basicPlan.offers.map((offer) => ({
						...offer,
						card_trial_period_days: rejected ? null : 7,
					})),
				},
			]),
		);
		await page.route("**/v2/deployments/by-request/**", (route) => {
			rejected = true;
			return fulfillJson(route, {
				deploy_request_id: "rejected-trial",
				request_status: "failed",
				failure_code: "trial_ineligible",
				lineage_tail: null,
			});
		});
		await page.goto(
			entry === "return"
				? "/deploy?session_id=cs_trial&deploy_request_id=rejected-trial"
				: "/deploy",
		);
		if (entry === "inline") {
			await expect(page.getByText("7-day free trial", { exact: true }).first()).toBeVisible();
			await page.getByRole("button", { name: "Continue" }).click();
			await page
				.getByRole("dialog", { name: /Complete .* checkout/ })
				.getByRole("button", { name: "Subscribe", exact: true })
				.click();
		}
		await expect(page.getByText("Free trial unavailable", { exact: true })).toBeVisible();
		await expect(page.getByText("7-day free trial", { exact: true })).toHaveCount(0);
		await expect(page.getByText("Checkout status refreshed", { exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
	});
}

for (const runtime of ["openclaw", "hermes"] as const) {
	for (const fundingSource of ["stripe", "wallet"] as const) {
		test(`replayed ${runtime} ${fundingSource} checkout opens the authoritative Agent`, async ({
			page,
		}) => {
			const retryDetail = runtime === "openclaw" && fundingSource === "wallet";
			const created: DeploymentMutationFixture = {
				...paidBasicDeployment,
				id: "hdep_replayed_checkout",
				name: "Replayed Agent",
				status: "creating",
				config_info: { ...paidBasicDeployment.config_info, runtime },
			};
			const checkoutRequests: string[] = [];
			const detailRequests: string[] = [];
			await stubHostedApi(page, {
				deployments: [
					includedBasicDeployment,
					{ ...paidBasicDeployment, status: "stopped" },
					created,
				],
				plans: [basicPlan],
				walletState: { ...walletState, balance_usd: "500.00" },
				checkoutRequests,
				checkoutResponses: [
					{
						status: 202,
						body: {
							flow_type: "subscription_activation",
							funding_source: fundingSource,
							subscription_id: 42,
							deployment_id: created.id,
							agent_id: "00000000-0000-4000-8000-000000000000",
							deployment_name: created.name,
							metadata_generation: 1,
							checkout_url: "",
						},
					},
				],
				deploymentDetailRequests: detailRequests,
				deploymentDetailResponses: retryDetail
					? [
							{ status: 503, body: { detail: "Temporarily unavailable" } },
							{ status: 200, body: created },
						]
					: [{ status: 200, body: created }],
				cloudAgentNotFoundIds: [fixtureAgentId(created)],
			});
			await page.goto("/deploy");
			await expect(
				page
					.getByTestId("app-sidebar-agent-rail")
					.getByRole("button", { name: created.name, exact: true }),
			).toBeVisible();
			if (runtime === "openclaw") await page.getByRole("button", { name: /OpenClaw/i }).click();
			if (fundingSource === "wallet")
				await page
					.locator("form")
					.getByRole("button", { name: /Wallet balance/ })
					.click();
			await page
				.getByTestId("deploy-action-bar")
				.getByRole("button", {
					name: fundingSource === "wallet" ? "Pay & deploy" : "Continue",
					exact: true,
				})
				.click();
			if (retryDetail) {
				await expect(
					page.getByText("Retrying loads the deployed agent without creating another one."),
				).toBeVisible();
				await page.getByTestId("deploy-action-bar").getByRole("button", { name: /Retry/ }).click();
			}
			await expect(page).toHaveURL(`/agents/${fixtureAgentId(created)}`);
			await expect(page.getByRole("heading", { name: "Deploy an Agent" })).toHaveCount(0);
			await expect(page.getByTestId("hosted-initial-deployment-panel")).toBeVisible();
			await expect(page.getByText("Agent couldn’t be opened", { exact: true })).toHaveCount(0);
			expect(checkoutRequests).toHaveLength(1);
			expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({
				funding_source: fundingSource,
				deploy_config: { runtime },
			});
			expect(detailRequests).toEqual(Array(retryDetail ? 2 : 1).fill(created.id));
		});
	}
}

test("paid checkout waits for deployment membership before navigation without LRO convergence", async ({
	page,
}) => {
	let releaseDetail = () => {};
	const detailGate = new Promise<void>((resolve) => {
		releaseDetail = resolve;
	});
	const checkoutRequests: string[] = [];
	const deploymentDetailRequests: string[] = [];
	const deploymentRequestReads: string[] = [];
	const operationPollRequests: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (path.startsWith("/v2/operations/")) operationPollRequests.push(path);
	});
	await stubCompletedStripeCheckout(page);
	const startingDeployment: DeploymentMutationFixture = {
		...paidBasicDeployment,
		id: "hdep_created",
		name: "Created Basic",
		status: "creating",
	};
	await stubHostedApi(page, {
		checkoutRequests,
		checkoutResponses: [
			{
				status: 200,
				body: {
					flow_type: "checkout_session",
					funding_source: "stripe",
					action_url: null,
					checkout_url: "https://checkout.stripe.test/session",
					client_secret: "cs_test_paid_checkout",
				},
			},
		],
		deploymentDetailRequests,
		deploymentRequestReads,
		deployments: [includedBasicDeployment],
		deploymentDetailResponses: [{ status: 200, body: startingDeployment }],
		deploymentDetailResponseGates: [detailGate],
		cloudAgentNotFoundIds: [fixtureAgentId(startingDeployment)],
		plans: [basicPlan],
		unfinishedDeploymentRequests: true,
	});
	await page.goto("/deploy");

	await page.getByRole("button", { name: "Continue" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({ ui_mode: "custom" });
	const checkoutDialog = page.getByRole("dialog", { name: /Complete .* checkout/ });
	await expect(checkoutDialog.getByText("Mock secure payment form", { exact: true })).toBeVisible();
	await checkoutDialog.getByRole("button", { name: "Subscribe", exact: true }).click();

	await expect.poll(() => deploymentRequestReads).toHaveLength(1);
	await expect.poll(() => deploymentDetailRequests).toEqual([startingDeployment.id]);
	await expect(page).toHaveURL("/deploy");
	releaseDetail();
	await expect(page).toHaveURL(`/agents/${fixtureAgentId(startingDeployment)}`);
	await expect(page.getByText("Setting up Hermes", { exact: true })).toBeVisible();
	await expect(page.getByText("Preparing cloud resources", { exact: true })).toBeVisible();
	await expect(page.getByTestId("hosted-initial-deployment-panel")).toBeVisible();
	await expect(page.getByText("Chat on the web", { exact: true })).toHaveCount(0);
	expect(operationPollRequests).toEqual([]);
	await expect(page.getByText("Couldn’t deploy", { exact: true })).toHaveCount(0);
});

test("paid card subscription confirms an immediate quoted upgrade", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [paidBasicDeployment],
		planChangeRequests,
		planChangeResponses: [
			planChangeResponse({
				operationId: "op_paid_card",
				subscriptionId: 42,
				fundingSource: "stripe",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				targetBillingTermMonths: 12,
				status: "awaiting_projection",
				effectiveAt: "2026-07-16T00:00:00Z",
			}),
		],
		planChangeOperationResponses: [
			{
				...planChangeResponse({
					operationId: "op_paid_card",
					subscriptionId: 42,
					fundingSource: "stripe",
					currentPlanSlug: "compute_basic",
					targetPlanSlug: "compute_performance",
					targetBillingTermMonths: 12,
					status: "complete",
					effectiveAt: "2026-07-16T00:00:00Z",
				}),
				status: 200,
				delayMs: 3_000,
			},
		],
		planQuoteRequests,
		planQuoteResponses: [
			planChangeQuoteResponse({
				operationId: "op_paid_card",
				subscriptionId: 42,
				fundingSource: "stripe",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				currentBillingTermMonths: 12,
				targetBillingTermMonths: 12,
				changeKind: "immediate_upgrade",
				effectiveAt: "2026-07-16T00:00:00Z",
				amountCents: 9_360,
				amountUsd: null,
			}),
		],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(paidBasicDeployment), "Basic");

	await page
		.locator('[data-slot="compute-subscription-card"]')
		.getByRole("button", { name: "Manage", exact: true })
		.click();
	const changeDialog = page.getByRole("dialog");
	await expect(changeDialog).toHaveAccessibleName("Manage compute subscription");
	await expect(
		changeDialog.getByRole("button", { name: "Plan & billing", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await changeDialog.getByRole("combobox", { name: "Compute plan" }).click();
	await page.getByRole("option", { name: "Performance", exact: true }).click();
	await changeDialog.getByRole("button", { name: "Review change" }).click();
	await expect.poll(() => planQuoteRequests.length).toBe(1);
	await expect(changeDialog.getByText("$93.60", { exact: true })).toBeVisible();
	await changeDialog.getByRole("button", { name: "Confirm upgrade" }).click();

	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		deployment_id: "hdep_paid",
		target_plan_slug: "compute_performance",
		target_billing_term_months: 12,
		funding_source: "stripe",
	});
	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_paid_card",
	});
	await expect(
		changeDialog.getByText("Still waiting for confirmation", { exact: true }),
	).toBeVisible();
	await changeDialog.getByRole("button", { name: "Close", exact: true }).last().click();
	await expect(changeDialog).not.toBeVisible();
	await expect(
		page
			.locator('[data-slot="compute-subscription-card"]')
			.getByRole("button", { name: "Manage", exact: true }),
	).toBeVisible();
	await expect(page.getByText("Plan changed", { exact: true })).toBeVisible();
	expect(errors, `paid card upgrade: ${errors.join(" | ")}`).toEqual([]);
});

test("paid card subscription switches future renewals to Wallet", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const planChangeRequests: string[] = [];
	const planQuoteRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [paidBasicDeployment],
		planChangeRequests,
		planChangeResponses: [
			planChangeResponse({
				operationId: "op_card_to_wallet",
				subscriptionId: 42,
				fundingSource: "wallet",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_basic",
				targetBillingTermMonths: 12,
				changeKind: "funding_source_switch",
				status: "complete",
				effectiveAt: "2026-07-16T00:00:00Z",
			}),
		],
		planQuoteRequests,
		planQuoteResponses: [
			planChangeQuoteResponse({
				operationId: "op_card_to_wallet",
				subscriptionId: 42,
				fundingSource: "wallet",
				currentPlanSlug: "compute_basic",
				targetPlanSlug: "compute_basic",
				currentBillingTermMonths: 12,
				targetBillingTermMonths: 12,
				changeKind: "funding_source_switch",
				effectiveAt: "2026-07-16T00:00:00Z",
				amountCents: 0,
				amountUsd: "0.00",
			}),
		],
		plans: [basicPlan, performancePlan],
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(paidBasicDeployment), "Basic");

	await page
		.locator('[data-slot="compute-subscription-card"]')
		.getByRole("button", { name: "Manage", exact: true })
		.click();
	const changeDialog = page.getByRole("dialog");
	await expect(changeDialog).toHaveAccessibleName("Manage compute subscription");
	await changeDialog.getByRole("button", { name: "Payment source", exact: true }).click();
	await changeDialog.getByRole("button", { name: "Wallet", exact: true }).click();
	await changeDialog.getByRole("button", { name: "Review change" }).click();

	await expect.poll(() => planQuoteRequests.length).toBe(1);
	expect(JSON.parse(planQuoteRequests[0] ?? "{}")).toEqual({
		deployment_id: "hdep_paid",
		target_plan_slug: "compute_basic",
		target_billing_term_months: 12,
		funding_source: "wallet",
	});
	await expect(changeDialog.getByText("$0.00", { exact: true })).toBeVisible();
	await expect(changeDialog.getByText("Future renewals use Wallet", { exact: true })).toBeVisible();
	await changeDialog.getByRole("button", { name: "Update payment source" }).click();

	await expect.poll(() => planChangeRequests.length).toBe(1);
	expect(JSON.parse(planChangeRequests[0] ?? "{}")).toEqual({
		operation_id: "op_card_to_wallet",
	});
	await expect(page.getByText("Payment method updated", { exact: true })).toBeVisible();
	await expect(page.getByText("Future renewals will use Wallet.", { exact: true })).toBeVisible();
	expect(errors, `card to Wallet switch: ${errors.join(" | ")}`).toEqual([]);
});

test("accepted plan change recovers from the deployment projection after refresh", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const planChangeRequests: string[] = [];
	const operation = (status: "awaiting_projection" | "complete") =>
		planChangeResponse({
			operationId: "op_recovered_card",
			subscriptionId: 42,
			fundingSource: "stripe",
			currentPlanSlug: "compute_basic",
			targetPlanSlug: "compute_performance",
			targetBillingTermMonths: 12,
			status,
			effectiveAt: "2026-07-16T00:00:00Z",
		});
	const pendingOperation = operation("awaiting_projection").body;
	const failedOperation: NonNullable<DeploymentRead["accepted_operation"]> = {
		...pendingOperation,
		done: true,
		error: { code: 9, message: "Plan change failed", details: [] },
	};
	const projectedDeployment = mutationDeploymentReadFixture(terminalFallbackDeployment);
	projectedDeployment.accepted_operation = {
		...pendingOperation,
		metadata: { ...pendingOperation.metadata, deploymentId: projectedDeployment.resource.id },
	};
	const terminalDeployment = {
		...projectedDeployment,
		accepted_operation: {
			...failedOperation,
			metadata: { ...failedOperation.metadata, deploymentId: projectedDeployment.resource.id },
		},
	};
	const deployments: DeploymentRead[] = [projectedDeployment];

	await stubHostedApi(page, {
		deployments,
		planChangeRequests,
		plans: [basicPlan, performancePlan],
	});
	await page.route(`${DEPLOY_API}/v2/${pendingOperation.name}`, async (route) => {
		deployments[0] = terminalDeployment;
		await fulfillJson(route, terminalDeployment.accepted_operation);
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(terminalFallbackDeployment), "Basic");
	await page.reload();

	await page.getByRole("button", { name: "Check subscription change status" }).click();
	const recoveryDialog = page.getByRole("dialog", { name: "Check subscription change status" });
	await expect(
		recoveryDialog.getByText(
			"This subscription change was already accepted. Checking its status will not submit another request or charge.",
			{ exact: true },
		),
	).toBeVisible();
	await recoveryDialog.getByRole("button", { name: "Check status", exact: true }).click();
	await expect(page.getByText("Couldn’t update subscription", { exact: true })).toBeVisible();
	await expect(recoveryDialog).toBeHidden();
	await expect(
		page.locator("#compute-plan-controls").getByRole("button", { name: "Choose a subscription" }),
	).toBeVisible();
	expect(planChangeRequests).toEqual([]);
	expect(errors, `recovered plan change: ${errors.join(" | ")}`).toEqual([]);
});
