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
	validateAndBuildHostedDeployRequest,
} from "@clawdi/shared/api";

export type CreationAttempt = {
	version: 1;
	submission: "prepared" | "uncertain" | "entitlement_rejected";
	id: string;
	draft: HostedDeployWizardDraft;
	request: HostedDeployRequest;
};

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
		return { version: 1, submission, id: value.id, draft: restoredDraft, request };
	} catch {
		return null;
	}
}

export function canDiscardCreationAttempt(attempt: CreationAttempt): boolean {
	return attempt.submission !== "uncertain";
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
export function serverAllowsBasicCreation(
	capabilities: DeployComponents["schemas"]["V1UserProductCapabilities"] | undefined,
	availability: HostedIncludedBasicAvailability | undefined,
	basicPlan: HostedDeployPlan | undefined,
	options: {
		reusable?: readonly DeployComponents["schemas"]["V2ComputeReusableSubscriptionItem"][];
		hasSavedAttempt?: boolean;
	} = {},
): boolean {
	return Boolean(
		capabilities?.can_use_v2 === true &&
			(options.hasSavedAttempt ||
				(basicPlan?.slug === "compute_basic" &&
					((availability &&
						Number.isFinite(availability.available_slots) &&
						availability.available_slots > 0) ||
						options.reusable?.some((subscription) => subscription.plan_slug === "compute_basic")))),
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
