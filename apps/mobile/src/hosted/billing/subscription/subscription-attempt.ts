import {
	ApiClientError,
	type HostedDeploySubscriptionQuote,
	type HostedDeploySubscriptionSelection,
	hostedCheckoutSends,
	isHostedDeployComputePlan,
} from "@clawdi/shared/api";
import { DEPLOY_ACCEPTANCE_PENDING_CODE, deploySubmissionErrorCopy } from "@clawdi/shared/view";
import {
	canonicalWalletQuote,
	deploySubmissionFailure,
	WALLET_RELEASE_GRACE_MS,
} from "@/hosted/billing/deploy/deploy-request";
import { type AttemptStore, createSerializedAttemptStore } from "@/platform/attempt-store";

/**
 * A new Wallet subscription for an existing Agent, journaled like the deploy wizard's
 * (#1834) because it is the one existing-agent path that debits inside the request.
 * `released`: an uncertain send hosted proved it never dispatched, confirmed again on a
 * fresh quote. Assigning a reusable subscription moves no money and is not journaled.
 */
export type SubscriptionAttempt = {
	version: 1;
	submission: "prepared" | "uncertain" | "released";
	deploymentId: string;
	/**
	 * Hosted's replay identity for an existing-Agent Wallet attempt (clawdi-hosted #2518):
	 * the same key replays the original payment and is kept across a release.
	 */
	idempotencyKey: string;
	selection: HostedDeploySubscriptionSelection & { fundingSource: "wallet" };
	/** Part of hosted's replay comparison; never changes. */
	uiMode: "custom";
	walletQuote: HostedDeploySubscriptionQuote;
};

/** The app generates UUID v4 keys; hosted deployment ids are sqids. */
const ATTEMPT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEPLOYMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Hosted's typed checkout refusals (`LifecycleProblemDetails.code`, clawdi-hosted #2518),
 * returned only when no dispatch exists for this request's Idempotency-Key: an expired
 * quote (409) and an ineligible target (400). Any other refusal is untyped.
 */
const SUBSCRIPTION_RELEASE_PROBLEMS: Readonly<Record<string, number>> = {
	wallet_quote_expired: 409,
	upgrade_target_unavailable: 400,
};

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SecureStore keys allow only letters, digits, ".", "-" and "_". */
export function subscriptionAttemptStorageKey(
	accountDigest: string,
	deploymentId: string,
): string | null {
	return /^[0-9a-f]{64}$/.test(accountDigest) && DEPLOYMENT_ID.test(deploymentId)
		? `clawdi.subscription.v1.${accountDigest}.${deploymentId}`
		: null;
}

export function parseSubscriptionAttempt(raw: string): SubscriptionAttempt | null {
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!record(value) ||
			value.version !== 1 ||
			(value.submission !== "prepared" &&
				value.submission !== "uncertain" &&
				value.submission !== "released") ||
			typeof value.deploymentId !== "string" ||
			!DEPLOYMENT_ID.test(value.deploymentId) ||
			typeof value.idempotencyKey !== "string" ||
			!ATTEMPT_KEY.test(value.idempotencyKey) ||
			value.uiMode !== "custom" ||
			!record(value.selection)
		)
			return null;
		const { planSlug, billingTermMonths, fundingSource } = value.selection;
		if (
			typeof planSlug !== "string" ||
			!isHostedDeployComputePlan(planSlug) ||
			(billingTermMonths !== 1 && billingTermMonths !== 12) ||
			fundingSource !== "wallet"
		)
			return null;
		const walletQuote = canonicalWalletQuote(value.walletQuote, planSlug);
		if (!walletQuote || walletQuote.billing_term_months !== billingTermMonths) return null;
		return {
			version: 1,
			submission: value.submission,
			deploymentId: value.deploymentId,
			idempotencyKey: value.idempotencyKey,
			selection: { planSlug, billingTermMonths, fundingSource },
			uiMode: "custom",
			walletQuote,
		};
	} catch {
		return null;
	}
}

