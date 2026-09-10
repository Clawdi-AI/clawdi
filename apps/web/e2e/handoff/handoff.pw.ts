import { type BrowserContext, expect, test } from "@playwright/test";
import { stubHostedApi } from "../hosted-stub-api";

const marketing = "http://marketing:3000";
const cloud = "http://localhost:3200";

async function isolateNetwork(context: BrowserContext) {
	await context.route("**/*", (route) => {
		const host = new URL(route.request().url()).hostname;
		return ["marketing", "localhost", "127.0.0.1"].includes(host)
			? route.continue()
			: route.abort();
	});
}

test("server marketing capture survives browsing and a real app auth return", async ({
	browser,
}) => {
	const context = await browser.newContext();
	await isolateNetwork(context);
	// Inspect the real local response without following its production redirect.
	await context.route(`${marketing}/api/cloud-handoff?**`, async (route) => {
		const response = await route.fetch({ maxRedirects: 0 });
		const target = new URL(response.headers().location);
		expect(target.origin).toBe("https://cloud.clawdi.ai");
		await route.fulfill({
			status: 303,
			headers: { location: `${cloud}${target.pathname}${target.search}` },
		});
	});
	const page = await context.newPage();
	await page.goto(`${marketing}/?deploy_profile=sui`);
	const cookie = (await context.cookies()).find((item) => item.name === "clawdi-deploy-intent");
	expect(cookie?.httpOnly).toBe(true);
	expect(cookie?.sameSite).toBe("Lax");
	await page.getByRole("link", { name: "OpenClaw", exact: true }).first().click();
	await page.goto(`${marketing}/zh/openclaw`);
	expect((await context.cookies()).find((item) => item.name === cookie?.name)?.value).toBe(
		cookie?.value,
	);
	await page.locator('a[href="/api/cloud-handoff?target=deploy"]').first().click();
	await page.waitForURL(`${cloud}/sign-in?**`, { timeout: 30_000 });
	expect(new URL(page.url()).searchParams.get("redirect_url")).toBe("/deploy?deploy_profile=sui");
	const authReturn = page.url();
	const app = page;
	await stubHostedApi(app);
	let claims = 0;
	let channel: string | null = null;
	await app.route("http://127.0.0.1:8000/v1/settings", async (route) => {
		if (route.request().method() === "PATCH") {
			expect(route.request().headers().authorization).toBe("Bearer account-a");
			claims++;
			channel = route.request().postDataJSON().settings.deploy_channel;
			await route.fulfill({ json: { status: "updated" } });
		} else
			await route.fulfill({
				json:
					channel && route.request().headers().authorization === "Bearer account-a"
						? { deploy_channel: channel }
						: {},
			});
	});
	await app.goto(authReturn);
	await app.getByRole("link", { name: "Sign up instead" }).click();
	await app.getByRole("link", { name: "Sign in instead" }).click();
	await app.getByRole("button", { name: "Complete simulated auth return" }).click();
	const bundle = app.getByRole("checkbox", { name: /Sui bundle/ });
	await expect(bundle).toBeChecked();
	await expect.poll(() => claims).toBe(1);
	await expect(app).toHaveURL(`${cloud}/deploy`);
	await bundle.uncheck();
	await expect(bundle).not.toBeChecked();
	await app.reload();
	await expect(bundle).toBeChecked();
	expect(claims).toBe(1);
	await context.addCookies([{ name: "test-user", value: "account-b", url: cloud }]);
	await app.goto(`${cloud}/deploy`);
	await expect(app.getByRole("heading", { name: "Deploy an Agent" })).toBeVisible();
	await expect(bundle).toHaveCount(0);
	expect(claims).toBe(1);
	await context.close();
});

test("server capture and handoff need no JavaScript and reject expired cookies", async ({
	browser,
}) => {
	const context = await browser.newContext({ javaScriptEnabled: false });
	await context.request.get(`${marketing}/?utm_source=sui`);
	const cookie = (await context.cookies()).find((item) => item.name === "clawdi-deploy-intent");
	expect(cookie?.httpOnly).toBe(true);
	const handoff = await context.request.get(`${marketing}/api/cloud-handoff?target=deploy`, {
		maxRedirects: 0,
	});
	expect(handoff.headers().location).toBe("https://cloud.clawdi.ai/deploy?deploy_profile=sui");
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
	expect(expired.headers().location).toBe("https://cloud.clawdi.ai/deploy");
	await context.clearCookies();
	const unavailable = await context.request.get(`${marketing}/api/cloud-handoff?target=deploy`, {
		maxRedirects: 0,
	});
	expect(unavailable.headers().location).toBe("https://cloud.clawdi.ai/deploy");
	await context.close();
});

test("claim wins over a delayed settings read and survives disabled browser storage", async ({
	browser,
}) => {
	const context = await browser.newContext();
	await isolateNetwork(context);
	await context.addCookies([{ name: "test-user", value: "account-a", url: cloud }]);
	await context.addInitScript(() => {
		Object.defineProperty(window, "sessionStorage", {
			get() {
				throw new DOMException("Disabled", "SecurityError");
			},
		});
	});
	const page = await context.newPage();
	await stubHostedApi(page);
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	let claims = 0;
	await page.route("http://127.0.0.1:8000/v1/settings", async (route) => {
		if (route.request().method() === "PATCH") {
			claims++;
			await route.fulfill({ json: { status: "updated" } });
		} else {
			started.resolve();
			await release.promise;
			await route.fulfill({ json: {} });
			finished.resolve();
		}
	});
	await page.goto(`${cloud}/deploy`);
	await started.promise;
	await page.evaluate(() => {
		history.pushState({}, "", "/deploy?deploy_profile=sui");
		window.dispatchEvent(new PopStateEvent("popstate"));
	});
	await expect.poll(() => claims).toBe(1);
	const bundle = page.getByRole("checkbox", { name: /Sui bundle/ });
	await expect(bundle).toBeChecked();
	release.resolve();
	await finished.promise;
	await expect(bundle).toBeChecked();
	expect(claims).toBe(1);
	await expect(page).toHaveURL(`${cloud}/deploy`);
	await context.close();
});

test("direct sign-up normalizes the return URL and failed saves can retry", async ({ browser }) => {
	const context = await browser.newContext();
	await isolateNetwork(context);
	const page = await context.newPage();
	await stubHostedApi(page);
	let claims = 0;
	await page.route("http://127.0.0.1:8000/v1/settings", async (route) => {
		if (route.request().method() === "PATCH") {
			claims++;
			await route.fulfill({
				status: claims === 1 ? 503 : 200,
				json: claims === 1 ? { detail: "Unavailable" } : { status: "updated" },
			});
		} else await route.fulfill({ json: {} });
	});
	await page.goto(`${cloud}/sign-up?deploy_profile=sui`);
	expect(new URL(page.url()).searchParams.get("redirect_url")).toBe("/deploy?deploy_profile=sui");
	await page.getByRole("link", { name: "Sign in instead" }).click();
	await page.getByRole("button", { name: "Complete simulated auth return" }).click();
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByRole("checkbox", { name: /Sui bundle/ })).toBeChecked();
	expect(claims).toBe(2);
	await expect(page).toHaveURL(`${cloud}/deploy`);
	await context.close();
});
