import { expect, type Page, type Route, test } from "@playwright/test";

// HOSTED (Clawdi Cloud) smoke against the vite dev server with dev-auth-bypass
// (NO Clerk key needed) + deploy-api enabled so /deploy renders. Exercises the
// deploy wizard's Base UI Select asserting ZERO browser console/page errors.
//
// IMPORTANT: stub by API HOST, never with broad "**/v2/**" globs — the app's
// own modules live under /src/hosted/v2/... and a path glob would intercept
// them and break module loading.

const me = { capabilities: { can_use_v1: false, can_use_v2: true } };
const emptyPage = { items: [], total: 0, page: 1, page_size: 25 };

// Must match the API hosts configured in playwright.hosted.config.ts.
const CLOUD_API = "http://127.0.0.1:8000";
const DEPLOY_API = "http://127.0.0.1:8001";

const basicPlan = {
	slug: "compute_basic",
	name: "Basic",
	price_cents: 900,
	points_per_usd: 100,
	signup_grant_credits: 500,
	subscription_grant_credits: 0,
	vcpu: 1,
	ram_gb: 2,
	disk_size: 20,
	offers: [
		{
			billing_term_months: 1,
			price_cents: 900,
			effective_monthly_price_cents: 900,
			discount_percent: 0,
		},
		{
			billing_term_months: 12,
			price_cents: 9_000,
			effective_monthly_price_cents: 750,
			discount_percent: 17,
		},
	],
};

const performancePlan = {
	slug: "compute_performance",
	name: "Performance",
	price_cents: 1_900,
	points_per_usd: 100,
	signup_grant_credits: 500,
	subscription_grant_credits: 500,
	vcpu: 4,
	ram_gb: 8,
	disk_size: 80,
	offers: [
		{
			billing_term_months: 1,
			price_cents: 1_900,
			effective_monthly_price_cents: 1_900,
			discount_percent: 0,
		},
		{
			billing_term_months: 12,
			price_cents: 19_000,
			effective_monthly_price_cents: 1_583,
			discount_percent: 17,
		},
	],
};

const includedBasicDeployment = {
	id: "hdep_included",
	user_id: "usr_browser",
	name: "Included Basic",
	app_id: "v2-browser",
	status: "running",
	created_at: "2026-07-15T00:00:00Z",
	upgrade_available: true,
	compute_subscription: null,
	config_info: {
		compute_plan_slug: "compute_basic",
		mux_enabled: false,
		telegram_mux_enabled: false,
		discord_mux_enabled: false,
		whatsapp_mux_enabled: false,
		imessage_mux_enabled: false,
		kobb_available: false,
		ai_provider_auth_kind: "managed",
		runtime: "hermes",
		clawdi_cloud_environments: {},
		ai_provider_bindings: {},
		public_ports: [],
	},
};

const paidBasicDeployment = {
	...includedBasicDeployment,
	id: "hdep_paid",
	name: "Paid Basic",
	compute_subscription: {
		status: "active",
		payment_state: "ok",
		billing_term_months: 12,
		price_cents: 9_000,
		currency: "usd",
		cancel_at_period_end: false,
	},
};

type HostedApiStubOptions = {
	checkoutRequests?: string[];
	createRequests?: string[];
	deployments?: readonly unknown[];
	plans?: readonly unknown[];
};

async function fulfillJson(route: Route, body: unknown) {
	await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function stubHostedApi(page: Page, options: HostedApiStubOptions = {}) {
	const deployments = options.deployments ?? [];
	const plans = options.plans ?? [];
	// Deploy API (/me, /v2/*).
	await page.route(`${DEPLOY_API}/**`, (r) => {
		const p = new URL(r.request().url()).pathname;
		if (p === "/me" || p === "/v1/me") return fulfillJson(r, me);
		if (p === "/v2/subscription/plans") return fulfillJson(r, plans);
		if (p === "/v2/deployments" && r.request().method() === "GET") {
			return fulfillJson(r, deployments);
		}
		if (p === "/v2/deployments" && r.request().method() === "POST") {
			options.createRequests?.push(r.request().postData() ?? "");
			return fulfillJson(r, {
				...includedBasicDeployment,
				id: "hdep_created",
				name: "Created Basic",
				status: "starting",
			});
		}
		if (p === "/v2/subscription/checkout" && r.request().method() === "POST") {
			options.checkoutRequests?.push(r.request().postData() ?? "");
			return fulfillJson(r, {
				flow_type: "checkout_session",
				action_url: null,
				checkout_url: "http://127.0.0.1:3100/deploy?mockCheckout=browser",
				client_secret: null,
			});
		}
		return fulfillJson(r, {});
	});
	// Cloud API (/v1/*).
	await page.route(`${CLOUD_API}/**`, (r) => {
		const p = new URL(r.request().url()).pathname;
		if (p === "/v1/me") return fulfillJson(r, me);
		if (p === "/v1/agents") return fulfillJson(r, []);
		if (p === "/v1/ai-providers") return fulfillJson(r, { providers: [] });
		if (p === "/v1/channels") return fulfillJson(r, []);
		if (p === "/v1/channels/bot-pool") return fulfillJson(r, { providers: {} });
		if (p === "/v1/channels/health") return fulfillJson(r, { items: [] });
		if (p === "/v1/projects") return fulfillJson(r, []);
		if (p === "/v1/sessions") return fulfillJson(r, emptyPage);
		if (p === "/v1/auth/keys") return fulfillJson(r, []);
		return fulfillJson(r, {});
	});
}

async function expectNoQuarterlyCopy(page: Page) {
	await expect(page.getByText("Quarterly", { exact: true })).toHaveCount(0);
	await expect(page.getByText(/\/qtr/)).toHaveCount(0);
}

async function capturePricingScreenshot(page: Page, path: string) {
	await page.addStyleTag({
		content: `
			* { animation: none !important; transition: none !important; }
			::view-transition-old(root), ::view-transition-new(root) {
				animation: none !important;
			}
		`,
	});
	const basicCard = page.getByRole("button", { name: /^Basic/ });
	await basicCard.evaluate((element) => {
		element.scrollIntoView({ block: "center", inline: "nearest" });
	});
	await page.waitForTimeout(1_000);
	await basicCard.locator("xpath=ancestor::section[1]").screenshot({ path });
}

function collectBrowserErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	page.on("pageerror", (e) => {
		errors.push(e.message);
	});
	return errors;
}

