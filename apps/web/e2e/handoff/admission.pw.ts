import { expect } from "@playwright/test";
import { basicPlan, stubHostedApi } from "../hosted-stub-api";
import { cloud, isolateNetwork, marketing, observeCloudHandoff, test } from "./fixtures";

test.beforeEach(async ({ context, page }) => {
	await isolateNetwork(context);
	await stubHostedApi(page, { plans: [basicPlan] });
});

for (const signedIn of [false, true]) {
	test(`public marketing /home stays public (${signedIn ? "signed in" : "guest"})`, async ({
		context,
		page,
	}) => {
		if (signedIn)
			await context.addCookies([{ name: "test-user", value: "account-a", url: marketing }]);
		const response = await page.goto(`${marketing}/home`);
		expect(response?.status()).toBe(200);
		await expect(page).toHaveURL(`${marketing}/home`);
		await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
		await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
			"href",
			"https://clawdi.ai",
		);
		await expect(
			page.getByRole("banner").locator('a[href="/api/cloud-handoff?target=dashboard"]'),
		).toBeVisible();
	});
}

for (const origin of [marketing, cloud]) {
	test(`signed-out ${origin === marketing ? "marketing" : "Cloud"} root renders marketing`, async ({
		page,
	}) => {
		const response = await page.goto(`${origin}/`);
		expect(response?.status()).toBe(200);
		await expect(page).toHaveURL(`${marketing}/`);
		await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
	});
}

test("signed-in marketing root enters the canonical Cloud overview through handoff", async ({
	context,
	page,
}) => {
	await context.addCookies(
		[marketing, cloud].map((url) => ({ name: "test-user", value: "account-a", url })),
	);
	const destinations: URL[] = [];
	observeCloudHandoff(context, destinations);
	await page.goto(`${marketing}/`);
	await expect(page).toHaveURL(`${cloud}/`);
	await expect(page.getByTestId("dashboard-page-content")).toBeVisible();
	expect(destinations.map((url) => url.pathname)).toEqual(["/dashboard"]);
});

test("authenticated dashboard alias preserves channel, settings and hash on overview", async ({
	context,
	page,
}) => {
	await context.addCookies([{ name: "test-user", value: "account-a", url: cloud }]);
	await page.goto(`${cloud}/dashboard?deploy_profile=sui&settings=general#details`);
	await expect(page).toHaveURL(`${cloud}/?deploy_profile=sui&settings=general#details`);
	await expect(page.getByRole("dialog")).toBeVisible();
});

for (const trial of ["absent", "captured", "invalid"] as const) {
	test(`session disagreement recovers through native sign-in (${trial} offer)`, async ({
		context,
		page,
		offerRequests,
	}) => {
		await context.addCookies([{ name: "test-user", value: "account-a", url: marketing }]);
		if (trial === "invalid") {
			await context.addCookies([
				{ name: "clawdi-deploy-intent", value: "sui", url: marketing, httpOnly: true },
				{ name: "clawdi-trial-offer", value: "invalid_credential", url: marketing, httpOnly: true },
			]);
		}
		const checkoutRequests: string[] = [];
		await stubHostedApi(page, {
			plans: [
				{
					...basicPlan,
					offers: basicPlan.offers.map((offer) => ({ ...offer, card_trial_period_days: 7 })),
				},
			],
			checkoutRequests,
		});
		const destinations: URL[] = [];
		observeCloudHandoff(context, destinations);
		const documents: string[] = [];
		page.on("request", (request) => {
			if (request.isNavigationRequest() && request.frame() === page.mainFrame())
				documents.push(request.url());
		});
		// The captured case must issue cookies on the root redirect itself, before
		// the following same-origin handoff reads them. Other cases start on Cloud.
		await page.goto(trial === "captured" ? `${marketing}/?deploy_profile=sui` : `${cloud}/`);
		await page.waitForURL(`${cloud}/sign-in?**`);
		const destination = trial === "absent" ? "/dashboard" : "/dashboard?deploy_profile=sui";
		expect(new URL(page.url()).searchParams.get("redirect_url")).toBe(destination);
		expect(destinations).toHaveLength(1);
		expect(documents.filter((url) => new URL(url).origin === marketing)).toHaveLength(2);
		expect(destinations[0]?.pathname).toBe(trial === "captured" ? "/trial-offer" : "/dashboard");
		if (trial === "captured") {
			expect(destinations[0]?.searchParams.get("target")).toBe("dashboard");
			expect(destinations[0]?.searchParams.get("deploy_profile")).toBe("sui");
		}
		const cookies = await context.cookies();
		const marketingOffer = cookies.find(
			(cookie) => cookie.name === "clawdi-trial-offer" && cookie.domain === "marketing",
		);
		const cloudOffer = cookies.find(
			(cookie) => cookie.name === "clawdi-trial-offer" && cookie.domain === "localhost",
		);
		if (trial === "captured") {
			expect(marketingOffer?.httpOnly).toBe(true);
			expect(cloudOffer?.httpOnly).toBe(true);
			expect(cloudOffer?.value).toBe(marketingOffer?.value);
		} else expect(cloudOffer).toBeUndefined();
		// Completing native auth returns through protected admission, then overview.
		await page.getByRole("button", { name: "Complete simulated auth return" }).click();
		const search = trial === "absent" ? "" : "?deploy_profile=sui";
		await expect(page).toHaveURL(`${cloud}/${search}`);
		await expect(page.getByTestId("dashboard-page-content")).toBeVisible();
		await page.getByRole("button", { name: "Deploy on Clawdi", exact: true }).click();
		await expect(page).toHaveURL(`${cloud}/deploy${search}`);
		if (trial !== "absent")
			await expect(page.getByRole("button", { name: /Sui bundle/ })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
		if (trial === "captured") {
			await expect
				.poll(() => offerRequests)
				.toContainEqual({
					token: marketingOffer?.value,
					authorization: "Bearer account-a",
				});
			await expect(page.getByRole("button", { name: /^Free trial/ })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			await expect(page.getByText("No card required", { exact: true })).toBeVisible();
			await page.getByRole("button", { name: /^Configure inside agent/ }).click();
			await page.getByRole("button", { name: "Continue", exact: true }).click();
			await expect.poll(() => checkoutRequests.length).toBe(1);
			const checkout = JSON.parse(checkoutRequests[0] ?? "{}");
			expect(checkout.deploy_config.trial_offer_token).toBe(marketingOffer?.value);
			expect(checkout.deploy_config.plugin_bundle).toBe("sui");
			expect(checkout.ui_mode).toBe("hosted");
		} else expect(offerRequests).toEqual([]);
	});
}

test("protected deep links keep their original native login return", async ({ page }) => {
	await page.goto(`${cloud}/agents?view=all`);
	await page.waitForURL(`${cloud}/sign-in?**`);
	const target = new URL(page.url()).searchParams.get("redirect_url");
	expect(target).toBe("/agents?view=all");
	await page.getByRole("button", { name: "Complete simulated auth return" }).click();
	await expect(page).toHaveURL(`${cloud}/agents?view=all`);
	await expect(page.getByTestId("dashboard-page-content")).toBeVisible();
});
