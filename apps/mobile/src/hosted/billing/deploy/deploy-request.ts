import {
	ApiClientError,
	type DeployComponents,
	type HostedDeployPlan,
	type HostedDeployRequest,
	type HostedDeploySubscriptionSelection,
	type HostedDeployValidationIssue,
	type HostedDeployWizardDraft,
	type HostedIncludedBasicAvailability,
	isHostedDeployBillingTerm,
	isHostedDeployComputePlan,
	isHostedDeployRuntime,
	type StorePurchaseAttempt,
	validateAndBuildHostedDeployRequest,
} from "@clawdi/shared/api";
import type { PurchaseOutcome } from "@/platform/store/purchase-flow";
import type { PurchaseErrorCode } from "@/platform/store/store-error";

/**
 * Store funding of a request paid through the App Store/Google Play. Hosted keeps no
 * pending deploy request for store attempts, so admission before `funded` would bind
 * other compute and leave the later store purchase without an Agent.
 */
export type StoreFunding = "awaiting_purchase" | "purchase_pending" | "funded";

export type CreationAttempt = {
	version: 1;
	submission: "prepared" | "uncertain" | "entitlement_rejected";
	id: string;
	draft: HostedDeployWizardDraft;
	request: HostedDeployRequest;
	storeFunding?: StoreFunding;
};

function isStoreFunding(value: unknown): value is StoreFunding {
	return value === "awaiting_purchase" || value === "purchase_pending" || value === "funded";
}

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
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
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

/** Only a store-funded request whose own purchase reached `funding_applied` may be admitted. */
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

/** A pending or completed store purchase keeps its request; discarding would orphan it. */
export function storeFundingHoldsAttempt(attempt: Pick<CreationAttempt, "storeFunding">): boolean {
	return attempt.storeFunding === "purchase_pending" || attempt.storeFunding === "funded";
}

/** Purchase errors that prove no store charge was started for this attempt. */
const NO_PURCHASE_ERRORS = new Set<PurchaseErrorCode>([
	"store_offering_unavailable",
	"paywall_unavailable",
	"invalid_purchase_request",
	"store_attempt_conflict",
	"store_purchases_disabled",
	"store_configuration_missing",
	"store_identity_unavailable",
	"identity_mismatch",
]);

/** Store funding after a purchase; anything that may have charged stays pending. */
export function storeFundingAfterPurchase(
	result:
		| {
				outcome: Pick<PurchaseOutcome, "status"> & { attempt: Pick<StorePurchaseAttempt, "state"> };
		  }
		| { error: PurchaseErrorCode },
): StoreFunding {
	if ("error" in result)
		return NO_PURCHASE_ERRORS.has(result.error) ? "awaiting_purchase" : "purchase_pending";
	const { status, attempt } = result.outcome;
	if (status === "funding_applied") return "funded";
	if (status === "cancelled") return "awaiting_purchase";
	if (status === "terminal" && (attempt.state === "rejected" || attempt.state === "canceled"))
		return "awaiting_purchase";
	return "purchase_pending";
}

/** Store funding after an explicit status check of this request's hosted attempts. */
export function storeFundingAfterCheck(
	deployRequestId: string,
	attempts: readonly Pick<
		StorePurchaseAttempt,
		"purpose" | "pending_deploy_request_id" | "state"
	>[],
	current: StoreFunding,
): StoreFunding {
	const own = attempts.filter(
		(attempt) =>
			attempt.purpose === "compute_subscription" &&
			attempt.pending_deploy_request_id === deployRequestId,
	);
	if (own.some((attempt) => attempt.state === "funding_applied")) return "funded";
	if (
		current === "purchase_pending" &&
		own.length > 0 &&
		own.every((attempt) => attempt.state === "rejected" || attempt.state === "canceled")
	)
		return "awaiting_purchase";
	return current;
}

/** Only this confirmed first-send rejection precedes pending-request persistence.
 * A later rejection cannot settle an earlier uncertain POST. A GET 404 cannot either.
 */
export function isDefinitiveAdmissionRejection(attempt: CreationAttempt, error: unknown): boolean {
	return (
		canDiscardCreationAttempt(attempt) &&
		error instanceof ApiClientError &&
		error.status === 409 &&
		error.code === "compute_entitlement_required"
	);
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
