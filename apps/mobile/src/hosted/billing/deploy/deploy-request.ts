import {
	ApiClientError,
	ApiClientNetworkError,
	buildHostedDeployRequest,
	type DeployComponents,
	type HostedDeployAiFields,
	type HostedDeployComputePlanSlug,
	type HostedDeployPlan,
	type HostedDeployRequest,
	type HostedDeploySubscriptionQuote,
	type HostedDeploySubscriptionSelection,
	type HostedDeployValidationIssue,
	type HostedDeployWizardDraft,
	type HostedIncludedBasicAvailability,
	hostedCheckoutSends,
	hostedSubscriptionQuoteWalletDebit,
	isHostedDeployBillingTerm,
	isHostedDeployComputePlan,
	isHostedDeployRuntime,
	type StoreComputeSlot,
	type StorePurchaseAttempt,
	sameHostedSubscriptionQuoteTerms,
	validateAndBuildHostedDeployRequest,
	validateHostedDeployPersona,
} from "@clawdi/shared/api";
import {
	DEPLOY_SESSION_EXPIRED_RECOVERY,
	type DeploySubmissionFailure,
	deploySubmissionErrorCopy,
	deploySubmissionRecoveryCopy,
	walletDebitShortfallUsd,
} from "@clawdi/shared/view";

/**
 * Store-funded attempts send compute_source "store" at admission; hosted refuses
 * any fallback to other compute. Keep that transport option out of the persisted
 * request, and admit only after the store purchase is funded or covered by a slot.
 */
export type StoreFunding = "awaiting_purchase" | "purchase_pending" | "funded" | "review_required";

type ReusableSubscription = DeployComponents["schemas"]["V2ComputeReusableSubscriptionItem"];

/** One exact reusable card or Wallet subscription, assigned through Web's `existing` selection. */
export type ReusableSubscriptionChoice = {
	id: string;
	planSlug: HostedDeployComputePlanSlug;
	billingTermMonths: 1 | 12;
	fundingSource: "stripe" | "wallet";
};

export type CreationAttempt = {
	version: 1;
	/**
	 * `released`: an uncertain Wallet request hosted proved it never received, confirmed
	 * again on a fresh quote under the same id. That proof also allows discarding it.
	 */
	submission: "prepared" | "uncertain" | "released" | "entitlement_rejected";
	id: string;
	draft: HostedDeployWizardDraft;
	request: HostedDeployRequest;
	storeFunding?: StoreFunding;
	/** Absent: hosted selects the entitlement (Included Basic or a store slot). */
	subscription?: ReusableSubscriptionChoice;
	/**
	 * A new Wallet subscription funds this request, debited per this exact confirmed
	 * quote. Every send repeats it so hosted replays, never re-quotes, an earlier POST.
	 */
	walletQuote?: HostedDeploySubscriptionQuote;
};

/** Card and Wallet rows are assigned by id; store rows use `reusableStoreRowPlan`. */
export function reusableSubscriptionChoice(
	item: ReusableSubscription,
): ReusableSubscriptionChoice | null {
	if (item.funding_source !== "stripe" && item.funding_source !== "wallet") return null;
	return {
		id: item.subscription_id,
		planSlug: item.plan_slug,
		billingTermMonths: item.billing_term_months,
		fundingSource: item.funding_source,
	};
}

const SUBSCRIPTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

function parseSubscriptionChoice(
	value: unknown,
	planSlug: HostedDeployComputePlanSlug,
): ReusableSubscriptionChoice | null {
	if (
		!record(value) ||
		typeof value.id !== "string" ||
		!SUBSCRIPTION_ID.test(value.id) ||
		value.planSlug !== planSlug ||
		(value.billingTermMonths !== 1 && value.billingTermMonths !== 12) ||
		(value.fundingSource !== "stripe" && value.fundingSource !== "wallet")
	)
		return null;
	return {
		id: value.id,
		planSlug,
		billingTermMonths: value.billingTermMonths,
		fundingSource: value.fundingSource,
	};
}

