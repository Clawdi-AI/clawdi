import type { components } from "./deploy.generated";

type Schemas = components["schemas"];

export type ComputePlanChangeProgress = Schemas["ComputePlanChangeProgress"];
export type ComputePlanChangeKind = ComputePlanChangeProgress["changeKind"];
export type ComputePlanChangeBillingEffect = ComputePlanChangeProgress["billingEffect"];
export type ComputePlanChangeFundingSource = ComputePlanChangeProgress["fundingSource"];
export type ComputePlanChangeQuoteRequest = Schemas["V2ComputePlanChangeQuoteRequest"];
export type ComputePlanChangeQuoteResponse = Schemas["V2ComputePlanChangeQuoteResponse"];
export type ComputePlanChangeRequest = Schemas["V2ComputePlanChangeRequest"];
export type ComputePortalRequest = Schemas["V2ComputePortalRequest"];

/** A plan change that reached its successful terminal state. */
export type ComputePlanChangeResult = {
	kind: Extract<ComputePlanChangeProgress["state"], "complete" | "scheduled">;
	operationName: string;
	effectiveAt: string;
	changeKind: ComputePlanChangeKind;
	billingEffect: ComputePlanChangeBillingEffect;
	fundingSource: ComputePlanChangeFundingSource;
};

export type ParsedPlanChangeOperation = {
	deploymentId: string;
	done: boolean;
	error: unknown;
	name: string;
	progress: Pick<
		ComputePlanChangeProgress,
		| "@type"
		| "billingEffect"
		| "changeKind"
		| "effectiveAt"
		| "fundingSource"
		| "operationId"
		| "sourcePlanSlug"
		| "state"
		| "subscriptionId"
		| "targetBillingTermMonths"
		| "targetPlanSlug"
	>;
	response:
		| {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse";
				deployment: { id: string };
		  }
		| null
		| undefined;
};

/**
 * The reading of one plan-change operation:
 * - `invalid`: the operation contradicts the plan-change contract;
 * - `pending`: accepted and still running;
 * - `failed`: an explicit failed terminal state, with hosted's problem detail when sent;
 * - `settled`: the change completed or was scheduled.
 */
export type PlanChangeOperationOutcome =
	| { kind: "invalid" }
	| { kind: "pending"; operationName: string }
	| {
			kind: "failed";
			operationName: string;
			changeKind: ComputePlanChangeKind;
			fundingSource: ComputePlanChangeFundingSource;
			/** The first `{status, detail}` entry of the operation error's `details`. */
			problem: (Record<string, unknown> & { status: number; detail: string }) | null;
	  }
	| { kind: "settled"; operationName: string; result: ComputePlanChangeResult };

