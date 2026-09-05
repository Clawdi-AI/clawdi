import { expect, test } from "@playwright/test";
import {
	basicPlan,
	collectBrowserErrors,
	fixtureAgentId,
	gotoHostedAgentSettings,
	mutationDeploymentReadFixture,
	paidBasicDeployment,
	performancePlan,
	stubHostedApi,
} from "./hosted-stub-api";

for (const width of [1440, 320]) {
	test(`ended subscription power entries reuse subscription selection at ${width}px`, async ({
		page,
	}, testInfo) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width, height: 900 });
		const errors = collectBrowserErrors(page);
		const startRequests: string[] = [];
		const deployment = {
			...mutationDeploymentReadFixture({
				...paidBasicDeployment,
				status: "stopped",
				compute_subscription: {
					...paidBasicDeployment.compute_subscription,
					status: "canceled",
					recovery_action: "start_new",
					actions: null,
				},
			}),
			start_action: "subscribe" as const,
			files_endpoint: { url: "https://files.example.test/" },
		};
		await stubHostedApi(page, {
			deployments: [deployment],
			plans: [basicPlan, performancePlan],
			startRequests,
		});
		await page.goto("/agents");
		await page.getByRole("link", { name: /^Open .*Status: Stopped$/ }).click();
		await expect(page).toHaveURL(new RegExp(`/agents/${deployment.agent_id}$`));
		for (const section of ["console", "files", "terminal", "channel-links", "settings"]) {
			await page.goto(`/agents/${deployment.agent_id}/${section}`);
			const start = page.getByRole("button", {
				name: "Subscribe to start",
				exact: true,
			});
			await expect(start).toBeVisible();
			const startBox = await start.boundingBox();
			expect(startBox).not.toBeNull();
			expect(startBox?.x).toBeGreaterThanOrEqual(0);
			expect((startBox?.x ?? 0) + (startBox?.width ?? 0)).toBeLessThanOrEqual(width);
			await page.waitForLoadState("networkidle");
			await start.click();
			await expect(page.getByRole("dialog", { name: "Choose a paid subscription" })).toBeVisible();
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
			await expect(page.getByRole("dialog")).not.toContainText(/container|volume|disk/i);
			await expect(
				page.getByRole("dialog").getByRole("combobox", { name: "Compute plan" }),
			).toBeVisible();
			await expect(page.getByRole("button", { name: /^(Start|Start agent)$/ })).toHaveCount(0);
			await expect.poll(() => startRequests.length).toBe(0);
			if (section === "settings") {
				await page.screenshot({
					path: testInfo.outputPath(`subscribe-to-start-${width}.png`),
					fullPage: true,
				});
			}
			await page.keyboard.press("Escape");
		}
		expect(errors).toEqual([]);
	});
}

test("a manually stopped paid agent still starts normally and explains a funding race", async ({
	page,
}) => {
	const deployment = { ...paidBasicDeployment, status: "stopped" };
	const startRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [deployment],
		plans: [basicPlan, performancePlan],
		startRequests,
		startError: {
			status: 409,
			code: "funding_revoked_after_accept",
			detail: "Internal funding fence",
		},
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(deployment), "Basic");
	await expect(page.getByRole("button", { name: "Subscribe to start" })).toHaveCount(0);
	await page.getByRole("button", { name: "Start", exact: true }).click();
	await expect(page.locator("[data-sonner-toast]")).toContainText(
		"Open Agent settings and choose a subscription",
	);
	await expect(page.locator("[data-sonner-toast]")).not.toContainText(
		/internal|another session|container|volume|disk/i,
	);
	expect(startRequests).toHaveLength(1);
});

