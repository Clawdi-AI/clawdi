import { expect, type Page } from "@playwright/test";
import { basicPlan, stubHostedApi } from "../hosted-stub-api";
import { cloud, isolateNetwork, marketing, observeCloudHandoff, test } from "./fixtures";

async function expectDeploymentEnabled(page: Page) {
	await page.getByRole("button", { name: /^Configure inside agent/ }).click();
	await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
}

for (const signup of [false, true]) {
	test(`/sui → ${signup ? "sign-up with opt-out" : "sign-in"} → deployment payload`, async ({
		browser,
	}) => {
		const context = await browser.newContext();
		await isolateNetwork(context);
		observeCloudHandoff(context);
		const page = await context.newPage();
		const checkoutRequests: string[] = [];
		await stubHostedApi(page, { plans: [basicPlan], checkoutRequests });
		const settingsWrites: string[] = [];
		page.on("request", (request) => {
			if (new URL(request.url()).pathname === "/v1/settings" && request.method() === "PATCH")
				settingsWrites.push(request.postData() ?? "");
		});
		const landing = await page.goto(`${marketing}/sui`);
		expect(landing?.status()).toBe(200);
		await expect(page).toHaveURL(`${marketing}/?deploy_profile=sui`);
		const cookie = (await context.cookies()).find((item) => item.name === "clawdi-deploy-intent");
		expect(cookie?.httpOnly).toBe(true);
		expect(cookie?.sameSite).toBe("Lax");
		await page.goto(`${marketing}/openclaw`);
		await expect(page).toHaveURL(`${marketing}/openclaw`);
		expect((await context.cookies()).find((item) => item.name === cookie?.name)?.value).toBe(
			cookie?.value,
		);
		await page.locator('a[href="/api/cloud-handoff?target=deploy"]').first().click();
		await expect(page.getByRole("dialog", { name: "Clerk fixture sign in" })).toBeVisible();
		await expect(page).toHaveURL(`${marketing}/openclaw`);
		await page
			.getByRole("button", {
				name: `Complete modal ${signup ? "sign up" : "sign in"}`,
				exact: true,
			})
			.click();
		await page.waitForURL(`${cloud}/sign-in?**`);
		expect(new URL(page.url()).searchParams.get("redirect_url")).toBe("/deploy?deploy_profile=sui");
		if (signup) await page.getByRole("link", { name: "Sign up instead" }).click();
		await page.getByRole("button", { name: "Complete simulated auth return" }).click();
		const bundle = page.getByRole("button", { name: /Sui bundle/ });
		await expect(bundle).toHaveAttribute("aria-pressed", "true");
		await expect(page).toHaveURL(`${cloud}/deploy?deploy_profile=sui`);
		if (signup) {
			await bundle.click();
			await expect(bundle).toHaveAttribute("aria-pressed", "false");
		}
		await expectDeploymentEnabled(page);
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect.poll(() => checkoutRequests.length).toBe(1);
		const payload = JSON.parse(checkoutRequests[0] ?? "{}");
		if (signup) expect(payload.deploy_config).not.toHaveProperty("plugin_bundle");
		else expect(payload.deploy_config).toHaveProperty("plugin_bundle", "sui");
		expect(settingsWrites).toEqual([]);
		await context.close();
	});
}

test("server capture and handoff need no JavaScript and reject expired cookies", async ({
	browser,
}) => {
	const context = await browser.newContext({ javaScriptEnabled: false });
	const entry = await context.request.get(`${marketing}/sui`, { maxRedirects: 0 });
	expect(entry.status()).toBe(303);
	expect(entry.headers().location).toBe("/?deploy_profile=sui");
	await context.request.get(`${marketing}/sui?deploy_profile=sui&deploy_profile=sui`);
	const cookie = (await context.cookies()).find((item) => item.name === "clawdi-deploy-intent");
	expect(cookie?.httpOnly).toBe(true);
	const handoff = await context.request.get(`${marketing}/api/cloud-handoff?target=deploy`, {
		maxRedirects: 0,
	});
	expect(handoff.headers()["x-fixture-cloud-location"]).toBe(
		"https://cloud.clawdi.ai/deploy?deploy_profile=sui",
	);
	expect(handoff.headers()["set-cookie"]).toBeUndefined();
	const authRedirect = await context.request.get(`${cloud}/deploy?deploy_profile=sui`, {
		maxRedirects: 0,
	});
	expect(authRedirect.headers().location).toBe(
		"/sign-in?redirect_url=%2Fdeploy%3Fdeploy_profile%3Dsui",
	);
	await context.addCookies([
		{
			name: "clawdi-deploy-intent",
			value: "sui",
			expires: Math.floor(Date.now() / 1000) - 1,
			url: marketing,
			httpOnly: true,
		},
	]);
	const expired = await context.request.get(`${marketing}/api/cloud-handoff?target=deploy`, {
		maxRedirects: 0,
	});
	expect(expired.headers()["x-fixture-cloud-location"]).toBe("https://cloud.clawdi.ai/deploy");
	await context.clearCookies();
	const unavailable = await context.request.get(`${marketing}/api/cloud-handoff?target=deploy`, {
		maxRedirects: 0,
	});
	expect(unavailable.headers()["x-fixture-cloud-location"]).toBe("https://cloud.clawdi.ai/deploy");
	await context.close();
});