const CHANGE_KINDS = new Set(["immediate_upgrade", "scheduled_downgrade", "funding_source_switch"]);
const BILLING_EFFECTS = new Set(["immediate_proration", "period_end", "future_renewals"]);
const STATES = new Set<string>([
	"quoted",
	"wallet_debit_pending",
	"wallet_debit_applied",
	"stripe_update_pending",
	"invoice_pending",
	"settlement_pending",
	"awaiting_payment",
	"awaiting_projection",
	"compensation_pending",
	"reversal_pending",
	"reconciliation_required",
	"scheduled",
	"complete",
	"compensated",
	"failed",
	"terminated_paid_unapplied",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function nonBlank(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function readProgress(value: unknown): ParsedPlanChangeOperation["progress"] | null {
	if (
		!isRecord(value) ||
		value["@type"] !== "type.googleapis.com/clawdi.v2.ComputePlanChangeProgress" ||
		!nonEmpty(value.operationId) ||
		typeof value.subscriptionId !== "number" ||
		!Number.isInteger(value.subscriptionId) ||
		value.subscriptionId <= 0 ||
		(value.fundingSource !== "stripe" && value.fundingSource !== "wallet") ||
		typeof value.changeKind !== "string" ||
		!CHANGE_KINDS.has(value.changeKind) ||
		typeof value.billingEffect !== "string" ||
		!BILLING_EFFECTS.has(value.billingEffect) ||
		!nonBlank(value.sourcePlanSlug) ||
		!nonBlank(value.targetPlanSlug) ||
		(value.targetBillingTermMonths !== 1 && value.targetBillingTermMonths !== 12) ||
		typeof value.state !== "string" ||
		!STATES.has(value.state) ||
		!nonBlank(value.effectiveAt)
	)
		return null;
	// Strings are trimmed like the strict schema Web used before this module existed.
	return {
		"@type": value["@type"],
		operationId: value.operationId,
		subscriptionId: value.subscriptionId,
		fundingSource: value.fundingSource,
		changeKind: value.changeKind as ComputePlanChangeKind,
		billingEffect: value.billingEffect as ComputePlanChangeBillingEffect,
		sourcePlanSlug: value.sourcePlanSlug.trim(),
		targetPlanSlug: value.targetPlanSlug.trim(),
		targetBillingTermMonths: value.targetBillingTermMonths,
		state: value.state as ComputePlanChangeProgress["state"],
		effectiveAt: value.effectiveAt.trim(),
	};
}

/**
 * Strictly reads a plan-change long-running operation, or null when it has any other
 * shape. Callers also check `progress.operationId` against the operation name.
 */
export function readPlanChangeOperation(value: unknown): ParsedPlanChangeOperation | null {
	if (!isRecord(value) || !nonEmpty(value.name) || typeof value.done !== "boolean") return null;
	const metadata = value.metadata;
	if (!isRecord(metadata) || !nonEmpty(metadata.deploymentId) || metadata.verb !== "plan_change")
		return null;
	const progress = readProgress(metadata.planChange);
	if (!progress) return null;
	const response = value.response;
	let parsedResponse: ParsedPlanChangeOperation["response"];
	if (response === undefined || response === null) parsedResponse = response;
	else if (
		isRecord(response) &&
		response["@type"] === "type.googleapis.com/clawdi.v2.DeploymentOperationResponse" &&
		isRecord(response.deployment) &&
		nonEmpty(response.deployment.id)
	)
		parsedResponse = {
			"@type": response["@type"],
			deployment: { id: response.deployment.id },
		};
	else return null;
	return {
		deploymentId: metadata.deploymentId,
		name: value.name,
		done: value.done,
		progress,
		error: value.error,
		response: parsedResponse,
	};
}

function hasValidSemantics(progress: ParsedPlanChangeOperation["progress"]): boolean {
	switch (progress.changeKind) {
		case "immediate_upgrade":
			return progress.billingEffect === "immediate_proration";
		case "scheduled_downgrade":
			return progress.billingEffect === "period_end";
		case "funding_source_switch":
			return (
				progress.billingEffect === "future_renewals" &&
				progress.sourcePlanSlug === progress.targetPlanSlug
			);
		default:
			return false;
	}
}

function failureProblem(
	error: unknown,
): Extract<PlanChangeOperationOutcome, { kind: "failed" }>["problem"] {
	if (!isRecord(error) || !Array.isArray(error.details)) return null;
	const detail = error.details.find(
		(item) => isRecord(item) && typeof item.status === "number" && typeof item.detail === "string",
	);
	return isRecord(detail) && typeof detail.status === "number" && typeof detail.detail === "string"
		? (detail as Record<string, unknown> & { status: number; detail: string })
		: null;
}

/** Reads where an accepted plan change stands, like Web's operation polling. */
export function planChangeOperationOutcome(
	operation: ParsedPlanChangeOperation,
): PlanChangeOperationOutcome {
	const { progress } = operation;
	if (!hasValidSemantics(progress)) return { kind: "invalid" };
	const hasError = operation.error !== undefined && operation.error !== null;
	const hasResponse = operation.response !== undefined && operation.response !== null;
	if (!operation.done) {
		return hasError || hasResponse
			? { kind: "invalid" }
			: { kind: "pending", operationName: operation.name };
	}
	if (hasError === hasResponse) return { kind: "invalid" };
	if (hasError) {
		return {
			kind: "failed",
			operationName: operation.name,
			changeKind: progress.changeKind,
			fundingSource: progress.fundingSource,
			problem: failureProblem(operation.error),
		};
	}
	if (operation.response?.deployment.id !== operation.deploymentId) return { kind: "invalid" };
	const settled =
		progress.changeKind === "scheduled_downgrade"
			? progress.state === "scheduled"
			: progress.state === "complete";
	if (!settled) return { kind: "invalid" };
	return {
		kind: "settled",
		operationName: operation.name,
		result: {
			kind: progress.changeKind === "scheduled_downgrade" ? "scheduled" : "complete",
			operationName: operation.name,
			effectiveAt: progress.effectiveAt,
			changeKind: progress.changeKind,
			billingEffect: progress.billingEffect,
			fundingSource: progress.fundingSource,
		},
	};
}

/** The id in an `operations/{id}` name, or null for any other name. */
export function planChangeOperationId(name: string): string | null {
	const prefix = "operations/";
	const operationId = name.startsWith(prefix) ? name.slice(prefix.length) : "";
	return operationId || null;
}
