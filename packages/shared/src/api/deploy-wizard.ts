import { CLAWDI_MANAGED_PROVIDER_ID } from "../ai-provider";
import type { components as DeployComponents } from "./deploy.generated";

type Schemas = DeployComponents["schemas"];

export type HostedDeployRequest = Schemas["V2HostedDeployRequest"];
export type HostedDeployAiFields = Pick<HostedDeployRequest, "ai_provider_auth_kind"> &
	Partial<
		Pick<
			HostedDeployRequest,
			"ai_provider_bootstrap" | "ai_provider_id" | "primary_model" | "provider_ids"
		>
	>;
export type HostedDeployComputePlanSlug = HostedDeployRequest["compute_plan_slug"];
export type HostedDeployRuntime = HostedDeployRequest["runtime"];
export type HostedDeployLanguage = NonNullable<HostedDeployRequest["language"]>;
export type HostedDeployPlan = Schemas["V2PlanResponse"];
export type HostedDeployBillingOffer = Schemas["V2BillingOfferResponse"];
export type HostedDeployDeployment = Schemas["V2HostedDeploymentReadResponse"];
export type HostedDeployManagedModel = Schemas["V2ManagedModelCatalogItem"];
export type HostedDeploySubscriptionQuote = Schemas["V2ComputeSubscriptionQuoteResponse-Output"];
export type HostedDeploySubscriptionQuoteRequest = Schemas["V2ComputeSubscriptionQuoteRequest"];
export type HostedDeployCheckoutRequest = Schemas["V2ComputeCheckoutRequest"];
export type HostedDeployCheckoutResult = Schemas["V2CheckoutResponse"];
export type HostedDeployOperation = Schemas["LongRunningOperation"];
export type HostedDeployRequestStatus = Schemas["V2HostedDeployRequestReadResponse"];
export type HostedDeployWallet = Schemas["V2WalletResponse"];

export const HOSTED_DEPLOY_RUNTIMES = ["openclaw", "hermes"] as const;
export const HOSTED_DEPLOY_COMPUTE_PLANS = ["compute_basic", "compute_performance"] as const;
export const HOSTED_DEPLOY_BILLING_TERMS = [1, 12] as const;
export const HOSTED_DEPLOY_FUNDING_SOURCES = ["stripe", "wallet"] as const;

export const HOSTED_DEPLOY_LANGUAGE_OPTIONS = [
	{ code: "en", label: "English" },
	{ code: "zh-CN", label: "简体中文" },
	{ code: "zh-TW", label: "繁體中文" },
	{ code: "ja", label: "日本語" },
	{ code: "ko", label: "한국어" },
	{ code: "es", label: "Español" },
	{ code: "fr", label: "Français" },
	{ code: "de", label: "Deutsch" },
	{ code: "pt", label: "Português" },
] as const satisfies readonly { code: HostedDeployLanguage; label: string }[];

const HOSTED_DEPLOY_LANGUAGE_CODES: ReadonlySet<string> = new Set(
	HOSTED_DEPLOY_LANGUAGE_OPTIONS.map((option) => option.code),
);

export const HOSTED_DEPLOY_ASSISTANT_NAME_MAX_LENGTH = 64;
export const DEFAULT_HOSTED_DEPLOY_RUNTIME: HostedDeployRuntime = "hermes";
export const DEFAULT_HOSTED_DEPLOY_AI_ACCESS_MODE = "configured" as const;
export const DEFAULT_HOSTED_DEPLOY_PRIMARY_MODEL = "";
export const DEFAULT_HOSTED_DEPLOY_COMPUTE_PLAN: HostedDeployComputePlanSlug = "compute_basic";
export const DEFAULT_HOSTED_DEPLOY_BILLING_TERM = 1 as const;

const RUNTIME_LABELS: Record<HostedDeployRuntime, string> = {
	hermes: "Hermes",
	openclaw: "OpenClaw",
};

export function hostedDeployRuntimeLabel(runtime: HostedDeployRuntime): string {
	return RUNTIME_LABELS[runtime];
}

export function isHostedDeployRuntime(value: string): value is HostedDeployRuntime {
	return value === "hermes" || value === "openclaw";
}

