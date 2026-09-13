import { expect, type Page, test } from "@playwright/test";
import { gotoHostedSettingsDialog, stubHostedApi } from "./hosted-stub-api";

declare global {
	interface Window {
		__walletCheckoutConfirms: Array<{ express: boolean; redirect: string }>;
	}
}

async function stubCheckout(page: Page) {
	await page.route("https://**/*", (route) => route.abort());
	await page.addInitScript(() => {
		window.__walletCheckoutConfirms = [];
		const event = { expressPaymentType: "apple_pay" };
		const element = (express: boolean) => {
			const handlers = new Map<string, (event: object) => void>();
			let content: HTMLElement | null = null;
			return {
				on: (name: string, handler: (event: object) => void) => handlers.set(name, handler),
				off: (name: string) => handlers.delete(name),
				mount: (node: HTMLElement) => {
					content = document.createElement(express ? "button" : "span");
					content.textContent = express ? "Mock Apple Pay" : "Mock Payment Element fallback";
					if (express) content.onclick = () => handlers.get("confirm")?.(event);
					node.append(content);
				},
				update: () => undefined,
				destroy: () => content?.remove(),
			};
		};
		const mockStripe = Object.assign(
			() => ({
				elements: () => ({}),
				createToken: async () => ({}),
				createPaymentMethod: async () => ({}),
				confirmCardPayment: async () => ({}),
				_registerWrapper: () => undefined,
				initCheckoutElementsSdk: () => ({
					loadActions: async () => ({
						type: "success",
						actions: {
							getSession: () => ({ canConfirm: true, status: { type: "open" } }),
							confirm: async (options: {
								expressCheckoutConfirmEvent?: object;
								redirect: string;
							}) => {
								window.__walletCheckoutConfirms.push({
									express: options.expressCheckoutConfirmEvent === event,
									redirect: options.redirect,
								});
								await new Promise((resolve) => setTimeout(resolve, 300));
								return window.__walletCheckoutConfirms.length === 1
									? { type: "error", error: { message: "Mock wallet declined" } }
									: {
											type: "success",
											session: { status: { type: "complete", paymentStatus: "unpaid" } },
										};
							},
						},
					}),
					on: () => undefined,
					changeAppearance: () => undefined,
					loadFonts: () => undefined,
					createExpressCheckoutElement: () => element(true),
					createPaymentElement: () => element(false),
				}),
			}),
			{ version: "dahlia" },
		);
		Object.defineProperty(window, "Stripe", { configurable: true, value: mockStripe });
	});
}

const started = {
	flow_type: "checkout_session",
	status: "open",
	client_secret: "cs_wallet_secret",
	checkout_session_id: "cs_wallet",
	payment_intent_id: null,
	amount_usd: "25",
};

test("Wallet Express confirmation forwards its event, fences duplicate clicks, and permits retry", async ({
	page,
}) => {
	await stubCheckout(page);
	await stubHostedApi(page);
	const requests: unknown[] = [];
	let statusReads = 0;
	await page.route("**/v2/wallet/topup", async (route) => {
		requests.push(route.request().postDataJSON());
		await route.fulfill({ json: started });
	});
	await page.route("**/v2/wallet/topup/checkout/cs_wallet", async (route) => {
		statusReads++;
		await route.fulfill({
			json: {
				...started,
				status: "processing",
				client_secret: null,
				payment_intent_id: "pi_wallet",
			},
		});
	});
	await gotoHostedSettingsDialog(page, "billing-wallet");
	await page.getByRole("button", { name: "Top up", exact: true }).click();
	await page.getByRole("button", { name: "Continue with $25.00" }).click();
	await expect(page.getByText("Mock Payment Element fallback")).toBeVisible();
	await page.getByRole("button", { name: "Mock Apple Pay" }).dblclick();
	await expect(page.getByText("Mock wallet declined")).toBeVisible();
	expect(await page.evaluate(() => window.__walletCheckoutConfirms)).toEqual([
		{ express: true, redirect: "if_required" },
	]);
	await page.getByRole("button", { name: "Mock Apple Pay" }).click();
	await expect(page.getByText("Payment processing", { exact: true })).toBeVisible();
	expect(statusReads).toBe(1);
	expect(requests).toEqual([{ amount_cents: 2500, flow_type: "checkout_session" }]);
	expect(await page.evaluate(() => window.__walletCheckoutConfirms)).toHaveLength(2);
});

for (const [status, message] of [
	["processing", "Top-up processing"],
	["requires_payment_method", "Top-up didn't finish"],
]) {
	test(`Wallet Checkout return resolves ${status} from the bound server lookup`, async ({
		page,
	}) => {
		await stubCheckout(page);
		await stubHostedApi(page);
		let creates = 0;
		await page.route("**/v2/wallet/topup", (route) => {
			creates++;
			return route.abort();
		});
		await page.route("**/v2/wallet/topup/checkout/cs_wallet", (route) =>
			route.fulfill({
				json: { ...started, status, client_secret: null, payment_intent_id: "pi_wallet" },
			}),
		);
		await page.goto("/?settings=billing-wallet&wallet_checkout_session_id=cs_wallet");
		await expect(page.getByText(message, { exact: true })).toBeVisible();
		await expect(page).not.toHaveURL(/wallet_checkout_session_id/);
		expect(creates).toBe(0);
		expect(await page.evaluate(() => window.__walletCheckoutConfirms)).toEqual([]);
	});
}