/** Hosted serializes Decimal amounts as strings, possibly in exponent form. */
const QUOTE_DECIMAL = /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i;

function quoteDecimal(value: unknown): string | null {
	return typeof value === "string" && QUOTE_DECIMAL.test(value) ? value : null;
}

/**
 * The confirmed Wallet quote in one canonical shape, so the journal, its compare-and-set
 * and every resend carry identical bytes. Null unless it is a complete Wallet quote.
 */
export function canonicalWalletQuote(
	value: unknown,
	planSlug: HostedDeployComputePlanSlug,
): HostedDeploySubscriptionQuote | null {
	if (
		!record(value) ||
		value.funding_source !== "wallet" ||
		value.plan_slug !== planSlug ||
		(value.billing_term_months !== 1 && value.billing_term_months !== 12) ||
		typeof value.currency !== "string" ||
		!value.currency ||
		typeof value.term_price_cents !== "number" ||
		!Number.isSafeInteger(value.term_price_cents) ||
		value.term_price_cents < 0 ||
		typeof value.expires_at !== "string" ||
		Number.isNaN(Date.parse(value.expires_at)) ||
		(value.preview_invoice_id != null && typeof value.preview_invoice_id !== "string")
	)
		return null;
	const debit = quoteDecimal(value.debit_amount_usd);
	const before = quoteDecimal(value.balance_before_usd);
	const after = quoteDecimal(value.balance_after_usd);
	if (!debit || !before || !after) return null;
	return {
		plan_slug: planSlug,
		billing_term_months: value.billing_term_months,
		funding_source: "wallet",
		currency: value.currency,
		term_price_cents: value.term_price_cents,
		preview_invoice_id: value.preview_invoice_id ?? null,
		expires_at: value.expires_at,
		debit_amount_usd: debit,
		balance_before_usd: before,
		balance_after_usd: after,
	};
}

function isStoreFunding(value: unknown): value is StoreFunding {
	return (
		value === "awaiting_purchase" ||
		value === "purchase_pending" ||
		value === "funded" ||
		value === "review_required"
	);
}

/** Creation journals hold only the UUID v4 request ids this app generates. */
const CREATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A saved-provider request embeds provider metadata current at preparation time, so a
 * replay must reuse the persisted binding exactly. Accept it only when it binds the draft's
 * provider alone, then rebuild the rest of the request from the draft.
 */
function savedProviderFields(
	request: unknown,
	providerId: string,
	model: string,
): HostedDeployAiFields | null {
	if (!record(request)) return null;
	const {
		ai_provider_auth_kind: authKind,
		ai_provider_id,
		provider_ids,
		primary_model,
		ai_provider_bootstrap: bootstrap,
	} = request;
	if (
		(authKind !== "api_key" && authKind !== "codex_oauth") ||
		ai_provider_id !== providerId ||
		!Array.isArray(provider_ids) ||
		provider_ids.length !== 1 ||
		provider_ids[0] !== providerId ||
		!record(bootstrap) ||
		bootstrap.schema_version !== 1 ||
		bootstrap.selected_provider_id !== providerId
	)
		return null;
	if (
		primary_model !== null &&
		!(
			record(primary_model) &&
			primary_model.provider_id === providerId &&
			primary_model.model === model
		)
	)
		return null;
	return {
		ai_provider_auth_kind: authKind,
		ai_provider_id: providerId,
		provider_ids: [providerId],
		primary_model: primary_model === null ? null : { provider_id: providerId, model },
		ai_provider_bootstrap: bootstrap,
	};
}