export function isHostedDeployComputePlan(value: string): value is HostedDeployComputePlanSlug {
	return value === "compute_basic" || value === "compute_performance";
}

export function isHostedDeployBillingTerm(
	value: number,
): value is (typeof HOSTED_DEPLOY_BILLING_TERMS)[number] {
	return value === 1 || value === 12;
}

export function normalizeHostedDeployLanguage(
	value: string | null | undefined,
): HostedDeployLanguage | null {
	if (!value || !HOSTED_DEPLOY_LANGUAGE_CODES.has(value)) return null;
	return HOSTED_DEPLOY_LANGUAGE_OPTIONS.find((option) => option.code === value)?.code ?? null;
}

export function isValidHostedDeployTimezone(value: string): boolean {
	if (!value || value !== value.trim()) return false;
	if (value.toLowerCase() === "factory" || value.toLowerCase() === "localtime") return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
		return true;
	} catch {
		return false;
	}
}

export function hostedDeployAssistantNameAfterRuntimeChange({
	currentName,
	hasBeenEdited,
	runtime,
}: {
	currentName: string;
	hasBeenEdited: boolean;
	runtime: HostedDeployRuntime;
}): string {
	return hasBeenEdited ? currentName : hostedDeployRuntimeLabel(runtime);
}

export type HostedDeployPersona = {
	assistantName: string;
	language: string;
	timezone: string;
};

/**
 * Canonical hosted deploy serialization shared by browser and CLI adapters.
 * It deliberately mirrors persona fields at the legacy top level and in
 * `config` until the generated deploy contract removes that compatibility
 * requirement.
 */
export function buildHostedDeployRequest({
	computePlanSlug,
	runtime,
	persona,
	aiFields,
}: {
	computePlanSlug: HostedDeployComputePlanSlug;
	runtime: HostedDeployRuntime;
	persona: HostedDeployPersona;
	aiFields: HostedDeployAiFields;
}): HostedDeployRequest {
	const assistantName = persona.assistantName.trim();
	const language = normalizeHostedDeployLanguage(persona.language);
	const timezone = persona.timezone.trim() || null;
	const { ai_provider_auth_kind, ...restAiFields } = aiFields;
	const personaFields = {
		assistant_name: assistantName,
		language,
		timezone,
	};
	return {
		compute_plan_slug: computePlanSlug,
		runtime,
		config: {
			runtime,
			...personaFields,
		},
		...personaFields,
		ai_provider_auth_kind,
		...restAiFields,
	};
}

export type HostedDeployWizardAiSelection =
	| { mode: "managed"; model: string }
	| { mode: "unmanaged" };

export type HostedDeployWizardDraft = {
	runtime: HostedDeployRuntime;
	computePlanSlug: HostedDeployComputePlanSlug;
	assistantName: string;
	language: string;
	timezone: string;
	ai: HostedDeployWizardAiSelection;
};

export type HostedDeployValidationIssue = {
	field: "runtime" | "compute" | "assistantName" | "language" | "timezone" | "ai.model";
	message: string;
};

export type HostedDeployValidationResult =
	| { ok: true; request: HostedDeployRequest }
	| { ok: false; issues: HostedDeployValidationIssue[] };

/** Shared persona boundary used by both the browser and terminal adapters. */
export function validateHostedDeployPersona(
	persona: HostedDeployPersona,
): HostedDeployValidationIssue[] {
	const issues: HostedDeployValidationIssue[] = [];
	const assistantName = persona.assistantName.trim();
	if (!assistantName) {
		issues.push({ field: "assistantName", message: "Enter a name for this agent." });
	} else if (assistantName.length > HOSTED_DEPLOY_ASSISTANT_NAME_MAX_LENGTH) {
		issues.push({
			field: "assistantName",
			message: `Use ${HOSTED_DEPLOY_ASSISTANT_NAME_MAX_LENGTH} characters or fewer.`,
		});
	}
	if (persona.language && !normalizeHostedDeployLanguage(persona.language)) {
		issues.push({ field: "language", message: "Choose a supported language." });
	}
	if (persona.timezone && !isValidHostedDeployTimezone(persona.timezone)) {
		issues.push({ field: "timezone", message: "Use a valid IANA timezone or leave it empty." });
	}
	return issues;
}

