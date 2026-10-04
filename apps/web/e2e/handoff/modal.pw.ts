import { expect } from "@playwright/test";
import { basicPlan, stubHostedApi } from "../hosted-stub-api";
import { cloud, isolateNetwork, marketing, observeCloudHandoff, test } from "./fixtures";

const authModal = "Clerk fixture sign in";

for (const signup of [false, true]) {
	test(`x402 status ${signup ? "signup" : "login"} modal returns to the exact public page`, async ({
		page,
	}) => {
		const target = `${marketing}/x402?utm_source=modal#setup`;
		await page.goto(target);
		await page.getByRole("link", { name: "Refresh state" }).click();
		await expect(page.getByRole("dialog", { name: authModal })).toBeVisible();
		await expect(page).toHaveURL(target);
		await page
			.getByRole("button", {
				name: `Complete modal ${signup ? "sign up" : "sign in"}`,
				exact: true,
			})
			.click();
		await expect(page).toHaveURL(target);
		await expect(page.getByRole("button", { name: "Refresh state" })).toBeVisible();
		await expect(page.getByRole("dialog", { name: authModal })).toHaveCount(0);
	});
}
const marketingActions = [
	{ path: "/", target: "deploy" },
	{ path: "/home", target: "dashboard", navbar: true },
	{ path: "/home", target: "deploy" },
	{ path: "/openclaw", target: "deploy" },
	{ path: "/hermes", target: "deploy" },
	{ path: "/pricing", target: "deploy" },
	{ path: "/x402", target: "x402" },
];

test("x402 status signed-in refresh reads account again without navigation or auth modal", async ({
	page,
	context,
}) => {
	await context.addCookies([{ name: "test-user", value: "account-a", url: marketing }]);
	let reads = 0;
	await page.route("http://127.0.0.1:8002/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/deployments")) {
			reads++;
			return route.fulfill({ json: [] });
		}
		return route.fulfill({ json: {} });
	});
	const target = `${marketing}/x402?utm_source=modal#setup`;
	await page.goto(target);
	await expect.poll(() => reads).toBeGreaterThan(0);
	const before = reads;
	const documents: string[] = [];
	page.on("request", (request) => {
		if (request.isNavigationRequest()) documents.push(request.url());
	});
	await page.getByRole("button", { name: "Refresh state" }).click();
	await expect.poll(() => reads).toBeGreaterThan(before);
	await expect(page).toHaveURL(target);
	expect(documents).toEqual([]);
	await expect(page.getByRole("dialog", { name: authModal })).toHaveCount(0);
});

test.beforeEach(async ({ context, page }) => {
	await isolateNetwork(context);
	await stubHostedApi(page, { plans: [basicPlan] });
});

test("marketing CTA without JavaScript retains protected login fallback", async ({ browser }) => {
	const context = await browser.newContext({ javaScriptEnabled: false });
	try {
		await isolateNetwork(context);
		const page = await context.newPage();
		await page.goto(`${marketing}/hermes`);
		await page.locator('a[href="/api/cloud-handoff?target=deploy"]').first().click();
		await expect(page).toHaveURL(`${cloud}/sign-in?redirect_url=%2Fdeploy`);
		await expect(page.getByRole("dialog", { name: authModal })).toHaveCount(0);
	} finally {
		await context.close();
	}
});

for (const signup of [false, true]) {
	test(`dedicated ${signup ? "signup" : "login"} preserves CLI return query and fragment`, async ({
		page,
	}) => {
		const target = "/cli-authorize?code=fixture&deploy_profile=sui#authorization";
		await page.goto(
			`${cloud}/${signup ? "sign-up" : "sign-in"}?redirect_url=${encodeURIComponent(target)}`,
		);
		await page.getByRole("button", { name: "Complete simulated auth return" }).click();
		await expect(page).toHaveURL(`${cloud}${target}`);
	});
}

for (const action of marketingActions) {
	for (const signup of [false, true]) {
		test(`${action.path} ${action.target} ${signup ? "signup" : "login"} modal keeps page until auth and resumes intent`, async ({
			page,
			context,
		}) => {
			const destinations: URL[] = [];
			observeCloudHandoff(context, destinations);
			await page.goto(`${marketing}${action.path}`);
			const link = page
				.locator(
					`${action.navbar ? "header " : ""}a[href="/api/cloud-handoff?target=${action.target}"]`,
				)
				.first();
			await expect(link).toBeVisible();
			const documents: string[] = [];
			page.on("request", (request) => {
				if (request.isNavigationRequest()) documents.push(request.url());
			});
			await link.click();
			await expect(page.getByRole("dialog", { name: authModal })).toBeVisible();
			await expect(page).toHaveURL(`${marketing}${action.path}`);
			expect(documents).toEqual([]);
			await page.getByRole("button", { name: "Dismiss auth modal" }).click();
			await expect(page.getByRole("dialog", { name: authModal })).toHaveCount(0);
			await expect(page).toHaveURL(`${marketing}${action.path}`);
			expect(destinations).toEqual([]);
			await link.click();
			// Model availability of the new Clerk session on Cloud while keeping
			// the two SDK fixtures' cookies independent (disagreement tests remain).
			await context.addCookies([{ name: "test-user", value: "account-a", url: cloud }]);
			await page
				.getByRole("button", {
					name: `Complete modal ${signup ? "sign up" : "sign in"}`,
					exact: true,
				})
				.click();
			const target =
				action.target === "dashboard"
					? "/"
					: action.target === "x402"
						? "/deploy?ref=monad&utm_source=x402&utm_campaign=agent_payments"
						: "/deploy";
			await expect(page).toHaveURL(`${cloud}${target}`);
			expect(destinations).toHaveLength(1);
			expect(destinations[0]?.pathname).toBe(
				action.target === "dashboard" ? "/dashboard" : "/deploy",
			);
		});
	}
}

