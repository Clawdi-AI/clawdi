import {
	ApiClientError,
	type DeployComponents,
	type HostedDeployComputePlanSlug,
	type HostedDeployPlan,
	type HostedDeployRequest,
	type HostedDeploySubscriptionSelection,
	type HostedDeployValidationIssue,
	type HostedDeployWizardDraft,
	type HostedIncludedBasicAvailability,
	isHostedDeployBillingTerm,
	isHostedDeployComputePlan,
	isHostedDeployRuntime,
	type StoreComputeSlot,
	type StorePurchaseAttempt,
	validateAndBuildHostedDeployRequest,
} from "@clawdi/shared/api";

/**
 * Store-funded attempts send compute_source "store" at admission; hosted refuses
 * any fallback to other compute. Keep that transport option out of the persisted
 * request, and admit only after the store purchase is funded or covered by a slot.
 */
export type StoreFunding = "awaiting_purchase" | "purchase_pending" | "funded" | "review_required";

export type CreationAttempt = {
	version: 1;
	submission: "prepared" | "uncertain" | "entitlement_rejected";
	id: string;
	draft: HostedDeployWizardDraft;
	request: HostedDeployRequest;
	storeFunding?: StoreFunding;
};

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
		if (ai.mode !== "unmanaged" && !(ai.mode === "managed" && typeof ai.model === "string"))
			return null;
		const restoredDraft: HostedDeployWizardDraft = {
			runtime: draft.runtime,
			computePlanSlug: draft.computePlanSlug,
			agentName: draft.agentName,
			language: draft.language,
			timezone: draft.timezone,
			ai:
				ai.mode === "managed" && typeof ai.model === "string"
					? { mode: "managed", model: ai.model }
					: { mode: "unmanaged" },
		};
		const validated = validateAndBuildHostedDeployRequest(restoredDraft);
		if (!validated.ok) return null;
		const request = { ...validated.request, deploy_request_id: value.id };
		// Reject any persisted payload drift, including missing/mismatched lineage IDs.
		// Never silently migrate or reconstruct a different request for a retry.
		if (JSON.stringify(value.request) !== JSON.stringify(request)) return null;
		// Old journals never recorded whether a POST began. Treat them as uncertain.
		const submission = value.submission ?? "uncertain";
		if (
			submission !== "prepared" &&
			submission !== "uncertain" &&
			submission !== "entitlement_rejected"
		)
			return null;
		if (value.storeFunding !== undefined && !isStoreFunding(value.storeFunding)) return null;
		return {
			version: 1,
			submission,
			id: value.id,
			draft: restoredDraft,
			request,
			...(value.storeFunding !== undefined ? { storeFunding: value.storeFunding } : {}),
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
		(attempt.submission !== "uncertain" &&
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
		error instanceof ApiClientError &&
		error.status === 409 &&
		error.code === "compute_entitlement_required"
	);
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
} as const satisfies Record<HostedDeployValidationIssue["field"], string>;
