import { describe, expect, test } from "bun:test";
import {
	decodePaymentSignatureHeader,
	encodePaymentRequiredHeader,
	encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";
import {
	createCredentiallessX402Fetch,
	loadX402TopupOffer,
	payX402Topup,
	X402_BASE_NETWORK,
	X402_BASE_USDC,
	X402PaymentError,
} from "./payment";

const ORIGIN = "https://api.example.test";
const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const ENDPOINT = `${ORIGIN}/v2/x402/topup?attempt_id=${ATTEMPT_ID}`;
const PAY_TO = `0x${"2".repeat(40)}`;
const AUTHORITY = {
	amountAtomic: "5000000",
	origin: ORIGIN,
	payTo: PAY_TO,
};
const TX = `0x${"3".repeat(64)}`;
const account = privateKeyToAccount(`0x${"1".repeat(64)}`);

function paymentRequired(amount = "5000000"): PaymentRequired {
	return {
		x402Version: 2,
		resource: { url: ENDPOINT },
		accepts: [
			{
				scheme: "exact",
				network: X402_BASE_NETWORK,
				amount,
				asset: X402_BASE_USDC,
				payTo: PAY_TO,
				maxTimeoutSeconds: 300,
				extra: { name: "USD Coin", version: "2" },
			},
		],
	};
}

function challenge(required = paymentRequired()): Response {
	return new Response(JSON.stringify(required), {
		status: 402,
		headers: {
			"Content-Type": "application/json",
			"PAYMENT-REQUIRED": encodePaymentRequiredHeader(required),
		},
	});
}

function success(): Response {
	const settlement: SettleResponse = {
		success: true,
		transaction: TX,
		network: X402_BASE_NETWORK,
		payer: account.address,
		amount: "5000000",
	};
	return new Response(null, {
		status: 200,
		headers: {
			"PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement),
		},
	});
}

describe("x402 top-up transport", () => {
	test("uses the exact public endpoint and reuses one signed authorization for recovery", async () => {
		const requests: Request[] = [];
		const credentialModes: Array<RequestCredentials | undefined> = [];
		let paidAttempts = 0;
		const fetch = createCredentiallessX402Fetch(async (input, init) => {
			const request = input instanceof Request ? input : new Request(input);
			requests.push(request.clone());
			credentialModes.push(init?.credentials);
			if (!request.headers.has("PAYMENT-SIGNATURE")) return challenge();
			paidAttempts += 1;
			return paidAttempts === 1
				? new Response(JSON.stringify({ detail: { error: "retry_pending" } }), {
						status: 503,
						headers: { "Retry-After": "1" },
					})
				: success();
		});

		const offer = await loadX402TopupOffer({
			authenticatedOrigin: ORIGIN,
			attemptId: ATTEMPT_ID,
			authority: AUTHORITY,
			maxAmountAtomic: 5_000_000n,
			fetch,
		});
		const result = await payX402Topup({ offer, signer: account, fetch, sleep: async () => {} });

		expect(offer.amountUsd).toBe("5");
		expect(result.settlement.transaction).toBe(TX);
		expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
			["POST", "/v2/x402/topup"],
			["POST", "/v2/x402/topup"],
			["POST", "/v2/x402/topup"],
		]);
		expect(
			requests.every(
				(request) => new URL(request.url).searchParams.get("attempt_id") === ATTEMPT_ID,
			),
		).toBe(true);
		expect(requests[0]?.headers.get("Authorization")).toBeNull();
		expect(credentialModes).toEqual(["omit", "omit", "omit"]);
		const firstSignature = requests[1]?.headers.get("PAYMENT-SIGNATURE");
		expect(firstSignature).toBeTruthy();
		expect(requests[2]?.headers.get("PAYMENT-SIGNATURE")).toBe(firstSignature);
		expect(decodePaymentSignatureHeader(firstSignature ?? "").accepted).toEqual(
			paymentRequired().accepts[0],
		);
	});

	test("rejects an offer above the explicit ceiling before signing", async () => {
		await expect(
			loadX402TopupOffer({
				authenticatedOrigin: ORIGIN,
				attemptId: ATTEMPT_ID,
				authority: AUTHORITY,
				maxAmountAtomic: 4_990_000n,
				fetch: async () => challenge(),
			}),
		).rejects.toThrow("within the authorized limit");
	});

	test("treats unverifiable paid responses as unknown and prevents a fresh payment", async () => {
		const offer = await loadX402TopupOffer({
			authenticatedOrigin: ORIGIN,
			attemptId: ATTEMPT_ID,
			authority: AUTHORITY,
			maxAmountAtomic: 5_000_000n,
			fetch: async () => challenge(),
		});
		const mismatchedSettlement: SettleResponse = {
			success: true,
			transaction: "0x1234",
			network: X402_BASE_NETWORK,
			payer: account.address,
			amount: "5000000",
		};

		for (const response of [
			new Response(JSON.stringify({ status: "succeeded" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"PAYMENT-RESPONSE": encodePaymentResponseHeader(mismatchedSettlement),
				},
			}),
			new Response(null, { status: 409 }),
		]) {
			let rejection: unknown;
			try {
				await payX402Topup({ offer, signer: account, fetch: async () => response });
			} catch (error) {
				rejection = error;
			}
			expect(rejection).toBeInstanceOf(X402PaymentError);
			if (!(rejection instanceof X402PaymentError)) throw rejection;
			expect(rejection.code).toBe("payment_outcome_unknown");
			expect(rejection.message).toContain("may already have moved");
			expect(rejection.message).toContain("Do not create a new payment");
		}
	});
});