test("unknown, duplicate and absent sources hide the recommendation", async ({ browser }) => {
	const context = await browser.newContext();
	await isolateNetwork(context);
	await context.addCookies([{ name: "test-user", value: "account-a", url: cloud }]);
	const page = await context.newPage();
	await stubHostedApi(page, { plans: [basicPlan] });
	let settingsWrites = 0;
	await page.route("http://127.0.0.1:8000/v1/settings", async (route) => {
		if (route.request().method() === "PATCH") settingsWrites++;
		await route.fulfill({ json: {} });
	});
	for (const search of [
		"",
		"?deploy_profile=unknown&utm_source=sui",
		"?deploy_profile=sui&deploy_profile=sui",
	]) {
		await context.request.get(`${marketing}/${search}`);
		expect((await context.cookies()).some((cookie) => cookie.name === "clawdi-deploy-intent")).toBe(
			false,
		);
		await page.goto(`${cloud}/deploy${search}`);
		await expectDeploymentEnabled(page);
		await expect(page.getByRole("button", { name: /Sui bundle/ })).toHaveCount(0);
	}
	expect(settingsWrites).toBe(0);
	await context.close();
});

for (const scenario of [
	{ search: "?deploy_profile=sui", sidebar: false, signedIn: true, recommended: true },
	{ search: "?deploy_profile=sui", sidebar: true, signedIn: true, recommended: true },
	{ search: "?deploy_profile=sui", sidebar: false, signedIn: false, recommended: true },
	{ search: "", sidebar: false, signedIn: true, recommended: false },
	{ search: "?utm_source=sui", sidebar: true, signedIn: true, recommended: true },
	{
		search: "?deploy_profile=unknown&utm_source=sui",
		sidebar: true,
		signedIn: true,
		recommended: false,
	},
]) {
	test(`Cloud home ${scenario.search || "plain"} → ${scenario.sidebar ? "sidebar" : "overview"} deploy (${scenario.signedIn ? "signed in" : "login"})`, async ({
		browser,
	}) => {
		const context = await browser.newContext();
		await isolateNetwork(context);
		if (scenario.signedIn)
			await context.addCookies([{ name: "test-user", value: "account-a", url: cloud }]);
		const page = await context.newPage();
		await stubHostedApi(page, { plans: [basicPlan] });
		await page.goto(`${cloud}/${scenario.search}`);
		if (!scenario.signedIn) {
			await page.waitForURL(`${cloud}/sign-in?**`);
			expect(new URL(page.url()).searchParams.get("redirect_url")).toBe(`/${scenario.search}`);
			await page.getByRole("button", { name: "Complete simulated auth return" }).click();
		}
		await expect(page).toHaveURL(`${cloud}/${scenario.search}`);
		// Intermediate navigation and reload must retain the URL intent without per-link wiring.
		await page.getByRole("link", { name: "Agents", exact: true }).click();
		await expect(page).toHaveURL(`${cloud}/agents${scenario.search}`);
		await page.reload();
		await page.getByRole("link", { name: "Overview", exact: true }).click();
		await expect(page).toHaveURL(`${cloud}/${scenario.search}`);
		if (scenario.sidebar) {
			await page.getByRole("button", { name: "New agent", exact: true }).first().click();
			await page
				.getByRole("dialog")
				.getByRole("button", { name: /Deploy a Cloud Agent/ })
				.click();
		} else {
			const link = page.getByRole("button", { name: "Deploy a Cloud Agent", exact: true });
			await expect(link).toHaveAttribute("href", `/deploy${scenario.search}`);
			await link.click();
		}
		await expect(page).toHaveURL(`${cloud}/deploy${scenario.search}`);
		await expectDeploymentEnabled(page);
		const bundle = page.getByRole("button", { name: /Sui bundle/ });
		if (scenario.recommended) await expect(bundle).toHaveAttribute("aria-pressed", "true");
		else await expect(bundle).toHaveCount(0);
		// A fresh URL without the parameters clears the intent; there is no hidden persistence.
		await page.goto(`${cloud}/deploy`);
		await expectDeploymentEnabled(page);
		await expect(page.getByRole("button", { name: /Sui bundle/ })).toHaveCount(0);
		await context.close();
	});
}
