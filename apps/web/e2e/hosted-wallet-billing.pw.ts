import { expect, test } from "@playwright/test";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { isHex, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { WalletBinding, WalletState } from "../src/hosted/billing/contracts";
import {
	basicPlan,
	collectBrowserErrors,
	fixtureAgentId,
	gotoHostedAgentSettings,
	gotoHostedSettingsDialog,
	performancePlan,
	stubHostedApi,
	walletActiveDeployment,
	walletPastDueDeployment,
	walletState,
} from "./hosted-stub-api";

const DEPLOY_API = process.env.E2E_HOSTED_DEPLOY_API_URL ?? "http://127.0.0.1:8001";

test("wallet top-up completion refreshes an automatically paid open invoice", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	const deployments: unknown[] = [walletPastDueDeployment];
	const topUpRequests: string[] = [];
	await stubHostedApi(page, {
		deployments,
		plans: [basicPlan, performancePlan],
		topUpRequests,
		onTopUpSuccess: () => deployments.splice(0, 1, walletActiveDeployment),
	});
	await gotoHostedAgentSettings(page, fixtureAgentId(walletPastDueDeployment), "Basic");

	const pastDueAlert = page.getByRole("alert").filter({ hasText: "Wallet payment past due" });
	await expect(pastDueAlert).toBeVisible();
	await expect(pastDueAlert).toContainText(
		"Stripe will keep the invoice open while funds are short",
	);
	await expect(pastDueAlert.getByRole("button", { name: "Top up" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Fix payment" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /Retry payment/ })).toHaveCount(0);

	await pastDueAlert.getByRole("button", { name: "Top up" }).click();
	const topUpDialog = page.getByRole("dialog").filter({ hasText: "Top up Wallet" });
	await expect(topUpDialog).toBeVisible();
	await topUpDialog.getByRole("button", { name: "Continue with $25.00" }).click();

	await expect.poll(() => topUpRequests.length).toBe(1);
	await expect(page.getByText("Payment accepted", { exact: true })).toBeVisible();
	await expect(pastDueAlert).toHaveCount(0);
	await expect(page.getByText("Wallet", { exact: true })).toBeVisible();
	expect(JSON.parse(topUpRequests[0] ?? "{}")).toEqual({ amount_cents: 2_500 });
	expect(errors, `wallet open-invoice top-up: ${errors.join(" | ")}`).toEqual([]);
});

test("x402 stays gated, then binds and recovers an unverifiable browser-wallet payment", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const payer = privateKeyToAccount(`0x${"1".repeat(64)}`);
	const payTo = `0x${"2".repeat(40)}`;
	const transaction = `0x${"3".repeat(64)}`;
	const attemptId = "22222222-2222-4222-8222-222222222222";
	const attemptExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
	const endpoint = `${DEPLOY_API}/v2/x402/topup?attempt_id=${attemptId}`;
	const challenge = {
		challenge_id: "11111111-1111-4111-8111-111111111111",
		message: "api.example.test wants you to verify this Wallet address.",
		expires_at: new Date(Date.now() + 60_000).toISOString(),
	};
	const currentWallet: WalletState = {
		...walletState,
		x402_enabled: false,
		x402_payment_authority: null,
		x402_payment_status: "idle" as const,
		x402_payment_attempt: null,
	};
	let binding: WalletBinding = { bound: false, address: null, verified_at: null };
	const bindingAuthorizations: Array<string | null> = [];
	const attemptAuthorizations: Array<string | null> = [];
	const bindingVerifyBodies: unknown[] = [];
	const personalSignMessages: string[] = [];
	const typedDataPayloads: string[] = [];
	const publicPaymentHeaders: Array<Record<string, string>> = [];

	await page.exposeFunction("__x402PersonalSign", async (message: string) => {
		personalSignMessages.push(message);
		if (!isHex(message)) throw new Error("invalid personal-sign payload");
		return payer.signMessage({ message: { raw: message } });
	});
	await page.exposeFunction("__x402TypedSign", async (serialized: string) => {
		typedDataPayloads.push(serialized);
		return payer.signTypedData(JSON.parse(serialized));
	});
	await page.addInitScript(
		({ address }) => {
			Reflect.set(window, "ethereum", {
				async request({ method, params }: { method: string; params?: readonly unknown[] }) {
					if (method === "eth_requestAccounts") return [address];
					const payload = method === "eth_signTypedData_v4" ? params?.[1] : params?.[0];
					if (typeof payload !== "string") throw new Error("missing signing payload");
					const functionName =
						method === "personal_sign"
							? "__x402PersonalSign"
							: method === "eth_signTypedData_v4"
								? "__x402TypedSign"
								: null;
					if (!functionName) throw new Error("unsupported wallet method");
					const signer = Reflect.get(window, functionName);
					if (typeof signer !== "function") throw new Error("missing test signer");
					return Reflect.apply(signer, window, [payload]);
				},
			});
		},
		{ address: payer.address },
	);

	await stubHostedApi(page, { walletState: currentWallet });
	await page.route(`${DEPLOY_API}/v2/wallet-binding/challenge`, async (route) => {
		bindingAuthorizations.push(route.request().headers().authorization ?? null);
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(challenge),
		});
	});
	await page.route(`${DEPLOY_API}/v2/wallet-binding`, async (route) => {
		bindingAuthorizations.push(route.request().headers().authorization ?? null);
		if (route.request().method() === "GET") {
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(binding),
			});
		}
		if (route.request().method() === "POST") {
			const body: unknown = route.request().postDataJSON();
			bindingVerifyBodies.push(body);
			binding = {
				bound: true,
				address: payer.address,
				verified_at: "2026-08-16T12:00:00Z",
			};
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(binding),
			});
		}
		return route.fulfill({ status: 204 });
	});
	await page.route(`${DEPLOY_API}/v2/x402/attempts`, async (route) => {
		attemptAuthorizations.push(route.request().headers().authorization ?? null);
		currentWallet.x402_payment_status = "processing";
		currentWallet.x402_payment_attempt = {
			attempt_id: attemptId,
			status: "awaiting_payment",
			expires_at: attemptExpiresAt,
		};
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ attempt_id: attemptId, expires_at: attemptExpiresAt }),
		});
	});
	await page.route(endpoint, async (route) => {
		const headers = route.request().headers();
		publicPaymentHeaders.push(headers);
		const required: PaymentRequired = {
			x402Version: 2,
			resource: { url: endpoint },
			accepts: [
				{
					scheme: "exact",
					network: "eip155:8453",
					amount: "5000000",
					asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
					payTo,
					maxTimeoutSeconds: 300,
					extra: { name: "USD Coin", version: "2" },
				},
			],
		};
		if (!headers["payment-signature"]) {
			return route.fulfill({
				status: 402,
				contentType: "application/json",
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Expose-Headers": "PAYMENT-REQUIRED",
					"PAYMENT-REQUIRED": encodePaymentRequiredHeader(required),
				},
				body: JSON.stringify(required),
			});
		}
		currentWallet.x402_payment_status = "processing";
		currentWallet.x402_payment_attempt = {
			attempt_id: attemptId,
			status: "processing",
			expires_at: attemptExpiresAt,
		};
		const malformedSettlement: SettleResponse = {
			success: true,
			transaction: "0x1234",
			network: "eip155:8453",
			payer: payer.address,
			amount: "5000000",
		};
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Expose-Headers": "PAYMENT-RESPONSE",
				"PAYMENT-RESPONSE": encodePaymentResponseHeader(malformedSettlement),
			},
			body: JSON.stringify({ status: "succeeded", transaction }),
		});
	});

	let settings = await gotoHostedSettingsDialog(page, "billing-wallet");
	await expect(settings.getByText("Coming soon", { exact: true })).toBeVisible();

	Object.assign(currentWallet, {
		x402_enabled: true,
		x402_payment_authority: {
			api_origin: DEPLOY_API,
			pay_to: payTo,
			amount_atomic: "5000000",
		},
		x402_payment_status: "idle" as const,
		x402_payment_attempt: null,
	});
	settings = await gotoHostedSettingsDialog(page, "billing-wallet");
	await expect(settings.getByText("Not bound", { exact: true })).toBeVisible();
	await settings.getByRole("button", { name: "Connect & bind" }).click();
	await expect(settings.getByText(payer.address, { exact: true }).first()).toBeVisible();
	await expect(settings.getByRole("button", { name: /Review \$5\.00 top-up/ })).toBeEnabled();

	await settings.getByRole("button", { name: /Review \$5\.00 top-up/ }).click();
	const confirmation = page.getByRole("dialog", { name: "Confirm Base USDC top-up" });
	await expect(confirmation).toContainText("$5.00 USDC");
	await expect(confirmation).toContainText(payer.address);
	await confirmation.getByRole("button", { name: "Pay $5.00 USDC" }).click();

	await expect.poll(() => typedDataPayloads.length).toBe(1);
	await expect.poll(() => publicPaymentHeaders.length).toBe(2);
	await expect(settings.getByText("USDC payment processing", { exact: true })).toBeVisible();
	await expect(
		settings.getByText(
			"Do not create a new payment until this payment attempt reaches a final status.",
		),
	).toBeVisible();
	await expect(settings.getByRole("button", { name: /\$5\.00 top-up/ })).toBeDisabled();

	await page.reload();
	settings = await gotoHostedSettingsDialog(page, "billing-wallet");
	await expect(settings.getByText("USDC payment processing", { exact: true })).toBeVisible();
	await expect(settings.getByRole("button", { name: /\$5\.00 top-up/ })).toBeDisabled();
	expect(attemptAuthorizations).toEqual(["Bearer dev-bypass"]);
	expect(publicPaymentHeaders).toHaveLength(2);

	currentWallet.x402_payment_status = "idle";
	currentWallet.x402_payment_attempt = {
		attempt_id: attemptId,
		status: "completed",
		expires_at: attemptExpiresAt,
	};
	await expect(settings.getByRole("button", { name: /\$5\.00 top-up/ })).toBeEnabled({
		timeout: 10_000,
	});

	expect(personalSignMessages).toEqual([toHex(challenge.message)]);
	expect(bindingVerifyBodies).toEqual([
		{
			challenge_id: challenge.challenge_id,
			signature: expect.stringMatching(/^0x[0-9a-fA-F]{130}$/),
		},
	]);
	expect(
		bindingAuthorizations.every((authorization) => authorization === "Bearer dev-bypass"),
	).toBe(true);
	expect(publicPaymentHeaders.map((headers) => headers.authorization ?? null)).toEqual([
		null,
		null,
	]);
	expect(publicPaymentHeaders.map((headers) => headers.cookie ?? null)).toEqual([null, null]);
	expect(publicPaymentHeaders[0]?.["payment-signature"]).toBeUndefined();
	expect(publicPaymentHeaders[1]?.["payment-signature"]).toBeTruthy();
	const unexpectedErrors = errors.filter(
		(message) => !message.includes("server responded with a status of 402 (Payment Required)"),
	);
	expect(unexpectedErrors, `x402 browser flow: ${errors.join(" | ")}`).toEqual([]);
});