/**
 * The same request: id, Agent and selection never change. Its quote is replaced only
 * while no send of the old one can still charge (`prepared` or `released`).
 */
export function sameSubscriptionIntent(
	previous: SubscriptionAttempt,
	next: SubscriptionAttempt,
): boolean {
	return (
		next.idempotencyKey === previous.idempotencyKey &&
		next.deploymentId === previous.deploymentId &&
		next.uiMode === previous.uiMode &&
		JSON.stringify(next.selection) === JSON.stringify(previous.selection) &&
		(JSON.stringify(next.walletQuote) === JSON.stringify(previous.walletQuote) ||
			((previous.submission === "prepared" || previous.submission === "released") &&
				next.submission === previous.submission))
	);
}

export function createSubscriptionAttemptStore(store: AttemptStore) {
	return createSerializedAttemptStore(store, {
		parse: parseSubscriptionAttempt,
		sameIntent: sameSubscriptionIntent,
		ownerError: "Subscription owner changed",
	});
}

/**
 * Releases an uncertain send hosted proved it never dispatched. A Check status replay
 * sends the same key and body; hosted answers a typed expired-quote or ineligible-target
 * refusal only when no dispatch exists for that key (an observed dispatch replays the
 * payment or answers an untyped conflict). Like the wizard, the proof counts only once the
 * server clock is a grace period past the quote's expiry, so no earlier send can still be
 * committing. An untyped refusal, another status or a missing `Date` never releases it.
 */
export function releaseSubscriptionAttempt(
	attempt: SubscriptionAttempt,
	error: unknown,
): SubscriptionAttempt | null {
	if (
		attempt.submission !== "uncertain" ||
		!(error instanceof ApiClientError) ||
		error.code === null ||
		!Object.hasOwn(SUBSCRIPTION_RELEASE_PROBLEMS, error.code) ||
		SUBSCRIPTION_RELEASE_PROBLEMS[error.code] !== error.status ||
		error.serverDateMs === null ||
		error.serverDateMs < Date.parse(attempt.walletQuote.expires_at) + WALLET_RELEASE_GRACE_MS
	)
		return null;
	return { ...attempt, submission: "released" };
}

/**
 * True when this failure answers a send's first and only transport attempt and refuses
 * it. Hosted checks this key's replay first, so no dispatch exists for it and the request
 * returns to its state before the send (`prepared` or `released`).
 */
export function isDefinitiveRefusal(saved: SubscriptionAttempt, error: unknown): boolean {
	return (
		saved.submission !== "uncertain" &&
		hostedCheckoutSends(error) === 1 &&
		error instanceof ApiClientError &&
		error.status >= 400 &&
		error.status < 500 &&
		error.status !== 408 &&
		error.status !== 429 &&
		error.code !== DEPLOY_ACCEPTANCE_PENDING_CODE
	);
}

/**
 * Copy for a failed send. "No wallet payment was made" only for a definitive refusal of
 * the request's first send: never after an earlier uncertain or released send.
 */
export function subscriptionAttemptErrorCopy(saved: SubscriptionAttempt, error: unknown) {
	return deploySubmissionErrorCopy(
		{
			...deploySubmissionFailure(error),
			firstSend: saved.submission === "prepared" && isDefinitiveRefusal(saved, error),
		},
		"wallet_subscription",
	);
}

/** A request no send of which can still charge is confirmed on a fresh quote. */
export function subscriptionAttemptNeedsQuote(attempt: SubscriptionAttempt): boolean {
	return attempt.submission === "prepared" || attempt.submission === "released";
}

/** The saved request's recovery controls. */
export function subscriptionAttemptControls(attempt: SubscriptionAttempt) {
	return {
		checkStatus: attempt.submission === "uncertain",
		discard: attempt.submission !== "uncertain",
	};
}
