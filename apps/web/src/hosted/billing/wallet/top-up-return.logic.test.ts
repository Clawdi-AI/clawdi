import { describe, expect, test } from "bun:test";
import { buildWalletSetupReturnUrl } from "@/hosted/billing/wallet/setup-return.logic";
import {
	bootstrapWalletStripeReturn,
	cleanWalletStripeReturnUrl,
	consumeWalletStripeReturn,
	coordinateWalletPaymentReturn,
	coordinateWalletSetupReturn,
	readWalletStripeReturn,
	type WalletPaymentReturnResolution,
	walletSetupIntentMatchesClientSecret,
} from "@/hosted/billing/wallet/stripe-return";
import {
	buildWalletAutoReloadReturnUrl,
	buildWalletTopupReturnUrl,
	walletTopupReturnToast,
} from "@/hosted/billing/wallet/top-up-return.logic";
import {
	fetchWithWalletStripeReturnPolicy,
	hasWalletStripeReturnUrl,
} from "@/lib/wallet-stripe-return-security";

describe("Wallet Stripe returns", () => {
	test("parses and scrubs valid, invalid, and mixed returns before routing", async () => {
		const historyState = { key: "router-entry", __TSR_index: 4 };
		const setupIdentity = `wsetup_${"a".repeat(64)}`;
		const opaquePaymentIntentId = "pi_opaque&=#.-~$";
		const secretPrefix = `${opaquePaymentIntentId}_secret_`;
		const opaquePaymentSecret = `${secretPrefix}${"x".repeat(1024 - secretPrefix.length - 15)}_secret_&=#.-~$`;
		expect(walletSetupIntentMatchesClientSecret("seti_1_secret_test", "seti_1")).toBe(true);
		expect(walletSetupIntentMatchesClientSecret("seti_1_secret_test", "seti_other")).toBe(false);
		const cases = [
			{
				query: `wallet_payment_return=1&wallet_payment_flow=manual_topup&payment_intent=${encodeURIComponent(opaquePaymentIntentId)}&payment_intent_client_secret=${encodeURIComponent(opaquePaymentSecret)}`,
				result: {
					kind: "payment_intent",
					clientSecret: opaquePaymentSecret,
					expectedIntentId: opaquePaymentIntentId,
					flow: "manual_topup",
				},
			},
			{
				query: `wallet_payment_return=1&wallet_payment_flow=auto_reload&payment_intent=${encodeURIComponent(opaquePaymentIntentId)}&payment_intent_client_secret=${encodeURIComponent(`${opaquePaymentSecret}x`)}`,
				result: null,
			},
			{
				query: `wallet_setup_return=1&wallet_setup_id=${setupIdentity}&setup_intent=seti_1&setup_intent_client_secret=seti_1_secret_test`,
				result: {
					kind: "setup_intent",
					clientSecret: "seti_1_secret_test",
					expectedIntentId: "seti_1",
					setupIdentity,
				},
			},
			{
				query:
					"wallet_payment_return=1&wallet_payment_flow=manual_topup&payment_intent_client_secret=pi_1_secret_test",
				result: null,
			},
			{
				query:
					"wallet_payment_return=1&wallet_payment_flow=manual_topup&wallet_setup_return=1&payment_intent_client_secret=pi_1_secret_test&setup_intent_client_secret=seti_1_secret_test",
				result: null,
			},
			{
				query: `wallet_setup_return=1&wallet_setup_id=${setupIdentity}&setup_intent_client_secret=seti_1_secret_test`,
				result: null,
			},
			{
				query:
					"wallet_payment_return=1&wallet_payment_flow=auto_reload&payment_intent=pi_other&payment_intent_client_secret=pi_1_secret_test",
				result: null,
			},
			{
				query: `wallet_setup_return=1&wallet_setup_id=${setupIdentity}&setup_intent=seti_other&setup_intent_client_secret=seti_1_secret_test`,
				result: null,
			},
			{
				query: "payment_intent_client_secret=pi_1_secret_test",
				result: null,
			},
			{
				query:
					"wallet_payment_return=1&wallet_payment_flow=manual_topup&payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_test&redirect%5Fstatus=",
				result: null,
			},
			{
				query: `wallet_payment_return=1&wallet_payment_flow=manual_topup&payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_test&wallet_setup_id=${setupIdentity}`,
				result: null,
			},
		] as const;

		for (const testCase of cases) {
			const current = `https://cloud.clawdi.ai/?settings=billing-wallet&keep=1&${testCase.query}&redirect_status=succeeded#billing`;
			const replacements: unknown[][] = [];
			expect(hasWalletStripeReturnUrl(current)).toBe(true);
			expect(readWalletStripeReturn(new URL(current).search)).toEqual(testCase.result);
			expect(
				consumeWalletStripeReturn(current, historyState, (...args) => replacements.push(args)),
			).toEqual(testCase.result);
			expect(replacements).toEqual([
				[historyState, "", "https://cloud.clawdi.ai/?settings=billing-wallet&keep=1#billing"],
			]);
		}

		for (const invalidReturn of [
			"wallet_payment_return=1&wallet_payment_flow=manual_topup&payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_test&payment%5Fintent=",
			`wallet_payment_return=1&wallet_payment_flow=manual_topup&payment_intent=${encodeURIComponent(opaquePaymentIntentId)}&payment_intent_client_secret=${encodeURIComponent(`${opaquePaymentSecret} `)}`,
			"payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_test",
			"topup_return=1&payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_test",
		]) {
			const replacements: unknown[][] = [];
			bootstrapWalletStripeReturn(
				`https://cloud.clawdi.ai/?settings=billing-wallet&keep=1&${invalidReturn}#billing`,
				historyState,
				(...args) => replacements.push(args),
			);
			expect(replacements).toEqual([
				[historyState, "", "https://cloud.clawdi.ai/?settings=billing-wallet&keep=1#billing"],
			]);
			expect(
				coordinateWalletPaymentReturn(async () => ({
					status: "succeeded",
					paymentIntentId: "pi_1",
					errorMessage: null,
				})),
			).toBeNull();
		}

		const sensitiveRequest = new Request(
			"https://cloud.clawdi.ai/?settings=billing-wallet&keep=1&setup_intent=seti_1&setup_intent_client_secret=seti_1_secret_test#billing",
			{
				method: "POST",
				headers: { Authorization: "Bearer token" },
				body: "body",
			},
		);
		const sensitiveResponse = await fetchWithWalletStripeReturnPolicy(
			sensitiveRequest,
			async (cleanRequest) => {
				expect(cleanRequest.url).toBe(
					"https://cloud.clawdi.ai/?settings=billing-wallet&keep=1#billing",
				);
				expect(cleanRequest.method).toBe("POST");
				expect(cleanRequest.headers.get("Authorization")).toBe("Bearer token");
				expect(await cleanRequest.text()).toBe("body");
				return new Response("router body", {
					status: 202,
					statusText: "Accepted",
					headers: {
						"Cache-Control": "public, max-age=60",
						"Referrer-Policy": "origin",
						"X-Router": "preserved",
					},
				});
			},
		);
		expect(sensitiveResponse.status).toBe(202);
		expect(sensitiveResponse.statusText).toBe("Accepted");
		expect(sensitiveResponse.headers.get("X-Router")).toBe("preserved");
		expect(sensitiveResponse.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(sensitiveResponse.headers.get("Cache-Control")).toBe("no-store");
		expect(await sensitiveResponse.text()).toBe("router body");

		const ordinaryRequest = new Request(
			"https://cloud.clawdi.ai/?checkout_session_id=cs_1&payment_intent=pi_checkout&payment_intent_client_secret=pi_checkout_secret_test&redirect_status=succeeded#checkout",
		);
		expect(hasWalletStripeReturnUrl(ordinaryRequest.url)).toBe(false);
		const unrelatedReplacements: unknown[][] = [];
		expect(
			consumeWalletStripeReturn(ordinaryRequest.url, historyState, (...args) =>
				unrelatedReplacements.push(args),
			),
		).toBeNull();
		expect(unrelatedReplacements).toEqual([]);
		const ordinaryResponse = new Response("ordinary", {
			status: 201,
			headers: { "X-Router": "ordinary" },
		});
		const unchangedResponse = await fetchWithWalletStripeReturnPolicy(
			ordinaryRequest,
			(receivedRequest) => {
				expect(receivedRequest).toBe(ordinaryRequest);
				return ordinaryResponse;
			},
		);
		expect(unchangedResponse).toBe(ordinaryResponse);
		expect(unchangedResponse.headers.get("Cache-Control")).toBeNull();
		expect(unchangedResponse.headers.get("Referrer-Policy")).toBeNull();
	});

	test("deduplicates an in-flight return, stops replay after settlement, and accepts a new identity", async () => {
		bootstrapWalletStripeReturn(
			"https://cloud.clawdi.ai/?wallet_payment_return=1&wallet_payment_flow=manual_topup&payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_test",
			null,
			() => undefined,
		);
		const firstRetrieval = Promise.withResolvers<Omit<WalletPaymentReturnResolution, "flow">>();
		let paymentRetrievals = 0;
		const retrievePayment = () => {
			paymentRetrievals += 1;
			return firstRetrieval.promise;
		};
		const payment = coordinateWalletPaymentReturn(retrievePayment);
		expect(coordinateWalletPaymentReturn(retrievePayment)).toBe(payment);
		expect(paymentRetrievals).toBe(1);

		bootstrapWalletStripeReturn(
			"https://cloud.clawdi.ai/?wallet_payment_return=1&wallet_payment_flow=auto_reload&payment_intent=pi_expected&payment_intent_client_secret=pi_expected_secret_test",
			null,
			() => undefined,
		);
		const secondRetrieval = Promise.withResolvers<Omit<WalletPaymentReturnResolution, "flow">>();
		const secondPayment = coordinateWalletPaymentReturn(() => secondRetrieval.promise);
		firstRetrieval.resolve({ status: "succeeded", paymentIntentId: "pi_1", errorMessage: null });
		expect(await payment).toMatchObject({ flow: "manual_topup", paymentIntentId: "pi_1" });
		expect(coordinateWalletPaymentReturn(retrievePayment)).toBe(secondPayment);
		secondRetrieval.resolve({
			status: "succeeded",
			paymentIntentId: "pi_expected",
			errorMessage: null,
		});
		expect(await secondPayment).toMatchObject({
			flow: "auto_reload",
			paymentIntentId: "pi_expected",
		});
		expect(coordinateWalletPaymentReturn(retrievePayment)).toBeNull();

		bootstrapWalletStripeReturn(
			"https://cloud.clawdi.ai/?wallet_payment_return=1&wallet_payment_flow=manual_topup&payment_intent=pi_mismatch&payment_intent_client_secret=pi_mismatch_secret_test",
			null,
			() => undefined,
		);
		expect(
			await coordinateWalletPaymentReturn(async () => ({
				status: "succeeded",
				paymentIntentId: "pi_other",
				errorMessage: null,
			})),
		).toMatchObject({ status: null, paymentIntentId: null, errorMessage: expect.any(String) });

		let setupRetrievals = 0;
		let setupFinalizations = 0;
		const retrieveSetup = async (pending: { setupIdentity: string; expectedIntentId: string }) => {
			setupRetrievals += 1;
			return {
				status: "succeeded",
				setupIntentId: pending.expectedIntentId,
				setupIdentity: pending.setupIdentity,
				errorMessage: null,
			};
		};
		const finalizeSetup = async (confirmed: { setupIdentity: string; setupIntentId: string }) => {
			setupFinalizations += 1;
			expect(confirmed.setupIdentity).toMatch(/^wsetup_[a-f0-9]{64}$/);
			expect(confirmed.setupIntentId).toMatch(/^seti_/);
			return null;
		};
		for (const identity of [`wsetup_${"a".repeat(64)}`, `wsetup_${"b".repeat(64)}`]) {
			bootstrapWalletStripeReturn(
				`https://cloud.clawdi.ai/?wallet_setup_return=1&wallet_setup_id=${identity}&setup_intent=seti_${setupRetrievals + 1}&setup_intent_client_secret=seti_${setupRetrievals + 1}_secret_test`,
				null,
				() => undefined,
			);
			const setup = coordinateWalletSetupReturn(retrieveSetup, finalizeSetup);
			expect(coordinateWalletSetupReturn(retrieveSetup)).toBe(setup);
			expect((await setup)?.setupIdentity).toBe(identity);
			await Promise.resolve();
			expect(coordinateWalletSetupReturn(retrieveSetup)).toBeNull();
		}
		expect(setupFinalizations).toBe(2);

		const expectedIdentity = `wsetup_${"c".repeat(64)}`;
		for (const returned of [
			{ setupIntentId: "seti_other", setupIdentity: expectedIdentity },
			{ setupIntentId: "seti_expected", setupIdentity: `wsetup_${"d".repeat(64)}` },
		]) {
			bootstrapWalletStripeReturn(
				`https://cloud.clawdi.ai/?wallet_setup_return=1&wallet_setup_id=${expectedIdentity}&setup_intent=seti_expected&setup_intent_client_secret=seti_expected_secret_test`,
				null,
				() => undefined,
			);
			const mismatched = await coordinateWalletSetupReturn(async () => {
				setupRetrievals += 1;
				return { status: "succeeded", ...returned, errorMessage: null };
			}, finalizeSetup);
			expect(mismatched).toMatchObject({ status: null, setupIntentId: null });
			expect(mismatched?.setupIdentity).toBe(expectedIdentity);
			expect(mismatched?.errorMessage).toContain("could not be verified");
		}
		expect(setupRetrievals).toBe(4);
		expect(setupFinalizations).toBe(2);
	});

	test("builds clean Wallet return URLs with only the required marker state", () => {
		const setupIdentity = `wsetup_${"c".repeat(64)}`;
		const sensitiveQuery =
			"settings=general&keep=1&topup_return=1&wallet_payment_return=1&wallet_payment_flow=auto_reload&payment_intent_client_secret=pi_1_secret_test&wallet_setup_return=1&wallet_setup_id=old&setup_intent_client_secret=seti_1_secret_test";
		const cases = [
			{
				current: `https://cloud.clawdi.ai/?${sensitiveQuery}#billing`,
				clean: "https://cloud.clawdi.ai/?settings=general&keep=1#billing",
				topup:
					"https://cloud.clawdi.ai/?settings=billing-wallet&keep=1&wallet_payment_return=1&wallet_payment_flow=manual_topup#billing",
				autoReload:
					"https://cloud.clawdi.ai/?settings=billing-wallet&keep=1&wallet_payment_return=1&wallet_payment_flow=auto_reload#billing",
				setup: `https://cloud.clawdi.ai/?settings=billing-wallet&keep=1&wallet_setup_return=1&wallet_setup_id=${setupIdentity}#billing`,
			},
			{
				current: `/wallet?${sensitiveQuery}#billing`,
				clean: "/wallet?settings=general&keep=1#billing",
				topup:
					"/wallet?settings=billing-wallet&keep=1&wallet_payment_return=1&wallet_payment_flow=manual_topup#billing",
				autoReload:
					"/wallet?settings=billing-wallet&keep=1&wallet_payment_return=1&wallet_payment_flow=auto_reload#billing",
				setup: `/wallet?settings=billing-wallet&keep=1&wallet_setup_return=1&wallet_setup_id=${setupIdentity}#billing`,
			},
		] as const;

		for (const testCase of cases) {
			expect(cleanWalletStripeReturnUrl(testCase.current)).toBe(testCase.clean);
			expect(buildWalletTopupReturnUrl(testCase.current)).toBe(testCase.topup);
			expect(buildWalletAutoReloadReturnUrl(testCase.current)).toBe(testCase.autoReload);
			expect(buildWalletSetupReturnUrl(testCase.current, setupIdentity)).toBe(testCase.setup);
		}
	});
});

describe("walletTopupReturnToast", () => {
	test("distinguishes accepted, settling, and failed payments", () => {
		expect(walletTopupReturnToast("succeeded")).toMatchObject({
			kind: "info",
			title: "Payment accepted",
		});
		expect(walletTopupReturnToast("processing")).toMatchObject({
			kind: "info",
			title: "Top-up processing",
		});
		expect(walletTopupReturnToast("requires_payment_method")).toMatchObject({
			kind: "error",
			title: "Top-up didn't finish",
		});
	});
});
