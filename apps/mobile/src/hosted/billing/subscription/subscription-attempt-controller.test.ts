import { describe, expect, test } from "bun:test";
import {
	ApiClientError,
	ApiClientNetworkError,
	recordHostedCheckoutSends,
} from "@clawdi/shared/api";
import { WALLET_RELEASE_GRACE_MS } from "@/hosted/billing/deploy/deploy-request";
import {
	createSubscriptionAttemptStore,
	type SubscriptionAttempt,
} from "@/hosted/billing/subscription/subscription-attempt";
import {
	confirmSubscriptionAttempt,
	replaySubscriptionAttempt,
} from "@/hosted/billing/subscription/subscription-attempt-controller";

const KEY = "journal";
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

/** An in-memory SecureStore and a hosted stub that records what the journal held at each send. */
function harness(reply: () => Promise<unknown>, { failWrites = false } = {}) {
	const values = new Map<string, string>();
	const journal = createSubscriptionAttemptStore({
		getItemAsync: async (key) => values.get(key) ?? null,
		setItemAsync: async (key, value) => {
			if (failWrites) throw new Error("SecureStore unavailable");
			values.set(key, value);
		},
		deleteItemAsync: async (key) => {
			values.delete(key);
		},
	});
	const sent: { attempt: SubscriptionAttempt; journaled: SubscriptionAttempt | null }[] = [];
	const deps = {
		journal,
		storageKey: KEY,
		isCurrent: () => true,
		activate: async (attempt: SubscriptionAttempt) => {
			sent.push({ attempt, journaled: await journal.readSavedAttempt(KEY) });
			return reply();
		},
	};
	return { deps, sent, saved: () => journal.readSavedAttempt(KEY), journal };
}

const refused = () =>
	Promise.reject(recordHostedCheckoutSends(new ApiClientError(422, "invalid_quote"), 1));

describe("existing-Agent Wallet subscription send order", () => {
	test("writes uncertain before the POST, then clears the record when hosted activates", async () => {
		const { deps, sent, saved } = harness(async () => ({ flow_type: "subscription_activation" }));
		const step = await confirmSubscriptionAttempt(null, prepared, deps);
		expect(sent).toEqual([{ attempt: uncertain, journaled: uncertain }]);
		expect(step).toEqual({ kind: "settled", attempt: uncertain });
		expect(await saved()).toBeNull();
	});

	test("a failed journal write sends nothing", async () => {
		const { deps, sent } = harness(async () => ({}), { failWrites: true });
		await expect(confirmSubscriptionAttempt(null, prepared, deps)).rejects.toThrow();
		expect(sent).toHaveLength(0);
	});

	test("only a definitive refusal of the single send goes back to the previous state", async () => {
		const refusal = harness(refused);
		expect(await confirmSubscriptionAttempt(null, prepared, refusal.deps)).toMatchObject({
			kind: "failed",
			attempt: prepared,
		});
		expect(await refusal.saved()).toEqual(prepared);

		for (const error of [
			new ApiClientNetworkError("timeout"),
			recordHostedCheckoutSends(new ApiClientError(503, null), 1),
			recordHostedCheckoutSends(new ApiClientError(409, "busy"), 3),
		]) {
			const lost = harness(() => Promise.reject(error));
			expect(await confirmSubscriptionAttempt(null, prepared, lost.deps)).toMatchObject({
				kind: "failed",
				attempt: uncertain,
			});
			expect(await lost.saved()).toEqual(uncertain);
		}
	});

	test("a fresh quote for a saved request keeps its key and is journaled before sending", async () => {
		const fresh = { ...quote, expires_at: "2026-10-16T01:15:00Z" };
		const { deps, sent, journal } = harness(refused);
		await journal.saveAttempt(KEY, prepared, () => true);
		await confirmSubscriptionAttempt(prepared, { ...prepared, walletQuote: fresh }, deps);
		expect(sent[0]?.journaled).toEqual({ ...uncertain, walletQuote: fresh });
		expect(sent[0]?.attempt.idempotencyKey).toBe(prepared.idempotencyKey);
	});

	test("Check status replays the same request and clears it once hosted returns the activation", async () => {
		const { deps, sent, saved, journal } = harness(async () => ({}));
		await journal.saveAttempt(KEY, uncertain, () => true);
		expect(await replaySubscriptionAttempt(uncertain, deps)).toEqual({
			kind: "settled",
			attempt: uncertain,
		});
		expect(sent.map((item) => item.attempt)).toEqual([uncertain]);
		expect(await saved()).toBeNull();
	});

	test("Check status releases only on hosted's typed proof after the grace period", async () => {
		const after = Date.parse(EXPIRES_AT) + WALLET_RELEASE_GRACE_MS;
		const proof = harness(() =>
			Promise.reject(new ApiClientError(409, "wallet_quote_expired", null, after)),
		);
		await proof.journal.saveAttempt(KEY, uncertain, () => true);
		const released: SubscriptionAttempt = { ...uncertain, submission: "released" };
		expect(await replaySubscriptionAttempt(uncertain, proof.deps)).toEqual({
			kind: "released",
			attempt: released,
		});
		expect(await proof.saved()).toEqual(released);

		for (const error of [
			new ApiClientError(409, null, null, after),
			new ApiClientError(409, "wallet_quote_expired", null, after - 1),
		]) {
			const untyped = harness(() => Promise.reject(error));
			await untyped.journal.saveAttempt(KEY, uncertain, () => true);
			expect(await replaySubscriptionAttempt(uncertain, untyped.deps)).toMatchObject({
				kind: "failed",
				attempt: uncertain,
			});
			expect(await untyped.saved()).toEqual(uncertain);
		}
	});

	test("an owner change stops before anything else is written or shown", async () => {
		let owner = true;
		const { deps, saved } = harness(async () => {
			owner = false;
			return {};
		});
		expect(
			await confirmSubscriptionAttempt(null, prepared, { ...deps, isCurrent: () => owner }),
		).toEqual({ kind: "stale" });
		// The POST may have charged: the record stays uncertain for the next Check status.
		expect(await saved()).toEqual(uncertain);
	});
});