/** Validate the CLI/Web wizard boundary and build the generated request type. */
export function validateAndBuildHostedDeployRequest(
	draft: HostedDeployWizardDraft,
	managedModels: readonly HostedDeployManagedModel[] = [],
): HostedDeployValidationResult {
	const assistantName = draft.assistantName.trim();
	const issues = validateHostedDeployPersona({
		assistantName,
		language: draft.language,
		timezone: draft.timezone,
	});

	let aiFields: HostedDeployAiFields;
	if (draft.ai.mode === "unmanaged") {
		aiFields = { ai_provider_auth_kind: "unmanaged" };
	} else {
		const model = draft.ai.model.trim();
		if (!model) {
			issues.push({ field: "ai.model", message: "Choose a managed AI model." });
		} else if (
			managedModels.length > 0 &&
			!managedModels.some((catalogModel) => catalogModel.id === model)
		) {
			issues.push({ field: "ai.model", message: "Choose a model from the managed catalog." });
		}
		aiFields = {
			ai_provider_auth_kind: "managed",
			ai_provider_id: null,
			provider_ids: [CLAWDI_MANAGED_PROVIDER_ID],
			primary_model: model ? { provider_id: CLAWDI_MANAGED_PROVIDER_ID, model } : null,
		};
	}

	if (issues.length > 0) return { ok: false, issues };
	return {
		ok: true,
		request: buildHostedDeployRequest({
			computePlanSlug: draft.computePlanSlug,
			runtime: draft.runtime,
			persona: {
				assistantName,
				language: draft.language,
				timezone: draft.timezone,
			},
			aiFields,
		}),
	};
}

export type IncludedBasicDeploySelection =
	| {
			mode: "included";
			computePlanSlug: "compute_basic";
			plan: HostedDeployPlan;
	  }
	| {
			mode: "checkout";
			billingTermMonths: number;
			computePlanSlug: "compute_basic";
			offer: HostedDeployBillingOffer;
			plan: HostedDeployPlan;
	  }
	| {
			mode: "unavailable";
			reason: "plan_missing" | "offers_missing" | "inventory_unavailable";
	  };

function hasIncludedBasicSubscription(deployment: HostedDeployDeployment): boolean {
	const subscription = deployment.commercial_display?.compute_subscription;
	return (
		deployment.current_plan_slug === "compute_basic" &&
		subscription != null &&
		subscription.funding_source == null &&
		subscription.price_cents === 0
	);
}

export function usesHostedDeployIncludedBasicSlot(
	deployments: readonly HostedDeployDeployment[] | undefined,
): boolean | null {
	let occupancyUnavailable = false;
	for (const deployment of deployments ?? []) {
		if (!hasIncludedBasicSubscription(deployment)) continue;
		const occupancy = deployment.compute_slot_occupancy;
		if (occupancy === null) {
			occupancyUnavailable = true;
			continue;
		}
		if (occupancy.occupies_slot) return true;
	}
	return occupancyUnavailable ? null : false;
}

export function selectHostedDeployOfferForTerm(
	plan: HostedDeployPlan,
	term: number,
	options: { requireExplicit?: boolean } = {},
): { offer: HostedDeployBillingOffer; billingTermMonths: number } | null {
	const offers = plan.offers?.length
		? plan.offers
		: options.requireExplicit
			? []
			: [
					{
						billing_term_months: 1,
						price_cents: plan.price_cents,
						effective_monthly_price_cents: plan.price_cents,
						discount_percent: 0,
					},
				];
	const offer = offers.find((candidate) => candidate.billing_term_months === term) ?? offers[0];
	return offer ? { offer, billingTermMonths: offer.billing_term_months } : null;
}

