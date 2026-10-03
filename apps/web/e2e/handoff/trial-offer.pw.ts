import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { basicPlan, stubHostedApi } from "../hosted-stub-api";

// Only the private service boundary is simulated. Auth return, cookies, server
// functions, the wizard, and checkout request construction use the real app.
const offerApi = createServer((request, response) => {
	if (request.url !== "/v2/subscription/trial-offer") {
		response.writeHead(404).end();
		return;
	}
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify({ available: true, expires_at: "2099-01-01T00:00:00Z" }));
});

test.beforeAll(
	() =>
		new Promise<void>((resolve, reject) => {
			offerApi.once("error", reject);
			offerApi.listen(8001, "127.0.0.1", resolve);
		}),
);
test.afterAll(
	() =>
		new Promise<void>((resolve, reject) => {
			offerApi.close((error) => (error ? reject(error) : resolve()));
		}),
);

test("trial offer survives login and uses checkout without asking for a card", async ({
	page,
	context,
}) => {
	const checkoutRequests: string[] = [];
	const checkoutIdempotencyKeys: string[] = [];
	await stubHostedApi(page, {
		plans: [
			{
				...basicPlan,
				offers: basicPlan.offers.map((offer) => ({ ...offer, card_trial_period_days: 7 })),
			},
		],
		checkoutRequests,
		checkoutIdempotencyKeys,
	});
	await page.goto("/trial-offer?token=opaque_credential&target=sign-in");
	await expect(page).toHaveURL(/\/sign-in\?redirect_url=/);
	const cookie = (await context.cookies()).find((value) => value.name === "clawdi-trial-offer");
	expect(cookie?.httpOnly).toBe(true);
	expect(cookie?.sameSite).toBe("Lax");
	await page.getByRole("button", { name: "Complete simulated auth return" }).click();
	await expect(page).toHaveURL("http://localhost:3200/deploy");
	await expect(page.getByRole("button", { name: /^Free trial/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByText("No card required", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: /^Configure inside agent/ }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await expect.poll(() => checkoutRequests.length).toBe(1);
	const checkout = JSON.parse(checkoutRequests[0] ?? "{}");
	expect(checkout.ui_mode).toBe("hosted");
	expect(checkout.funding_source).toBe("stripe");
	expect(checkout.deploy_config.trial_offer_token).toBe("opaque_credential");

	await page.reload();
	await expect(page.getByRole("button", { name: /^Free trial/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.getByRole("button", { name: /^Configure inside agent/ }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await expect.poll(() => checkoutRequests.length).toBe(2);
	expect(checkoutIdempotencyKeys[1]).toBe(checkoutIdempotencyKeys[0]);
	expect(JSON.parse(checkoutRequests[1] ?? "{}").deploy_config.trial_offer_token).toBe(
		"opaque_credential",
	);
	expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain("opaque_credential");
});
