import { describe, expect, test } from "bun:test";
import { ApiClientError, recordHostedCheckoutSends } from "@clawdi/shared/api";
import { WALLET_RELEASE_GRACE_MS } from "@/hosted/billing/deploy/deploy-request";
import {
	createSubscriptionAttemptStore,
	isDefinitiveRefusal,
	parseSubscriptionAttempt,
	releaseSubscriptionAttempt,
	type SubscriptionAttempt,
	subscriptionAttemptControls,
	subscriptionAttemptErrorCopy,
	subscriptionAttemptStorageKey,
} from "./subscription-attempt";

const EXPIRES_AT = "2026-10-16T00:15:00Z";
const quote = {
	plan_slug: "compute_basic",
	billing_term_months: 1,
	funding_source: "wallet",
	currency: "usd",
	term_price_cents: 1000,
	preview_invoice_id: null,
	expires_at: EXPIRES_AT,
	debit_amount_usd: "10.00",
	balance_before_usd: "30.00",
	balance_after_usd: "20.00",
} as const;
const prepared: SubscriptionAttempt = {
	version: 1,
	submission: "prepared",
	deploymentId: "hdep_Stopped",
	idempotencyKey: "8e244ab3-1111-4111-8111-111111111111",
	selection: { planSlug: "compute_basic", billingTermMonths: 1, fundingSource: "wallet" },
	uiMode: "custom",
	walletQuote: quote,
};
const uncertain: SubscriptionAttempt = { ...prepared, submission: "uncertain" };
const fresh = { ...quote, expires_at: "2026-10-16T01:15:00Z" };

function journal() {
	const values = new Map<string, string>();
	return createSubscriptionAttemptStore({
		getItemAsync: async (key) => values.get(key) ?? null,
		setItemAsync: async (key, value) => {
			values.set(key, value);
		},
		deleteItemAsync: async (key) => {
			values.delete(key);
		},
	});
}

const sent = (error: ApiClientError, sends: number) => recordHostedCheckoutSends(error, sends);