for (const status of ["trialing", "active"] as const) {
	test(`${status} cancellation keeps saved data and explicit Delete stays destructive`, async ({
		page,
	}) => {
		const deployment = {
			...paidBasicDeployment,
			compute_subscription: {
				...paidBasicDeployment.compute_subscription,
				status,
				actions: {
					cancel:
						status === "trialing" ? ("end_trial" as const) : ("cancel_at_period_end" as const),
					resume: false,
					command_state: null,
				},
			},
		};
		const cancelRequests: string[] = [];
		const deleteRequests: unknown[] = [];
		await stubHostedApi(page, {
			deployments: [deployment],
			plans: [basicPlan, performancePlan],
			cancelRequests,
			cancelResponse: {
				status: "canceled",
				billing_term_months: 12,
				cancel_at_period_end: false,
				action_state: status === "trialing" ? "pending" : "reconciling",
			},
		});
		await page.route(`**/v2/deployments/${deployment.id}`, async (route) => {
			if (route.request().method() !== "DELETE") return route.fallback();
			deleteRequests.push(route.request().postDataJSON());
			await route.fulfill({ json: { deployment_id: deployment.id, status: "absent" } });
		});
		await gotoHostedAgentSettings(page, fixtureAgentId(deployment), "Basic");
		await page
			.getByRole("button", {
				name: status === "trialing" ? "End trial now" : "Cancel subscription",
				exact: true,
			})
			.click();
		const cancelDialog = page.getByRole("alertdialog");
		await expect(cancelDialog).toContainText("Your saved data is kept.");
		await expect(cancelDialog).not.toContainText(/container|volume|disk|permanently delete/i);
		await expect(cancelDialog).toContainText(
			status === "trialing" ? "The trial ends immediately" : "The agent stops when the period ends",
		);
		await cancelDialog
			.getByRole("button", {
				name: status === "trialing" ? "End trial now" : "Cancel at period end",
			})
			.click();
		await expect(page.locator("[data-sonner-toast]")).toContainText(
			"Cancellation is still processing",
		);
		await expect(page.locator("[data-sonner-toast]")).not.toContainText(
			/Subscription canceled|Cancellation scheduled|trial has ended/,
		);
		expect(cancelRequests.map((body) => JSON.parse(body))).toEqual([
			{ deployment_id: deployment.id },
		]);
		expect(deleteRequests).toEqual([]);
		await page.getByRole("button", { name: "Delete", exact: true }).click();
		const deleteDialog = page.getByRole("alertdialog");
		await expect(deleteDialog).toContainText("permanently deletes the agent and its saved data");
		await expect(deleteDialog).toContainText("can’t be undone");
		await expect(deleteDialog).toContainText(
			status === "trialing" ? "The trial ends immediately" : "remain active through",
		);
		await expect(deleteDialog).not.toContainText(/saved data is kept|container|volume|disk/i);
		await deleteDialog
			.getByRole("button", { name: "Delete agent and cancel subscription", exact: true })
			.click();
		await expect
			.poll(() => deleteRequests)
			.toEqual([{ subscription_choice: "cancel_subscription" }]);
	});
}

for (const width of [1440, 320]) {
	for (const state of [
		{
			status: "incomplete",
			blocked: "payment_pending",
			start: "wait",
			label: "Updating subscription",
		},
		{ status: "paused", blocked: "paused", start: "contact_support", label: "Contact support" },
		{
			status: "unpaid",
			blocked: "authority_pending",
			start: "contact_support",
			label: "Contact support",
		},
		{ status: "canceled", blocked: null, start: "wait", label: "Updating subscription" },
	] as const) {
		test(`${state.status} does not sell a replacement or duplicate payment at ${width}px`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			const startRequests: string[] = [];
			const deployment = {
				...mutationDeploymentReadFixture({
					...paidBasicDeployment,
					status: "stopped",
					compute_subscription: {
						...paidBasicDeployment.compute_subscription,
						status: state.status,
						recovery_action: null,
						recovery_blocked_reason: state.blocked,
						actions:
							state.status === "canceled"
								? { cancel: null, resume: false, command_state: "pending" }
								: null,
					},
				}),
				start_action: state.start,
			};
			await stubHostedApi(page, {
				deployments: [deployment],
				plans: [basicPlan, performancePlan],
				startRequests,
			});
			await gotoHostedAgentSettings(page, deployment.agent_id, "Basic");
			await expect(page.getByRole("button", { name: state.label, exact: true })).toBeVisible();
			await expect(
				page.getByRole("button", {
					name: /Subscribe to start|Fix payment|Start new subscription|Keep subscription/,
				}),
			).toHaveCount(0);
			expect(startRequests).toEqual([]);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
		});
	}
}

test("historical scheduled trial keeps its end date and offers an explicit immediate end", async ({
	page,
}) => {
	const deployment = {
		...paidBasicDeployment,
		compute_subscription: {
			...paidBasicDeployment.compute_subscription,
			status: "trialing",
			cancel_at_period_end: true,
			actions: { cancel: "end_trial" as const, resume: true, command_state: null },
		},
	};
	const cancelRequests: string[] = [];
	await stubHostedApi(page, {
		deployments: [deployment],
		plans: [basicPlan, performancePlan],
		cancelRequests,
		cancelResponse: {
			status: "canceled",
			billing_term_months: 12,
			cancel_at_period_end: false,
			action_state: "pending",
		},
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(deployment), "Basic");
	await expect(page.getByRole("button", { name: "Keep subscription", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "End trial now", exact: true })).toBeVisible();
	expect(cancelRequests).toEqual([]);
	await page.getByRole("button", { name: "End trial now", exact: true }).click();
	await expect(page.getByRole("alertdialog")).toContainText("Your saved data is kept");
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "End trial now", exact: true })
		.click();
	expect(cancelRequests.map((body) => JSON.parse(body))).toEqual([
		{ deployment_id: deployment.id },
	]);
	await expect(page.locator("[data-sonner-toast]")).toContainText(
		"Cancellation is still processing",
	);
});