async function expectNonZeroBox(locator: ReturnType<Page["locator"]>, label: string) {
	const box = await locator.boundingBox();
	expect(box, `${label} should render a layout box`).not.toBeNull();
	expect(box?.width, `${label} width`).toBeGreaterThan(0);
	expect(box?.height, `${label} height`).toBeGreaterThan(0);
}

test("deploy wizard Select opens without browser errors", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page);
	await page.goto("/deploy");

	// The Personalize section's language select is always present.
	const languageSelect = page.locator("#agent-language");
	await expect(languageSelect).toBeVisible();
	await page.waitForTimeout(150);
	expect(errors, `deploy render: ${errors.join(" | ")}`).toEqual([]);

	// Open the Base UI Select popup and pick an option.
	await languageSelect.click();
	await expect(page.getByRole("option").first()).toBeVisible();
	await page.getByRole("option").first().click();
	await page.waitForTimeout(150);
	expect(errors, `language select: ${errors.join(" | ")}`).toEqual([]);
});

test("paid-funded Basic leaves the included slot available for direct compute_basic deploy", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const createRequests: string[] = [];
	await page.setViewportSize({ width: 1_440, height: 1_100 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await stubHostedApi(page, {
		createRequests,
		deployments: [paidBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");

	await expect(page.getByText("First slot free", { exact: true })).toBeVisible();
	await expect(
		page.getByText(/First active agent free · then \$9\/mo per additional agent/),
	).toBeVisible();
	await expectNoQuarterlyCopy(page);
	await capturePricingScreenshot(page, "/tmp/basic-paid-funded-slot-available-final.png");

	await page.getByRole("button", { name: "Deploy agent" }).click();
	await expect.poll(() => createRequests.length).toBe(1);
	expect(JSON.parse(createRequests[0] ?? "{}")).toMatchObject({
		compute_plan_slug: "compute_basic",
	});
	expect(errors, `direct Basic deploy: ${errors.join(" | ")}`).toEqual([]);
});

test("free-funded Basic uses annual compute_basic checkout when the included slot is occupied", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const checkoutRequests: string[] = [];
	await page.setViewportSize({ width: 1_440, height: 1_100 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await stubHostedApi(page, {
		checkoutRequests,
		deployments: [includedBasicDeployment],
		plans: [basicPlan, performancePlan],
	});
	await page.goto("/deploy");
	await page.waitForLoadState("networkidle");

	await expect(page.getByText("$9/mo additional", { exact: true })).toBeVisible();
	await expect(page.getByText("Monthly", { exact: true })).toBeVisible();
	const annualTerm = page.getByRole("button", { name: /Annual/ });
	await expect(annualTerm).toBeVisible();
	await expectNoQuarterlyCopy(page);
	await annualTerm.click();
	await expect(
		page.getByText(
			/First active agent free · then \$7.5\/mo, billed \$90\/yr per additional agent/,
		),
	).toBeVisible();
	await expect(
		page.getByText(/additional Basic agent at \$7.5\/mo, billed \$90\/yr/),
	).toBeVisible();
	await capturePricingScreenshot(page, "/tmp/basic-free-funded-slot-occupied-final.png");

	await page.getByRole("button", { name: "Continue to checkout" }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	expect(JSON.parse(checkoutRequests[0] ?? "{}")).toMatchObject({
		plan_slug: "compute_basic",
		billing_term_months: 12,
		deploy_config: { compute_plan_slug: "compute_basic" },
	});
	expect(errors, `paid Basic checkout: ${errors.join(" | ")}`).toEqual([]);
});

test("command palette opens with Ctrl+K", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page);
	await page.goto("/channels");
	await expect(page.getByTestId("app-sidebar")).toBeVisible();
	await page.waitForLoadState("networkidle");

	await page.keyboard.press("Control+K");
	await expect(page.locator('[data-slot="command"]')).toBeVisible();
	await page.waitForTimeout(150);
	expect(errors, `command palette: ${errors.join(" | ")}`).toEqual([]);
});

test("channels connect dialog opens without browser errors", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	await stubHostedApi(page);
	await page.goto("/channels");

	const connect = page.getByRole("button", { name: /connect a bot/i }).first();
	await expect(connect).toBeVisible();
	await page.waitForTimeout(150);
	expect(errors, `channels render: ${errors.join(" | ")}`).toEqual([]);

	await expect(page.locator('[data-slot="tabs-list"]')).toHaveCount(0);
	await expect(page.getByText("Your channels").first()).toBeVisible();
	await expect(page.getByText("Shared bots").first()).toBeVisible();
	await expectNonZeroBox(page.locator('[data-sidebar="separator"]').first(), "sidebar separator");

	// Open the Base UI Dialog + interact with its provider picker.
	await connect.click();
	await expect(page.locator('[data-slot="dialog-content"]').first()).toBeVisible();
	await page.waitForTimeout(150);
	expect(errors, `connect dialog: ${errors.join(" | ")}`).toEqual([]);
});