export function parseCreationAttempt(raw: string): CreationAttempt | null {
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!record(value) ||
			value.version !== 1 ||
			typeof value.id !== "string" ||
			!CREATION_ID.test(value.id)
		)
			return null;
		const draft = value.draft;
		if (
			!record(draft) ||
			typeof draft.runtime !== "string" ||
			!isHostedDeployRuntime(draft.runtime) ||
			typeof draft.computePlanSlug !== "string" ||
			!isHostedDeployComputePlan(draft.computePlanSlug) ||
			typeof draft.agentName !== "string" ||
			typeof draft.language !== "string" ||
			typeof draft.timezone !== "string" ||
			!record(draft.ai)
		)
			return null;
		const ai = draft.ai;
		const restoredAi: HostedDeployWizardDraft["ai"] | null =
			ai.mode === "unmanaged"
				? { mode: "unmanaged" }
				: ai.mode === "managed" && typeof ai.model === "string"
					? { mode: "managed", model: ai.model }
					: ai.mode === "configured" &&
							typeof ai.providerId === "string" &&
							ai.providerId &&
							typeof ai.model === "string"
						? { mode: "configured", providerId: ai.providerId, model: ai.model }
						: null;
		if (!restoredAi) return null;
		const restoredDraft: HostedDeployWizardDraft = {
			runtime: draft.runtime,
			computePlanSlug: draft.computePlanSlug,
			agentName: draft.agentName,
			language: draft.language,
			timezone: draft.timezone,
			ai: restoredAi,
		};
		let built: HostedDeployRequest;
		if (restoredAi.mode === "configured") {
			const aiFields = savedProviderFields(value.request, restoredAi.providerId, restoredAi.model);
			const persona = {
				agentName: restoredDraft.agentName,
				language: restoredDraft.language,
				timezone: restoredDraft.timezone,
			};
			if (!aiFields || validateHostedDeployPersona(persona).length > 0) return null;
			built = buildHostedDeployRequest({
				computePlanSlug: restoredDraft.computePlanSlug,
				runtime: restoredDraft.runtime,
				persona,
				aiFields,
			});
		} else {
			const validated = validateAndBuildHostedDeployRequest(restoredDraft);
			if (!validated.ok) return null;
			built = validated.request;
		}
		const request = { ...built, deploy_request_id: value.id };
		// Reject any persisted payload drift, including missing/mismatched lineage IDs.
		// Never silently migrate or reconstruct a different request for a retry.
		if (JSON.stringify(value.request) !== JSON.stringify(request)) return null;
		// Old journals never recorded whether a POST began. Treat them as uncertain.
		const submission = value.submission ?? "uncertain";
		if (
			submission !== "prepared" &&
			submission !== "uncertain" &&
			submission !== "released" &&
			submission !== "entitlement_rejected"
		)
			return null;
		if (value.storeFunding !== undefined && !isStoreFunding(value.storeFunding)) return null;
		const subscription =
			value.subscription === undefined
				? undefined
				: parseSubscriptionChoice(value.subscription, restoredDraft.computePlanSlug);
		// A store-funded request is admitted by its store row, never by a card or Wallet one.
		if (subscription === null || (subscription && value.storeFunding !== undefined)) return null;
		const walletQuote =
			value.walletQuote === undefined
				? undefined
				: canonicalWalletQuote(value.walletQuote, restoredDraft.computePlanSlug);
		// A new Wallet subscription is its own funding; it never assigns or uses the store.
		if (
			walletQuote === null ||
			(walletQuote && (subscription || value.storeFunding !== undefined)) ||
			(submission === "released" && !walletQuote)
		)
			return null;
		return {
			version: 1,
			submission,
			id: value.id,
			draft: restoredDraft,
			request,
			...(value.storeFunding !== undefined ? { storeFunding: value.storeFunding } : {}),
			...(subscription ? { subscription } : {}),
			...(walletQuote ? { walletQuote } : {}),
		};
	} catch {
		return null;
	}
}

export function canDiscardCreationAttempt(attempt: CreationAttempt): boolean {
	return attempt.submission !== "uncertain";
}

/** Only a store-funded request whose purchase is funded (or covered by a slot) may be admitted. */
export function canAdmitCreationAttempt(attempt: Pick<CreationAttempt, "storeFunding">): boolean {
	return attempt.storeFunding === undefined || attempt.storeFunding === "funded";
}