describe("existing-Agent Wallet subscription journal", () => {
	test("parses only a complete record whose quote matches its selection", () => {
		expect(parseSubscriptionAttempt(JSON.stringify(prepared))).toEqual(prepared);
		for (const invalid of [
			{ ...prepared, submission: "rejected" },
			{ ...prepared, idempotencyKey: "not-a-uuid" },
			{ ...prepared, deploymentId: "../hdep" },
			{ ...prepared, uiMode: "hosted" },
			{ ...prepared, selection: { ...prepared.selection, fundingSource: "stripe" } },
			{ ...prepared, selection: { ...prepared.selection, billingTermMonths: 12 } },
			{ ...prepared, walletQuote: { ...quote, plan_slug: "compute_performance" } },
			{ ...prepared, walletQuote: { ...quote, debit_amount_usd: null } },
		])
			expect(parseSubscriptionAttempt(JSON.stringify(invalid))).toBeNull();
		expect(parseSubscriptionAttempt("{")).toBeNull();
	});

	test("replaces the quote only while no send of the old one can charge", async () => {
		const store = journal();
		await store.saveAttempt("key", prepared, () => true);
		const requoted = { ...prepared, walletQuote: fresh };
		await store.replaceAttempt("key", prepared, requoted, () => true);
		await store.replaceAttempt(
			"key",
			requoted,
			{ ...requoted, submission: "uncertain" },
			() => true,
		);
		const sending: SubscriptionAttempt = { ...requoted, submission: "uncertain" };
		// An uncertain send replays its own quote: never a different one, nor another Agent.
		await expect(
			store.replaceAttempt("key", sending, { ...sending, walletQuote: quote }, () => true),
		).rejects.toThrow("Request payload changed");
		await expect(
			store.replaceAttempt("key", sending, { ...sending, deploymentId: "hdep_Other" }, () => true),
		).rejects.toThrow("Request payload changed");
		const released: SubscriptionAttempt = { ...sending, submission: "released" };
		await store.replaceAttempt("key", sending, released, () => true);
		await store.replaceAttempt("key", released, { ...released, walletQuote: quote }, () => true);
		expect(await store.readSavedAttempt("key")).toEqual({ ...released, walletQuote: quote });
	});

	test("releases an uncertain send only on hosted's typed refusal after the grace period", () => {
		const after = Date.parse(EXPIRES_AT) + WALLET_RELEASE_GRACE_MS;
		// clawdi-hosted #2518: both codes mean no dispatch exists for this Idempotency-Key.
		for (const [status, code] of [
			[409, "wallet_quote_expired"],
			[400, "upgrade_target_unavailable"],
		] as const)
			expect(
				releaseSubscriptionAttempt(uncertain, new ApiClientError(status, code, null, after)),
			).toEqual({ ...uncertain, submission: "released" });
		for (const error of [
			// An observed dispatch answers an untyped conflict.
			new ApiClientError(409, null, null, after),
			new ApiClientError(409, "wallet_quote_expired", null, null),
			new ApiClientError(409, "wallet_quote_expired", null, after - 1),
			new ApiClientError(400, "wallet_quote_expired", null, after),
			new ApiClientError(409, "upgrade_target_unavailable", null, after),
			new ApiClientError(503, "wallet_quote_expired", null, after),
			new ApiClientError(409, "reusable_subscription_unavailable", null, after),
		])
			expect(releaseSubscriptionAttempt(uncertain, error)).toBeNull();
		expect(
			releaseSubscriptionAttempt(
				prepared,
				new ApiClientError(409, "wallet_quote_expired", null, after),
			),
		).toBeNull();
	});

	test('says "No wallet payment was made" only for a refused first send', () => {
		const refused = sent(new ApiClientError(422, "invalid_quote"), 1);
		expect(isDefinitiveRefusal(prepared, refused)).toBe(true);
		expect(subscriptionAttemptErrorCopy(prepared, refused).description).toContain(
			"No wallet payment was made",
		);
		// A fresh send after a release returns to `released`, but an earlier send was uncertain.
		const released: SubscriptionAttempt = { ...prepared, submission: "released" };
		expect(isDefinitiveRefusal(released, refused)).toBe(true);
		expect(subscriptionAttemptErrorCopy(released, refused).description).not.toContain(
			"No wallet payment",
		);
		for (const [saved, error] of [
			[uncertain, refused],
			[prepared, sent(new ApiClientError(409, "busy"), 3)],
			[prepared, sent(new ApiClientError(503, null), 1)],
			[prepared, sent(new ApiClientError(409, "deployment_acceptance_pending"), 1)],
		] as const) {
			expect(isDefinitiveRefusal(saved, error)).toBe(false);
			expect(subscriptionAttemptErrorCopy(saved, error).description).not.toContain(
				"No wallet payment",
			);
		}
	});

	test("an uncertain request offers Check status, never Discard", () => {
		expect(subscriptionAttemptControls(uncertain)).toEqual({ checkStatus: true, discard: false });
		expect(subscriptionAttemptControls(prepared)).toEqual({ checkStatus: false, discard: true });
		expect(subscriptionAttemptControls({ ...prepared, submission: "released" })).toEqual({
			checkStatus: false,
			discard: true,
		});
	});

	test("stores each Agent's request under a SecureStore-safe key", () => {
		const digest = "a".repeat(64);
		expect(subscriptionAttemptStorageKey(digest, "hdep_Stopped")).toBe(
			`clawdi.subscription.v1.${digest}.hdep_Stopped`,
		);
		expect(subscriptionAttemptStorageKey(digest, "hdep:bad")).toBeNull();
		expect(subscriptionAttemptStorageKey("short", "hdep_Stopped")).toBeNull();
	});
});
