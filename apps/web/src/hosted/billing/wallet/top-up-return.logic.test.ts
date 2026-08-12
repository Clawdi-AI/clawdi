import { describe, expect, test } from "bun:test";
import {
	bootstrapWalletTopupReturn,
	buildWalletTopupReturnUrl,
	cleanMarkedWalletTopupReturnRequest,
	cleanWalletTopupReturnUrl,
	consumeWalletTopupReturn,
	coordinateWalletTopupReturn,
	readWalletTopupReturn,
	walletTopupReturnToast,
} from "@/hosted/billing/wallet/top-up-return.logic";

describe("wallet top-up return URL helpers", () => {
	test("builds a wallet settings return URL with the top-up marker", () => {
		const url = buildWalletTopupReturnUrl(
			"https://cloud.clawdi.ai/?settings=general&x=1&payment_intent=stale&payment_intent_client_secret=old&redirect_status=failed&topup_return=1",
		);

		expect(url).toBe("https://cloud.clawdi.ai/?settings=billing-wallet&x=1&topup_return=1");
	});

	test("synchronously consumes a valid return and preserves history state", () => {
		const calls: unknown[][] = [];
		const state = { key: "router-entry", __TSR_index: 4 };
		const result = consumeWalletTopupReturn(
			"https://cloud.clawdi.ai/?settings=billing-wallet&keep=1&topup_return=1&payment_intent=pi_1&payment_intent_client_secret=pi_secret&redirect_status=succeeded",
			state,
			(...args) => calls.push(args),
		);

		expect(result?.clientSecret === "pi_secret").toBe(true);
		expect(calls).toEqual([[state, "", "https://cloud.clawdi.ai/?settings=billing-wallet&keep=1"]]);
	});

	test("bootstraps before consumers and coordinates retrieval across remounts", async () => {
		const state = { key: "router-entry", __TSR_index: 4 };
		const calls: unknown[][] = [];
		bootstrapWalletTopupReturn(
			"https://cloud.clawdi.ai/?keep=1&topup_return=1&payment_intent_client_secret=pi_secret#billing",
			state,
			(...args) => calls.push(args),
		);

		expect(calls).toEqual([[state, "", "https://cloud.clawdi.ai/?keep=1#billing"]]);
		let retrievals = 0;
		const retrieve = async () => {
			retrievals += 1;
			return { status: "succeeded", paymentIntentId: "pi_1", errorMessage: null };
		};
		const first = coordinateWalletTopupReturn(retrieve);
		const remount = coordinateWalletTopupReturn(retrieve);
		expect(remount).toBe(first);
		expect(await remount).toEqual({
			status: "succeeded",
			paymentIntentId: "pi_1",
			errorMessage: null,
		});
		expect(retrievals).toBe(1);
	});

	test("scrubs a marked server request before routing", async () => {
		const request = new Request(
			"https://cloud.clawdi.ai/?keep=1&topup_return=bad&payment_intent_client_secret=secret#billing",
			{ method: "POST", headers: { Authorization: "Bearer token" }, body: "body" },
		);
		const clean = cleanMarkedWalletTopupReturnRequest(request);
		expect(clean.url).toBe("https://cloud.clawdi.ai/?keep=1#billing");
		expect(clean.headers.get("Authorization")).toBe("Bearer token");
		expect(await clean.text()).toBe("body");
	});

	test("consumes malformed marked returns before returning null", () => {
		for (const marker of ["1", "invalid"]) {
			const calls: unknown[][] = [];
			const result = consumeWalletTopupReturn(
				`https://cloud.clawdi.ai/?topup_return=${marker}&redirect_status=succeeded&keep=1`,
				null,
				(...args) => calls.push(args),
			);

			expect(result).toBe(null);
			expect(calls).toEqual([[null, "", "https://cloud.clawdi.ai/?keep=1"]]);
		}
	});

	test("reads only marked Stripe PaymentIntent returns", () => {
		const result = readWalletTopupReturn(
			"?settings=billing-wallet&topup_return=1&payment_intent_client_secret=pi_secret",
		);
		expect(result?.clientSecret === "pi_secret").toBe(true);
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
	test("maps succeeded to accepted copy while Wallet credit is still unconfirmed", () => {
		expect(walletTopupReturnToast("succeeded")).toEqual({
			kind: "info",
			title: "Payment accepted",
			description: "We're confirming your Wallet credit now.",
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
