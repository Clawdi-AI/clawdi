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

async function fulfillJson(route: Route, body: unknown) {
	await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function stubHostedApi(page: Page) {
	// Deploy API (/me, /v2/*).
	await page.route(`${DEPLOY_API}/**`, (r) => {
		const p = new URL(r.request().url()).pathname;
		if (p === "/me") return fulfillJson(r, me);
		if (p === "/v2/subscription/plans") return fulfillJson(r, []);
		if (p === "/v2/deployments") return fulfillJson(r, []);
		return fulfillJson(r, {});
	});
	// Cloud API (/v1/*).
	await page.route(`${CLOUD_API}/**`, (r) => {
		const p = new URL(r.request().url()).pathname;
		if (p === "/v1/agents") return fulfillJson(r, []);
		if (p === "/v1/ai-providers") return fulfillJson(r, []);
		if (p === "/v1/channels") return fulfillJson(r, []);
		if (p === "/v1/channels/bot-pool") return fulfillJson(r, { providers: {} });
		if (p === "/v1/channels/health") return fulfillJson(r, { items: [] });
		if (p === "/v1/projects") return fulfillJson(r, []);
		if (p === "/v1/sessions") return fulfillJson(r, emptyPage);
		if (p === "/v1/auth/keys") return fulfillJson(r, []);
		return fulfillJson(r, {});
	});
}

// This smoke guards against Base UI RUNTIME crashes (e.g. the MenuGroupContext
// error that unmounted the sidebar). React hydration-mismatch warnings are a
// separate, pre-existing SSR-nondeterminism concern (not introduced by the Base
// UI migration and unrelated to it), so they are excluded from the assertion.
function isIgnorableWarning(text: string): boolean {
	return /hydrat|didn't match|server rendered HTML/i.test(text);
}

function collectBrowserErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error" && !isIgnorableWarning(m.text())) errors.push(m.text());
	});
	page.on("pageerror", (e) => {
		if (!isIgnorableWarning(e.message)) errors.push(e.message);
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