test("marketing signed-in CTA goes straight through handoff without opening auth", async ({
	context,
	page,
}) => {
	await context.addCookies(
		[marketing, cloud].map((url) => ({ name: "test-user", value: "account-a", url })),
	);
	await page.goto(`${marketing}/pricing`);
	await page.locator('a[href="/api/cloud-handoff?target=deploy"]').first().click();
	await expect(page).toHaveURL(`${cloud}/deploy`);
	await expect(page.getByRole("dialog", { name: authModal })).toHaveCount(0);
});

test("modified marketing click uses secure new-tab fallback without opening a modal", async ({
	page,
	context,
}) => {
	await page.goto(`${marketing}/openclaw`);
	const popupPromise = context.waitForEvent("page");
	await page
		.locator('a[href="/api/cloud-handoff?target=deploy"]')
		.first()
		.click({ modifiers: ["Control"] });
	const popup = await popupPromise;
	await expect(popup).toHaveURL(`${cloud}/sign-in?redirect_url=%2Fdeploy`);
	await expect(page).toHaveURL(`${marketing}/openclaw`);
	await expect(page.getByRole("dialog", { name: authModal })).toHaveCount(0);
	await popup.close();
});

for (const signup of [false, true]) {
	test(`modal ${signup ? "signup" : "login"} preserves channel and trial cookies through handoff`, async ({
		page,
		context,
		offerRequests,
	}) => {
		await page.goto(`${marketing}/sui`);
		await page.goto(`${marketing}/pricing`);
		const token = (await context.cookies()).find(
			(cookie) => cookie.name === "clawdi-trial-offer",
		)?.value;
		expect(token).toBeTruthy();
		await page.locator('a[href="/api/cloud-handoff?target=deploy"]').first().click();
		await expect(page.getByRole("dialog", { name: authModal })).toBeVisible();
		await context.addCookies([{ name: "test-user", value: "account-a", url: cloud }]);
		await page
			.getByRole("button", {
				name: `Complete modal ${signup ? "sign up" : "sign in"}`,
				exact: true,
			})
			.click();
		await expect(page).toHaveURL(`${cloud}/deploy?deploy_profile=sui`);
		await expect(page.getByRole("button", { name: /Sui bundle/ })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect
			.poll(() => offerRequests)
			.toContainEqual({ token, authorization: "Bearer account-a" });
		expect(
			(await context.cookies()).find(
				(cookie) => cookie.name === "clawdi-trial-offer" && cookie.domain === "localhost",
			)?.value,
		).toBe(token);
	});
}

for (const signup of [false, true]) {
	test(`Cloud invitation ${signup ? "signup" : "login"} modal resumes exact query and hash without accepting for guest`, async ({
		page,
	}) => {
		let upgrades = 0;
		await page.route("**/v1/share/modal-invitation/**", async (route) => {
			if (route.request().url().endsWith("/upgrade")) {
				upgrades++;
				return route.fulfill({ status: 403, json: {} });
			}
			return route.fulfill({
				json: {
					project_id: "modal-project",
					project_name: "Modal Project",
					owner_display: "Alex",
					owner_handle: "alex",
					skill_count: 1,
					vault_count: 0,
					vault_locked: false,
				},
			});
		});
		const target = `${cloud}/share/modal-invitation?deploy_profile=sui#invitation`;
		await page.goto(target);
		await expect(page.locator("html")).toHaveAttribute("data-clerk-fixture-loaded", "true");
		await expect(page.getByRole("button", { name: "Sign in to accept" })).toBeVisible();
		await page.getByRole("button", { name: "Sign in to accept" }).click();
		await expect(page.getByRole("dialog", { name: authModal })).toBeVisible();
		await expect(page).toHaveURL(target);
		await page.getByRole("button", { name: "Dismiss auth modal" }).click();
		await expect(page).toHaveURL(target);
		expect(upgrades).toBe(0);
		await page.getByRole("button", { name: "Sign in to accept" }).click();
		await page
			.getByRole("button", {
				name: `Complete modal ${signup ? "sign up" : "sign in"}`,
				exact: true,
			})
			.click();
		await expect(page).toHaveURL(target);
		await expect(page.getByRole("button", { name: "Accept invitation" })).toBeEnabled();
		await expect(page.getByRole("dialog", { name: authModal })).toHaveCount(0);
		expect(upgrades).toBe(0);
	});
}

for (const share of [
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
]) {
	for (const signup of [false, true]) {
		test(`Cloud ${share.startsWith("111") ? "share header" : "private share gate"} ${signup ? "signup" : "login"} returns to original share`, async ({
			page,
		}) => {
			const target = `${cloud}/s/${share}?view=all#messages`;
			await page.goto(target);
			await expect(page.locator("html")).toHaveAttribute("data-clerk-fixture-loaded", "true");
			await expect(
				page.getByRole(share.startsWith("111") ? "button" : "link", {
					name: "Sign in",
					exact: true,
				}),
			).toBeVisible();
			await page
				.getByRole(share.startsWith("111") ? "button" : "link", { name: "Sign in", exact: true })
				.click();
			await expect(page.getByRole("dialog", { name: authModal })).toBeVisible();
			await expect(page).toHaveURL(target);
			await page
				.getByRole("button", {
					name: `Complete modal ${signup ? "sign up" : "sign in"}`,
					exact: true,
				})
				.click();
			await expect(page).toHaveURL(target);
			await expect(page.getByRole("dialog", { name: authModal })).toHaveCount(0);
			if (share.startsWith("111"))
				await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
			else await expect(page.getByText("You don't have access", { exact: false })).toBeVisible();
		});
	}
}