/** A store purchase may start only before any purchase for this request is in flight. */
export function canStartStorePurchase(attempt: CreationAttempt | null): boolean {
	return (
		!attempt ||
		(canDiscardCreationAttempt(attempt) &&
			(attempt.storeFunding === undefined || attempt.storeFunding === "awaiting_purchase"))
	);
}

/**
 * A pending or completed store purchase keeps its request; discarding would orphan it.
 * A purchase held for billing review may be discarded: buying again cannot resolve it.
 */
export function storeFundingHoldsAttempt(attempt: Pick<CreationAttempt, "storeFunding">): boolean {
	return attempt.storeFunding === "purchase_pending" || attempt.storeFunding === "funded";
}

/** Attempt states that may still produce or confirm a store purchase. */
const ACTIVE_ATTEMPT_STATES = new Set<StorePurchaseAttempt["state"]>([
	"prepared",
	"awaiting_store_result",
	"verification_pending",
]);

/**
 * Plan of an unbound store contract that hosted admission can bind to this request.
 * A compute reserved for a deploy request admits only that request.
 */
export function unboundStoreSlotPlan(
	slot: StoreComputeSlot | null | undefined,
	productPlan: (productId: string) => string | null,
	deployRequestId: string,
): string | null {
	const management = slot?.store_management;
	if (!slot || slot.available || slot.agent_id || !management) return null;
	if (slot.reserved_deploy_request_id && slot.reserved_deploy_request_id !== deployRequestId)
		return null;
	if (!["active", "grace", "canceled_pending_end"].includes(management.state)) return null;
	return productPlan(management.product_id);
}

/**
 * A store-funded reusable row funds a new Agent only when it is this caller's store slot
 * (`store_management.contract_id` = `compute_slot.contract_id`, the documented mapping) and
 * that slot is unbound and unreserved. Its request is then admitted with store funding, so
 * hosted binds exactly this contract and never falls back to other compute.
 */
export function reusableStoreRowPlan(
	item: Pick<ReusableSubscription, "funding_source" | "plan_slug" | "store_management">,
	slot: StoreComputeSlot | null | undefined,
	productPlan: (productId: string) => string | null,
): HostedDeployComputePlanSlug | null {
	const contract = item.store_management?.contract_id;
	if (
		item.funding_source !== "store" ||
		!contract ||
		!slot?.contract_id ||
		slot.contract_id.toLowerCase() !== contract.toLowerCase() ||
		slot.reserved_deploy_request_id
	)
		return null;
	return unboundStoreSlotPlan(slot, productPlan, "") === item.plan_slug ? item.plan_slug : null;
}

export type ReservedDeployResume = Readonly<{ id: string; planSlug: HostedDeployComputePlanSlug }>;

/**
 * Hosted reserves a purchased slot's compute for the deploy request the purchase named
 * and admits only that request with compute_source "store". After a reinstall or on
 * another device the journal lacks it; hosted keeps no draft before admission, so the
 * user completes one for the slot's plan. Any saved attempt takes precedence.
 */
export function reservedDeployResume(
	slot: StoreComputeSlot | null | undefined,
	attempt: CreationAttempt | null,
	productPlan: (productId: string) => string | null,
): ReservedDeployResume | null {
	const id = slot?.reserved_deploy_request_id;
	if (attempt || !id || !CREATION_ID.test(id)) return null;
	const planSlug = unboundStoreSlotPlan(slot, productPlan, id);
	return planSlug && isHostedDeployComputePlan(planSlug) ? { id, planSlug } : null;
}

/**
 * When this request has no live or funded attempt left, it is funded only by an unbound
 * store slot of the same plan: hosted `_select_subscription` first calls
 * `bind_available_store_contract`, which binds an unbound supplying store contract with
 * the request's `plan_slug`. Otherwise the request awaits a new purchase.
 */
function settledStoreFunding(planSlug: string, slotPlan: string | null): StoreFunding {
	return slotPlan === planSlug ? "funded" : "awaiting_purchase";
}

