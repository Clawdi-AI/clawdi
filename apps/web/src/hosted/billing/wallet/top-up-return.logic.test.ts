import { describe, expect, test } from "bun:test";
import {
	buildWalletTopupReturnUrl,
	cleanWalletTopupReturnUrl,
	readWalletTopupReturn,
	walletTopupReturnToast,
} from "@/hosted/billing/wallet/top-up-return.logic";

describe("wallet top-up return URL helpers", () => {
	test("builds a wallet settings return URL with the top-up marker", () => {
		const url = buildWalletTopupReturnUrl("https://cloud.clawdi.ai/?settings=general&x=1");

		expect(url).toBe("https://cloud.clawdi.ai/?settings=billing-wallet&x=1&topup_return=1");
	});

	test("reads only marked Stripe PaymentIntent returns", () => {
		expect(
			readWalletTopupReturn(
				"?settings=billing-wallet&topup_return=1&payment_intent_client_secret=pi_secret",
			),
		).toEqual({ clientSecret: "pi_secret" });
		expect(
			readWalletTopupReturn("?settings=billing-wallet&payment_intent_client_secret=pi_secret"),
		).toBe(null);
		expect(readWalletTopupReturn("?settings=billing-wallet&topup_return=1")).toBe(null);
	});

	test("cleans Stripe return params while preserving the wallet settings section", () => {
		const clean = cleanWalletTopupReturnUrl(
			"https://cloud.clawdi.ai/?settings=billing-wallet&topup_return=1&payment_intent=pi_1&payment_intent_client_secret=secret&redirect_status=succeeded&keep=1",
		);

		expect(clean).toBe("https://cloud.clawdi.ai/?settings=billing-wallet&keep=1");
	});
});

describe("walletTopupReturnToast", () => {
	test("maps succeeded to success copy", () => {
		expect(walletTopupReturnToast("succeeded")).toEqual({
			kind: "success",
			title: "Top-up complete",
			description: "Your credits will appear in a moment.",
		});
	});

	test("maps processing to settlement copy", () => {
		expect(walletTopupReturnToast("processing")).toEqual({
			kind: "info",
			title: "Top-up processing",
			description: "We'll credit your wallet once the payment settles.",
		});
	});

	test("maps requires_payment_method to retry guidance", () => {
		expect(walletTopupReturnToast("requires_payment_method")).toEqual({
			kind: "error",
			title: "Top-up didn't finish",
			description: "No payment was collected. Start a new top-up and choose another method.",
		});
	});
});