export function resolveHostedDeployIncludedBasicSelection({
	basicPlan,
	billingTermMonths,
	includedSlotAvailable,
}: {
	basicPlan: HostedDeployPlan | undefined;
	billingTermMonths: number;
	includedSlotAvailable: boolean | null;
}): IncludedBasicDeploySelection {
	if (!basicPlan) return { mode: "unavailable", reason: "plan_missing" };
	if (includedSlotAvailable === null) {
		return { mode: "unavailable", reason: "inventory_unavailable" };
	}
	if (includedSlotAvailable) {
		return { mode: "included", computePlanSlug: "compute_basic", plan: basicPlan };
	}
	const selection = selectHostedDeployOfferForTerm(basicPlan, billingTermMonths, {
		requireExplicit: true,
	});
	if (!selection) return { mode: "unavailable", reason: "offers_missing" };
	return {
		mode: "checkout",
		billingTermMonths: selection.billingTermMonths,
		computePlanSlug: "compute_basic",
		offer: selection.offer,
		plan: basicPlan,
	};
}

export type HostedDeploySubscriptionSelection = {
	planSlug: HostedDeployComputePlanSlug;
	billingTermMonths: (typeof HOSTED_DEPLOY_BILLING_TERMS)[number];
	fundingSource: (typeof HOSTED_DEPLOY_FUNDING_SOURCES)[number];
};

export type HostedDeployCheckoutUiMode = "custom" | "hosted";

export type HostedDeployCheckoutTarget =
	| { kind: "new_deployment"; deployRequest: HostedDeployRequest }
	| { kind: "upgrade_deployment"; deploymentId: string };

export function buildHostedDeploySubscriptionQuoteRequest(
	selection: HostedDeploySubscriptionSelection,
): HostedDeploySubscriptionQuoteRequest {
	return {
		plan_slug: selection.planSlug,
		billing_term_months: selection.billingTermMonths,
		funding_source: selection.fundingSource,
	};
}

export function buildHostedDeployCheckoutRequest({
	selection,
	target,
	idempotencyKey,
	quote,
	uiMode,
}: {
	selection: HostedDeploySubscriptionSelection;
	target: HostedDeployCheckoutTarget;
	idempotencyKey: string;
	quote: HostedDeploySubscriptionQuote | null;
	uiMode: HostedDeployCheckoutUiMode;
}): HostedDeployCheckoutRequest {
	return {
		plan_slug: selection.planSlug,
		billing_term_months: selection.billingTermMonths,
		funding_source: selection.fundingSource,
		ui_mode: uiMode,
		...(target.kind === "new_deployment"
			? {
					deploy_config: {
						...target.deployRequest,
						deploy_request_id: target.deployRequest.deploy_request_id ?? idempotencyKey,
					},
				}
			: { upgrade_deployment_id: target.deploymentId }),
		...(selection.fundingSource === "wallet" && quote ? { quote } : {}),
	};
}

export type HostedDeployRequestProjection =
	| {
			kind: "terminal";
			requestStatus: "failed" | "expired" | "superseded";
	  }
	| {
			kind: "operation";
			deploymentId: string | null;
			operation: HostedDeployOperation;
	  }
	| {
			kind: "operation_name";
			deploymentId: string | null;
			operationName: string;
	  }
	| {
			kind: "deployment";
			completed: boolean;
			deploymentId: string;
	  }
	| { kind: "invalid_success" }
	| { kind: "wait" };

/** Pure interpretation of the public deploy-request lineage projection. */
export function projectHostedDeployRequest(
	status: HostedDeployRequestStatus,
): HostedDeployRequestProjection {
	if (
		status.request_status === "failed" ||
		status.request_status === "expired" ||
		status.request_status === "superseded"
	) {
		return { kind: "terminal", requestStatus: status.request_status };
	}
	const deploymentId = status.lineage_tail?.deployment_id?.trim() || null;
	const operation = status.lineage_tail?.operation ?? null;
	if (operation) return { kind: "operation", deploymentId, operation };
	if (
		deploymentId &&
		(status.request_status === "processing" || status.request_status === "succeeded")
	) {
		return {
			kind: "deployment",
			completed: status.request_status === "succeeded",
			deploymentId,
		};
	}
	const operationName = status.lineage_tail?.operation_name?.trim() || "";
	if (operationName) return { kind: "operation_name", deploymentId, operationName };
	if (status.request_status === "succeeded") return { kind: "invalid_success" };
	return { kind: "wait" };
}