/** Store funding after an explicit status check of this request's hosted attempts. */
export function storeFundingAfterCheck(
	deployRequestId: string,
	attempts: readonly Pick<
		StorePurchaseAttempt,
		"purpose" | "pending_deploy_request_id" | "state"
	>[],
	current: StoreFunding,
	planSlug: string,
	slotPlan: string | null,
): StoreFunding {
	const own = attempts.filter(
		(attempt) =>
			attempt.purpose === "compute_subscription" &&
			attempt.pending_deploy_request_id === deployRequestId,
	);
	if (own.some((attempt) => attempt.state === "funding_applied")) return "funded";
	if (own.some((attempt) => attempt.state === "reconciliation_required")) return "review_required";
	// A live attempt may still be paid; a locally cancelled one may be bought again.
	if (own.some((attempt) => ACTIVE_ATTEMPT_STATES.has(attempt.state)))
		return current === "awaiting_purchase" ? current : "purchase_pending";
	// Expired (abandoned or declined Ask-to-Buy), rejected, canceled, or none at all.
	return settledStoreFunding(planSlug, slotPlan);
}

/** Only this confirmed first-send rejection precedes pending-request persistence.
 * A later rejection cannot settle an earlier uncertain POST. A GET 404 cannot either.
 */
export function isDefinitiveAdmissionRejection(attempt: CreationAttempt, error: unknown): boolean {
	return (
		canDiscardCreationAttempt(attempt) &&
		attempt.storeFunding === undefined &&
		attempt.walletQuote === undefined &&
		error instanceof ApiClientError &&
		error.status === 409 &&
		(error.code === "compute_entitlement_required" ||
			(attempt.subscription !== undefined && error.code === "reusable_subscription_unavailable"))
	);
}

/** Hosted's structured by-request 404 for a deploy request it holds no record of. */
export const DEPLOY_REQUEST_NOT_FOUND_CODE = "deploy_request_not_found";
/** Far beyond hosted's longest Wallet create transaction, including its 2 s lock waits. */
export const WALLET_RELEASE_GRACE_MS = 10 * 60_000;

/**
 * Releases an uncertain new-Wallet request hosted never received. clawdi-hosted
 * `place_wallet_subscription_create` (backend/app/v2/compute/subscription_creation_dispatch.py)
 * refuses a quote whose `expires_at` has passed, then stores the request's
 * PendingDeployRequest and the Wallet dispatch in one ordered transaction; the debit runs
 * only from that committed dispatch. `get_deploy_request_status`
 * (backend/app/v2/hosted/service.py) answers 404 without that row. Only hosted's typed
 * `deploy_request_not_found` 404 counts (a gateway or principal 404 does not), and only
 * once the server's clock is a grace period past the quote's expiry. Retries keep the
 * request's id, so hosted still admits at most one dispatch for it; the proof of no
 * charge also lets the user discard it.
 */
export function releaseWalletRequest(
	attempt: CreationAttempt,
	error: unknown,
): CreationAttempt | null {
	if (
		attempt.submission !== "uncertain" ||
		attempt.walletQuote === undefined ||
		!(error instanceof ApiClientError) ||
		error.status !== 404 ||
		error.code !== DEPLOY_REQUEST_NOT_FOUND_CODE ||
		error.serverDateMs === null ||
		error.serverDateMs < Date.parse(attempt.walletQuote.expires_at) + WALLET_RELEASE_GRACE_MS
	)
		return null;
	return { ...attempt, submission: "released" };
}

/** A Wallet request no send of which can still charge is confirmed on a fresh quote. */
export function walletRequestNeedsQuote(attempt: CreationAttempt | null): boolean {
	return (
		attempt?.walletQuote !== undefined &&
		(attempt.submission === "prepared" || attempt.submission === "released")
	);
}

/**
 * The wizard's confirmation of a fresh Wallet quote against the one the user saw: send
 * only identical terms with no shortfall; otherwise show the new amount and send nothing.
 */
export function walletQuoteConfirmation(
	shown: HostedDeploySubscriptionQuote | null | undefined,
	fresh: HostedDeploySubscriptionQuote,
): "confirmed" | "changed" {
	return shown &&
		sameHostedSubscriptionQuoteTerms(fresh, shown) &&
		walletDebitShortfallUsd(hostedSubscriptionQuoteWalletDebit(fresh)) === null
		? "confirmed"
		: "changed";
}

/** The saved request's recovery controls. */
export function creationAttemptControls(attempt: CreationAttempt, resolved: boolean) {
	return {
		checkStatus: attempt.submission === "uncertain",
		discard: resolved || (canDiscardCreationAttempt(attempt) && !storeFundingHoldsAttempt(attempt)),
	};
}

/**
 * Copy for a failed new-Wallet send. "No wallet payment was made" only for a definitive
 * refusal of the request's first send: never after an earlier uncertain or released send,
 * nor when the shared transport already repeated it.
 */
export function walletCreationErrorCopy(saved: CreationAttempt, error: unknown) {
	return deploySubmissionErrorCopy(
		{
			...deploySubmissionFailure(error),
			firstSend: saved.submission === "prepared" && hostedCheckoutSends(error) === 1,
		},
		"wallet_creation",
	);
}

/** The shared Deploy CTA reading of a mobile API failure, like Web's billing errors. */
export function deploySubmissionFailure(error: unknown): DeploySubmissionFailure {
	if (error instanceof ApiClientNetworkError) return { kind: error.kind, recovery: null };
	if (!(error instanceof ApiClientError)) return { kind: "unknown", recovery: null };
	if (error.status >= 500 || error.status === 429) return { kind: "server", recovery: null };
	return {
		kind: error.status >= 400 ? "rejected" : "unknown",
		code: error.code,
		recovery:
			error.status === 401
				? DEPLOY_SESSION_EXPIRED_RECOVERY
				: deploySubmissionRecoveryCopy({ code: error.code }),
	};
}

/** Store admission failures preserve the purchase and direct recovery of the same request. */
export function storeAdmissionMessageKey(attempt: CreationAttempt, error: unknown) {
	if (!attempt.storeFunding || !(error instanceof ApiClientError)) return null;
	switch (error.code) {
		case "store_compute_unavailable":
			return "creation.storeComputeUnavailable";
		case "store_compute_subscriptions_disabled":
			return "creation.storeComputeDisabled";
		case "compute_entitlement_pending":
		case "deployment_plan_release_pending":
			return "creation.storeComputePending";
		default:
			return null;
	}
}

/** Only a first-send refusal can release store funding for another purchase or discard. */
export function storeAdmissionRecoveryAttempt(
	attempt: CreationAttempt,
	error: unknown,
): CreationAttempt | null {
	return storeAdmissionMessageKey(attempt, error) === "creation.storeComputeUnavailable" &&
		canDiscardCreationAttempt(attempt)
		? { ...attempt, storeFunding: "awaiting_purchase" }
		: null;
}

/**
 * Hosted keeps no draft for a reserved request before admission and exposes none after.
 * Only a by-request 404 proves hosted holds no payload for it, so only then is the user's
 * draft admitted; a request hosted already holds is observed, since a new payload would
 * conflict. Any other pre-check failure admits nothing.
 */
export async function finishReservedRequest(steps: {
	readStatus: () => Promise<unknown>;
	admit: () => Promise<void>;
	observe: () => Promise<void>;
	current: () => boolean;
}): Promise<void> {
	let known: boolean;
	try {
		await steps.readStatus();
		known = true;
	} catch (error) {
		if (!(error instanceof ApiClientError && error.status === 404)) throw error;
		known = false;
	}
	if (!steps.current()) return;
	await (known ? steps.observe() : steps.admit());
}

/**
 * Hosted S2: a late store webhook expires the deploy attempt and leaves an unbound slot,
 * so a refusal can precede the slot this request may bind. Re-read the slot once and
 * repeat the same request only when hosted would now bind it; otherwise keep the refusal.
 */
export async function admitWithStoreSlotRefresh<Data>(
	attempt: CreationAttempt,
	admit: () => Promise<Data>,
	readSlot: () => Promise<StoreComputeSlot | null | undefined>,
	productPlan: (productId: string) => string | null,
): Promise<Data> {
	try {
		return await admit();
	} catch (error) {
		if (storeAdmissionMessageKey(attempt, error) !== "creation.storeComputeUnavailable")
			throw error;
		let slot: StoreComputeSlot | null | undefined;
		try {
			slot = await readSlot();
		} catch {
			throw error;
		}
		if (unboundStoreSlotPlan(slot, productPlan, attempt.id) !== attempt.draft.computePlanSlug)
			throw error;
		return admit();
	}
}

function waitForAdmissionRetry(delayMs: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new Error("Creation action cancelled"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("Creation action cancelled"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** Only explicit store pending responses with Retry-After permit up to three same-key retries. */
export async function retryStoreAdmission<Data>(
	attempt: CreationAttempt,
	send: (signal: AbortSignal) => Promise<Data>,
	signal: AbortSignal,
	wait: (delayMs: number, signal: AbortSignal) => Promise<void> = waitForAdmissionRetry,
): Promise<Data> {
	for (let retries = 0; ; retries++) {
		if (signal.aborted) throw signal.reason ?? new Error("Creation action cancelled");
		try {
			return await send(signal);
		} catch (error) {
			if (
				attempt.storeFunding !== "funded" ||
				!(error instanceof ApiClientError) ||
				error.status !== 409 ||
				(error.code !== "compute_entitlement_pending" &&
					error.code !== "deployment_plan_release_pending") ||
				error.retryAfterMs === null ||
				error.retryAfterMs > 30_000 ||
				retries >= 3
			)
				throw error;
			await wait(error.retryAfterMs, signal);
		}
	}
}

/** Eligible reads expose inventory; POST remains the final permission boundary. */
export function serverAllowsEntitledCreation(
	capabilities: DeployComponents["schemas"]["V1UserProductCapabilities"] | undefined,
	availability: HostedIncludedBasicAvailability | undefined,
	plan: HostedDeployPlan | undefined,
	options: {
		reusable?: readonly DeployComponents["schemas"]["V2ComputeReusableSubscriptionItem"][];
		hasSavedAttempt?: boolean;
	} = {},
): boolean {
	return Boolean(
		capabilities?.can_use_v2 === true &&
			(options.hasSavedAttempt ||
				(plan &&
					isHostedDeployComputePlan(plan.slug) &&
					((plan.slug === "compute_basic" &&
						availability &&
						Number.isFinite(availability.available_slots) &&
						availability.available_slots > 0) ||
						options.reusable?.some((subscription) => subscription.plan_slug === plan.slug)))),
	);
}

export function offeredQuoteSelections(
	plans: readonly HostedDeployPlan[],
): HostedDeploySubscriptionSelection[] {
	return plans.flatMap((plan) => {
		const slug = plan.slug;
		if (!isHostedDeployComputePlan(slug)) return [];
		return (plan.offers?.length ? plan.offers.map((offer) => offer.billing_term_months) : [1])
			.filter(isHostedDeployBillingTerm)
			.map((term) => ({
				planSlug: slug,
				billingTermMonths: term,
				fundingSource: "stripe" as const,
			}));
	});
}

export const validationTranslationKeys = {
	runtime: "creation.invalidRuntime",
	compute: "creation.invalidCompute",
	agentName: "creation.invalidName",
	language: "creation.invalidLanguage",
	timezone: "creation.invalidTimezone",
	"ai.model": "creation.invalidModel",
	"ai.provider": "creation.invalidProvider",
} as const satisfies Record<HostedDeployValidationIssue["field"], string>;
