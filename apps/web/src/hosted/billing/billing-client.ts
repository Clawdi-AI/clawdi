"use client";

import {
	type AiProviderRemovalImpact,
	type AiProviderRemovalResult,
	type DeployPaths,
	extractApiDetail,
	projectHostedDeployRequest,
	unwrapDeploymentEventStreamSnapshotHandoff,
	unwrapDeploymentList,
} from "@clawdi/shared/api";
import createClient from "openapi-fetch";
import { useMemo } from "react";
import { z } from "zod";
import { isDeployApiConfigured } from "@/hosted/access/api";
import { hostedApiBaseUrl } from "@/hosted/billing/billing-url";
import type {
	CheckoutRequest,
	ComputeCancelScheduledPlanChangeRequest,
	ComputeFixPaymentRequest,
	ComputePlanChangeProgress,
	ComputePlanChangeQuoteRequest,
	ComputePlanChangeRequest,
	ComputePlanChangeResult,
	ComputeSubscriptionCancelRequest,
	ComputeSubscriptionQuoteRequest,
	ComputeSubscriptionResumeRequest,
	DeploymentCreateRequest,
	DeploymentDeleteConvergedResponse,
	DeploymentDeleteRequest,
	DeploymentDesiredLifecycle,
	DeploymentOperation,
	DeploymentUpdateRequest,
	HostedDeployment,
	HostedDeployRequestStatus,
	HostedWorkspaceSkillInstallRequest,
	HostedWorkspaceSkillListResponse,
	HostedWorkspaceSkillMutationResponse,
	PortalRequest,
	WalletAutoReloadRequest,
	WalletAutoReloadSetupFinalizeRequest,
	WalletAutoReloadSetupRequest,
	WalletBindingChallengeRequest,
	WalletBindingVerifyRequest,
	WalletTopupRequest,
} from "@/hosted/billing/contracts";
import {
	BillingApiError,
	BillingNetworkError,
	billingErrorDetail,
	DeploymentConflictError,
	DeploymentRequestTerminalError,
	isRetryableError,
	PlanChangePendingError,
	PlanChangeTerminalError,
} from "@/hosted/billing/errors";
import { useAuthToken } from "@/lib/auth-client";
import { env } from "@/lib/env";

const BASE_URL = env.VITE_CLAWDI_DEPLOY_API_URL;
const ROOT_BASE_URL = hostedApiBaseUrl(BASE_URL);

export const BILLING_API_ORIGIN = new URL(ROOT_BASE_URL).origin;

const REQUEST_TIMEOUT_MS = 20_000;
const CHECKOUT_PATH = "/v2/subscription/checkout";
const MAX_CHECKOUT_ATTEMPTS = 3;
const MAX_CHECKOUT_RETRY_AFTER_MS = 2_000;
const RETRYABLE_IDEMPOTENT_POST_PATHS = new Set([
	CHECKOUT_PATH,
	"/v2/wallet/topup",
	"/v2/wallet/auto-reload/setup-intent",
]);

export { isDeployApiConfigured };

type DeployResult<T> = { data?: T; error?: unknown; response: Response };
type BillingFetch = (request: Request) => Promise<Response>;
type BillingAuthTokenGetter = () => Promise<string | null | undefined>;

export type AcceptedOperation = { deploymentId: string; operation: DeploymentOperation };
export type DeploymentDeleteResult = AcceptedOperation | { deploymentId: string; operation: null };

export type BillingClientOptions = {
	fetch?: BillingFetch;
	operationPollIntervalMs?: number;
	operationPollLimit?: number;
	deploymentRequestTimeoutMs?: number;
	sleep?: (delayMs: number) => Promise<void>;
};

type MutationHeaders = {
	"Idempotency-Key": string;
	"If-Match": string;
};

type WorkspaceSkillMutation =
	| { action: "install"; request: HostedWorkspaceSkillInstallRequest }
	| { action: "uninstall"; skillKey: string };

function fetchWithTimeout(request: Request, init?: RequestInit): Promise<Response> {
	const caller = init?.signal ?? request.signal;
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort();
	if (caller?.aborted) {
		controller.abort();
	} else {
		caller?.addEventListener("abort", onAbort, { once: true });
	}
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, REQUEST_TIMEOUT_MS);
	return fetch(request, { ...init, signal: controller.signal })
		.catch((cause: unknown) => {
			if (timedOut) throw new BillingNetworkError("timeout", { cause });
			if (caller?.aborted) throw cause;
			throw new BillingNetworkError("offline", { cause });
		})
		.finally(() => {
			clearTimeout(timeoutId);
			caller?.removeEventListener("abort", onAbort);
		});
}

function checkoutRetryDelay(response: Response): number | null {
	if (response.status !== 409 && response.status !== 503) return null;
	const retryAfter = response.headers.get("Retry-After");
	if (retryAfter === null) return null;
	const seconds = Number(retryAfter);
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	const delayMs = seconds * 1_000;
	return delayMs <= MAX_CHECKOUT_RETRY_AFTER_MS ? delayMs : null;
}

function throwIfAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export function retryIdempotentBillingTransport(
	fetcher: BillingFetch,
	sleep: (delayMs: number) => Promise<void> = (delayMs) =>
		new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs)),
): BillingFetch {
	return async (request) => {
		const path = new URL(request.url).pathname;
		const retryable =
			request.method === "POST" &&
			RETRYABLE_IDEMPOTENT_POST_PATHS.has(path) &&
			!!request.headers.get("Idempotency-Key")?.trim();
		if (!retryable) return fetcher(request);

		const maxAttempts = path === CHECKOUT_PATH ? MAX_CHECKOUT_ATTEMPTS : 2;
		const attempts = Array.from({ length: maxAttempts }, (_, index) =>
			index === 0 ? request : request.clone(),
		);
		for (let attempt = 0; attempt < attempts.length; attempt += 1) {
			throwIfAborted(request.signal);
			let response: Response;
			try {
				response = await fetcher(attempts[attempt] as Request);
			} catch (error) {
				if (
					!(error instanceof BillingNetworkError) ||
					request.signal.aborted ||
					attempt === attempts.length - 1
				) {
					throw error;
				}
				continue;
			}

			const delayMs = path === CHECKOUT_PATH ? checkoutRetryDelay(response) : null;
			if (delayMs === null || attempt === attempts.length - 1) return response;
			await sleep(delayMs);
		}
		throw new BillingNetworkError("offline");
	};
}

export function unwrapDeploy<T>(result: DeployResult<T>): T {
	if (result.error !== undefined || !result.response.ok) {
		const detail =
			result.error === undefined ? result.response.statusText : extractApiDetail(result.error);
		throw new BillingApiError(result.response.status, detail, result.error);
	}
	return result.data as T;
}

function operationIdFromName(name: string): string {
	const prefix = "operations/";
	const operationId = name.startsWith(prefix) ? name.slice(prefix.length) : "";
	if (!operationId) {
		throw new BillingApiError(502, "The agent service returned an invalid operation name.");
	}
	return operationId;
}

function deploymentIdFromOperation(operation: DeploymentOperation): string | null {
	const metadataId = operation.metadata?.deploymentId?.trim();
	if (metadataId) return metadataId;
	return operation.response?.["@type"] ===
		"type.googleapis.com/clawdi.v2.DeploymentOperationResponse"
		? operation.response.deployment.id.trim() || null
		: null;
}

export function acceptDeclarativeOperation<T extends DeploymentOperation | null>(
	acceptance: {
		operation: T;
		deploymentId?: string | null;
	},
	missingDeploymentMessage = "The agent service completed creation without returning the agent.",
): {
	deploymentId: string;
	operation: T;
} {
	const deploymentId =
		(acceptance.operation ? deploymentIdFromOperation(acceptance.operation) : null) ||
		acceptance.deploymentId?.trim() ||
		null;
	if (!deploymentId) throw new BillingApiError(502, missingDeploymentMessage);
	return { deploymentId, operation: acceptance.operation };
}

function strongResourceEtag(resourceVersion: string): string {
	const valid =
		resourceVersion.length > 0 &&
		resourceVersion.length <= 128 &&
		Array.from(resourceVersion).every((character) => {
			const code = character.charCodeAt(0);
			return code >= 0x21 && code <= 0x7e && character !== '"' && character !== "\\";
		});
	if (!valid) {
		throw new BillingApiError(502, "The agent service returned an invalid resource version.");
	}
	return `"${resourceVersion}"`;
}

function isPreconditionConflict(error: unknown): error is BillingApiError {
	return (
		error instanceof BillingApiError &&
		(error.status === 409 || error.status === 412) &&
		billingErrorDetail(error)?.code !== "funding_revoked_after_accept"
	);
}

function isNotFound(error: unknown): error is BillingApiError {
	return error instanceof BillingApiError && error.status === 404;
}

// The absent-row branch in the hosted repo's backend/app/v2/routes.py requires
// If-Match to be present but has no local resource version to compare against.
const ABSENT_DEPLOYMENT_RESOURCE_VERSION = "absent";

function acceptDeploymentDelete(
	response: DeploymentOperation | DeploymentDeleteConvergedResponse,
): DeploymentDeleteResult {
	return "status" in response
		? acceptDeclarativeOperation({ deploymentId: response.deployment_id, operation: null })
		: acceptDeclarativeOperation({ operation: response });
}

function isWorkspaceSkillResourceVersionConflict(error: unknown): error is BillingApiError {
	return (
		error instanceof BillingApiError &&
		(error.status === 412 || billingErrorDetail(error)?.code === "resource_version_mismatch")
	);
}

function terminalDeployRequestError(status: HostedDeployRequestStatus): BillingApiError {
	return new DeploymentRequestTerminalError(
		status,
		status.request_status === "superseded"
			? "This agent creation was superseded by a newer attempt."
			: "The agent could not be created.",
	);
}

function isTransientDeployRequestRead(error: unknown): boolean {
	return (
		isRetryableError(error) ||
		(error instanceof BillingApiError &&
			(error.status === 404 || error.status === 408 || error.status === 425))
	);
}

type ParsedPlanChangeProgress = Pick<
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

type DeploymentOperationSuccessResponse = Extract<
	NonNullable<DeploymentOperation["response"]>,
	{ "@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse" }
>;

type ParsedPlanChangeResponse = Pick<DeploymentOperationSuccessResponse, "@type"> & {
	deployment: Pick<DeploymentOperationSuccessResponse["deployment"], "id">;
};

type ParsedPlanChangeOperation = {
	deploymentId: string;
	done: boolean;
	error: unknown;
	name: string;
	progress: ParsedPlanChangeProgress;
	response: ParsedPlanChangeResponse | null | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function invalidPlanChangeResponse(): BillingApiError {
	return new BillingApiError(
		502,
		"We couldn't verify the subscription change status. Check again in a moment.",
	);
}

const planChangeProgressSchema: z.ZodType<ParsedPlanChangeProgress> = z.object({
	"@type": z.literal("type.googleapis.com/clawdi.v2.ComputePlanChangeProgress"),
	operationId: z.string().min(1),
	subscriptionId: z.number().int().positive(),
	fundingSource: z.enum(["stripe", "wallet"]),
	changeKind: z.enum(["immediate_upgrade", "scheduled_downgrade", "funding_source_switch"]),
	billingEffect: z.enum(["immediate_proration", "period_end", "future_renewals"]),
	sourcePlanSlug: z.string().trim().min(1),
	targetPlanSlug: z.string().trim().min(1),
	targetBillingTermMonths: z.union([z.literal(1), z.literal(12)]),
	state: z.enum([
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
	]),
	effectiveAt: z.string().trim().min(1),
});

const planChangeOperationSchema = z.object({
	name: z.string().min(1),
	metadata: z.object({
		deploymentId: z.string().min(1),
		verb: z.literal("plan_change"),
		planChange: planChangeProgressSchema,
	}),
	done: z.boolean(),
	error: z.unknown().nullable().optional(),
	response: z
		.object({
			"@type": z.literal("type.googleapis.com/clawdi.v2.DeploymentOperationResponse"),
			deployment: z.object({ id: z.string().min(1) }),
		})
		.nullable()
		.optional(),
});

function parsePlanChangeOperation(value: unknown): ParsedPlanChangeOperation {
	const parsed = planChangeOperationSchema.safeParse(value);
	if (!parsed.success) {
		throw invalidPlanChangeResponse();
	}
	const operationId = operationIdFromName(parsed.data.name);
	const progress = parsed.data.metadata.planChange;
	if (progress.operationId !== operationId) throw invalidPlanChangeResponse();
	return {
		deploymentId: parsed.data.metadata.deploymentId,
		name: parsed.data.name,
		done: parsed.data.done,
		progress,
		error: parsed.data.error,
		response: parsed.data.response,
	};
}

function hasValidPlanChangeSemantics(progress: ParsedPlanChangeProgress): boolean {
	if (
		!progress.effectiveAt?.trim() ||
		(progress.fundingSource !== "stripe" && progress.fundingSource !== "wallet")
	) {
		return false;
	}
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

function planChangeTerminalError(
	error: unknown,
	operation: ParsedPlanChangeOperation,
): BillingApiError {
	if (isRecord(error) && Array.isArray(error.details)) {
		const detail = error.details.find(
			(item) =>
				isRecord(item) && typeof item.status === "number" && typeof item.detail === "string",
		);
		if (
			isRecord(detail) &&
			typeof detail.status === "number" &&
			typeof detail.detail === "string"
		) {
			return new PlanChangeTerminalError(
				detail.status,
				detail.detail,
				{ detail },
				operation.progress.changeKind,
				operation.progress.fundingSource,
				operation.name,
			);
		}
	}
	return new PlanChangeTerminalError(
		409,
		"The subscription change could not be completed. Review the details and try again.",
		undefined,
		operation.progress.changeKind,
		operation.progress.fundingSource,
		operation.name,
	);
}

function completedPlanChange(operation: ParsedPlanChangeOperation): ComputePlanChangeResult | null {
	if (!hasValidPlanChangeSemantics(operation.progress)) {
		throw invalidPlanChangeResponse();
	}
	if (!operation.done) {
		if (
			(operation.error !== undefined && operation.error !== null) ||
			(operation.response !== undefined && operation.response !== null)
		) {
			throw invalidPlanChangeResponse();
		}
		return null;
	}
	const hasError = operation.error !== undefined && operation.error !== null;
	const hasResponse = operation.response !== undefined && operation.response !== null;
	if (hasError === hasResponse) throw invalidPlanChangeResponse();
	if (hasError) {
		throw planChangeTerminalError(operation.error, operation);
	}
	if (operation.response?.deployment.id !== operation.deploymentId) {
		throw invalidPlanChangeResponse();
	}
	if (
		operation.progress.changeKind === "scheduled_downgrade" &&
		operation.progress.state === "scheduled"
	) {
		return {
			kind: "scheduled",
			operationName: operation.name,
			effectiveAt: operation.progress.effectiveAt,
			changeKind: operation.progress.changeKind,
			billingEffect: operation.progress.billingEffect,
			fundingSource: operation.progress.fundingSource,
		};
	}
	if (
		operation.progress.changeKind !== "scheduled_downgrade" &&
		operation.progress.state === "complete"
	) {
		return {
			kind: "complete",
			operationName: operation.name,
			effectiveAt: operation.progress.effectiveAt,
			changeKind: operation.progress.changeKind,
			billingEffect: operation.progress.billingEffect,
			fundingSource: operation.progress.fundingSource,
		};
	}
	throw invalidPlanChangeResponse();
}

/**
 * Generated deploy-api client facade. Request/response bodies come from
 * `packages/shared/src/api/deploy.generated.ts`; this hook only centralizes
 * auth, timeout, and billing-specific error normalization.
 */
export function createBillingClient(
	getToken: BillingAuthTokenGetter,
	options: BillingClientOptions = {},
) {
	const sleep =
		options.sleep ??
		((delayMs: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs)));
	const api = createClient<DeployPaths>({
		baseUrl: ROOT_BASE_URL,
		fetch: retryIdempotentBillingTransport(options.fetch ?? fetchWithTimeout, sleep),
	});
	api.use({
		async onRequest({ request }) {
			const token = await getToken();
			if (token) request.headers.set("Authorization", `Bearer ${token}`);
			return request;
		},
	});

	const configuredPollIntervalMs = options.operationPollIntervalMs ?? 1_000;
	const pollIntervalMs = Number.isFinite(configuredPollIntervalMs)
		? Math.max(0, configuredPollIntervalMs)
		: 1_000;
	const configuredPollLimit = options.operationPollLimit ?? 120;
	const pollLimit = Number.isFinite(configuredPollLimit)
		? Math.max(0, Math.floor(configuredPollLimit))
		: 120;
	const configuredDeploymentRequestTimeoutMs = options.deploymentRequestTimeoutMs ?? 120_000;
	const deploymentRequestTimeoutMs = Number.isFinite(configuredDeploymentRequestTimeoutMs)
		? Math.max(0, configuredDeploymentRequestTimeoutMs)
		: 120_000;
	const getDeployment = async (id: string): Promise<HostedDeployment> =>
		unwrapDeploy(
			await api.GET("/v2/deployments/{deployment_id}", {
				params: { path: { deployment_id: id } },
			}),
		);
	const getDeploymentEventStreamHandoff = async (signal?: AbortSignal) =>
		unwrapDeploymentEventStreamSnapshotHandoff(
			unwrapDeploy(
				await api.GET("/v2/deployments", {
					params: { query: { eventStreamHandoff: true } },
					signal,
				}),
			),
		);
	const openDeploymentEventStream = async (
		deploymentId: string | null,
		cursor: string,
		signal: AbortSignal,
	): Promise<Response> => {
		const token = await getToken();
		const headers = new Headers({
			Accept: "text/event-stream",
			"Last-Event-ID": cursor,
		});
		if (token) headers.set("Authorization", `Bearer ${token}`);
		const path = deploymentId
			? `/v2/deployments/${encodeURIComponent(deploymentId)}/events`
			: "/v2/events";
		return fetch(new URL(path, `${ROOT_BASE_URL}/`), {
			headers,
			signal,
			cache: "no-store",
		});
	};

	const getOperation = async (
		operationId: string,
		signal?: AbortSignal,
	): Promise<DeploymentOperation> =>
		unwrapDeploy(
			await api.GET("/v2/operations/{operation_id}", {
				params: { path: { operation_id: operationId } },
				signal,
			}),
		);

	const waitForPlanChange = async (
		initial: DeploymentOperation,
		expectedOperationId: string,
		onAccepted?: (operationName: string) => void,
	): Promise<ComputePlanChangeResult> => {
		let operation = parsePlanChangeOperation(initial);
		if (operationIdFromName(operation.name) !== expectedOperationId) {
			throw invalidPlanChangeResponse();
		}
		onAccepted?.(operation.name);
		for (let poll = 0; poll <= pollLimit; poll += 1) {
			const completed = completedPlanChange(operation);
			if (completed) return completed;
			if (poll === pollLimit) throw new PlanChangePendingError(operation.name);
			await sleep(pollIntervalMs);
			operation = parsePlanChangeOperation(await getOperation(operationIdFromName(operation.name)));
		}
		throw new PlanChangePendingError(operation.name);
	};

	const getDeploymentByRequest = async (
		deployRequestId: string,
		signal?: AbortSignal,
	): Promise<HostedDeployRequestStatus> =>
		unwrapDeploy(
			await api.GET("/v2/deployments/by-request/{deploy_request_id}", {
				params: { path: { deploy_request_id: deployRequestId } },
				signal,
			}),
		);

	const waitForDeploymentRequest = async (deployRequestId: string) => {
		let lastTransientError: unknown;
		const deadline = Date.now() + deploymentRequestTimeoutMs;
		for (let poll = 0; poll <= pollLimit && Date.now() < deadline; poll += 1) {
			const requestController = new AbortController();
			const requestTimeoutId = globalThis.setTimeout(
				() => requestController.abort(),
				Math.max(0, deadline - Date.now()),
			);
			let status: HostedDeployRequestStatus;
			try {
				status = await getDeploymentByRequest(deployRequestId, requestController.signal);
			} catch (error) {
				if (requestController.signal.aborted) break;
				if (!isTransientDeployRequestRead(error)) throw error;
				lastTransientError = error;
				if (poll === pollLimit) break;
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) break;
				await sleep(Math.min(pollIntervalMs, remainingMs));
				continue;
			} finally {
				globalThis.clearTimeout(requestTimeoutId);
			}
			const projection = projectHostedDeployRequest(status);
			if (projection.kind === "terminal") {
				throw terminalDeployRequestError(status);
			}
			if (projection.kind === "operation") {
				return {
					...acceptDeclarativeOperation({
						operation: projection.operation,
						deploymentId: projection.deploymentId,
					}),
					agentId: projection.agentId,
				};
			}
			if (projection.kind === "operation_name") {
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) break;
				const operationController = new AbortController();
				const operationTimeoutId = globalThis.setTimeout(
					() => operationController.abort(),
					remainingMs,
				);
				let operation: DeploymentOperation;
				try {
					operation = await getOperation(
						operationIdFromName(projection.operationName),
						operationController.signal,
					);
				} catch (error) {
					if (operationController.signal.aborted) break;
					throw error;
				} finally {
					globalThis.clearTimeout(operationTimeoutId);
				}
				return {
					...acceptDeclarativeOperation({
						operation,
						deploymentId: projection.deploymentId,
					}),
					agentId: projection.agentId,
				};
			}
			if (projection.kind === "deployment") {
				return {
					...acceptDeclarativeOperation({
						deploymentId: projection.deploymentId,
						operation: null,
					}),
					agentId: projection.agentId,
				};
			}
			if (projection.kind === "invalid_success") {
				return acceptDeclarativeOperation({ deploymentId: null, operation: null });
			}
			lastTransientError = undefined;
			if (poll === pollLimit) break;
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) break;
			await sleep(Math.min(pollIntervalMs, remainingMs));
		}
		throw new BillingNetworkError("timeout", { cause: lastTransientError });
	};

	const acceptDeploymentMutation = async (
		id: string,
		idempotencyKey: string,
		send: (headers: MutationHeaders) => Promise<DeployResult<DeploymentOperation>>,
	): Promise<AcceptedOperation> => {
		let deployment = await getDeployment(id);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const headers: MutationHeaders = {
				"Idempotency-Key": idempotencyKey,
				"If-Match": strongResourceEtag(deployment.resource.metadata.resourceVersion),
			};
			try {
				return acceptDeclarativeOperation({ operation: unwrapDeploy(await send(headers)) });
			} catch (error) {
				if (!isPreconditionConflict(error)) throw error;
				if (attempt === 0) {
					deployment = await getDeployment(id);
					continue;
				}
				throw new DeploymentConflictError({ cause: error });
			}
		}
		throw new DeploymentConflictError();
	};
	const deleteDeployment = async (
		id: string,
		body: DeploymentDeleteRequest,
		idempotencyKey: string,
		lastKnownResourceVersion?: string,
	): Promise<DeploymentDeleteResult> => {
		let resourceVersion: string;
		try {
			resourceVersion = (await getDeployment(id)).resource.metadata.resourceVersion;
		} catch (error) {
			if (!isNotFound(error)) throw error;
			resourceVersion = lastKnownResourceVersion ?? ABSENT_DEPLOYMENT_RESOURCE_VERSION;
		}

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const headers: MutationHeaders = {
				"Idempotency-Key": idempotencyKey,
				"If-Match": strongResourceEtag(resourceVersion),
			};
			try {
				return acceptDeploymentDelete(
					unwrapDeploy(
						await api.DELETE("/v2/deployments/{deployment_id}", {
							params: { path: { deployment_id: id }, header: headers },
							body,
						}),
					),
				);
			} catch (error) {
				if (!isPreconditionConflict(error)) throw error;
				if (attempt === 0) {
					try {
						resourceVersion = (await getDeployment(id)).resource.metadata.resourceVersion;
					} catch (readError) {
						if (!isNotFound(readError)) throw readError;
					}
					continue;
				}
				throw new DeploymentConflictError({ cause: error });
			}
		}
		throw new DeploymentConflictError();
	};
	const listWorkspaceSkills = async (
		deploymentId: string,
	): Promise<HostedWorkspaceSkillListResponse> =>
		unwrapDeploy(
			await api.GET("/v2/deployments/{deployment_id}/workspace-skills", {
				params: { path: { deployment_id: deploymentId } },
			}),
		);
	const mutateWorkspaceSkill = async (
		deploymentId: string,
		mutation: WorkspaceSkillMutation,
		resourceVersion: string,
		idempotencyKey: string,
	): Promise<HostedWorkspaceSkillMutationResponse> => {
		let currentResourceVersion = resourceVersion;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const headers = {
				"Idempotency-Key": idempotencyKey,
				"If-Match": strongResourceEtag(currentResourceVersion),
			};
			try {
				return unwrapDeploy(
					mutation.action === "install"
						? await api.POST("/v2/deployments/{deployment_id}/workspace-skills", {
								body: mutation.request,
								params: {
									path: { deployment_id: deploymentId },
									header: headers,
								},
							})
						: await api.DELETE("/v2/deployments/{deployment_id}/workspace-skills/{skill_key}", {
								params: {
									path: {
										deployment_id: deploymentId,
										skill_key: mutation.skillKey,
									},
									header: headers,
								},
							}),
				);
			} catch (error) {
				if (!isWorkspaceSkillResourceVersionConflict(error)) throw error;
				if (attempt === 0) {
					currentResourceVersion = (await listWorkspaceSkills(deploymentId))
						.deployment_resource_version;
					continue;
				}
				throw new DeploymentConflictError({ cause: error });
			}
		}
		throw new DeploymentConflictError();
	};

	return {
		getAiProviderRemovalImpact: async (providerId: string): Promise<AiProviderRemovalImpact> =>
			unwrapDeploy(
				await api.GET("/v2/ai-providers/{provider_id}/removal-impact", {
					params: { path: { provider_id: providerId } },
				}),
			),
		removeAiProvider: async (
			providerId: string,
			impactRevision: string,
			providerIncarnationToken: string,
			idempotencyKey: string,
		): Promise<AiProviderRemovalResult> =>
			unwrapDeploy(
				await api.DELETE("/v2/ai-providers/{provider_id}", {
					params: {
						path: { provider_id: providerId },
						header: {
							"Idempotency-Key": idempotencyKey,
							"Impact-Revision": impactRevision,
							"Provider-Incarnation": providerIncarnationToken,
						},
					},
				}),
			),
		getManagedModelCatalog: async () =>
			unwrapDeploy(await api.GET("/v2/ai-providers/managed/models")),
		getWallet: async () => unwrapDeploy(await api.GET("/v2/wallet")),
		createX402TopupAttempt: async () => unwrapDeploy(await api.POST("/v2/x402/attempts")),
		getWalletBinding: async () => unwrapDeploy(await api.GET("/v2/wallet-binding")),
		createWalletBindingChallenge: async (body: WalletBindingChallengeRequest) =>
			unwrapDeploy(await api.POST("/v2/wallet-binding/challenge", { body })),
		verifyWalletBinding: async (body: WalletBindingVerifyRequest) =>
			unwrapDeploy(await api.POST("/v2/wallet-binding", { body })),
		deleteWalletBinding: async () => {
			const response = await api.DELETE("/v2/wallet-binding");
			if (!response.response.ok) {
				throw new BillingApiError(response.response.status, response.response.statusText);
			}
		},
		getTransactions: async (limit = 50, cursor?: string | null) =>
			unwrapDeploy(
				await api.GET("/v2/wallet/transactions", {
					params: { query: { limit, cursor } },
				}),
			),
		topUp: async (body: WalletTopupRequest, idempotencyKey: string) =>
			unwrapDeploy(
				await api.POST("/v2/wallet/topup", {
					body,
					params: { header: { "Idempotency-Key": idempotencyKey } },
				}),
			),
		setAutoReload: async (body: WalletAutoReloadRequest) =>
			unwrapDeploy(await api.PUT("/v2/wallet/auto-reload", { body })),
		createWalletAutoReloadSetup: async (
			body: WalletAutoReloadSetupRequest,
			idempotencyKey: string,
		) =>
			unwrapDeploy(
				await api.POST("/v2/wallet/auto-reload/setup-intent", {
					body,
					params: { header: { "Idempotency-Key": idempotencyKey } },
				}),
			),
		finalizeWalletAutoReloadSetup: async (body: WalletAutoReloadSetupFinalizeRequest) =>
			unwrapDeploy(await api.POST("/v2/wallet/auto-reload/setup-intent/finalize", { body })),

		getSubscriptions: async (limit = 20, cursor?: string | null) =>
			unwrapDeploy(
				await api.GET("/v2/subscriptions", {
					params: { query: { limit, cursor } },
				}),
			),
		getIncludedBasicAvailability: async () =>
			unwrapDeploy(await api.GET("/v2/subscriptions/included-basic", {})),
		getReusableSubscriptions: async (limit = 100, cursor?: string | null) =>
			unwrapDeploy(
				await api.GET("/v2/subscriptions/reusable", {
					params: { query: { limit, cursor } },
				}),
			),
		getPlans: async () => unwrapDeploy(await api.GET("/v2/subscription/plans")),
		checkout: async (body: CheckoutRequest, idempotencyKey: string) =>
			unwrapDeploy(
				await api.POST("/v2/subscription/checkout", {
					params: { header: { "Idempotency-Key": idempotencyKey } },
					body,
				}),
			),
		quoteSubscription: async (body: ComputeSubscriptionQuoteRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/quote", { body })),
		quotePlanChange: async (body: ComputePlanChangeQuoteRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/plan/quote", { body })),
		changePlan: async (
			body: ComputePlanChangeRequest,
			onAccepted?: (operationName: string) => void,
		): Promise<ComputePlanChangeResult> => {
			const response = unwrapDeploy(
				await api.POST("/v2/subscription/plan/change", {
					headers: { "Idempotency-Key": body.operation_id },
					body,
				}),
			);
			return waitForPlanChange(response, body.operation_id, onAccepted);
		},
		checkPlanChange: async (operationName: string) =>
			getOperation(operationIdFromName(operationName)).then((value) => {
				const operation = parsePlanChangeOperation(value);
				if (operation.name !== operationName) throw invalidPlanChangeResponse();
				const completed = completedPlanChange(operation);
				if (completed) return completed;
				throw new PlanChangePendingError(operation.name);
			}),
		cancelSubscription: async (body: ComputeSubscriptionCancelRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/cancel", { body })),
		cancelScheduledPlanChange: async (body: ComputeCancelScheduledPlanChangeRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/plan/cancel-scheduled-change", { body })),
		fixPayment: async (body: ComputeFixPaymentRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/fix-payment", { body })),
		portal: async (body: PortalRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/portal", { body })),
		resumeSubscription: async (body: ComputeSubscriptionResumeRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/resume", { body })),
		getUsage: async (days: number | null = null, agentId: string | null = null) =>
			unwrapDeploy(
				await api.GET("/v2/usage", {
					params: {
						query: {
							days: days ?? undefined,
							agent_id: agentId ?? undefined,
						},
					},
				}),
			),

		getMe: async () => unwrapDeploy(await api.GET("/v1/me")),
		getLegacyAgentEnvironments: async () => unwrapDeploy(await api.GET("/v1/agent-environments")),
		listWorkspaceSkills,
		installWorkspaceSkill: async (
			deploymentId: string,
			request: HostedWorkspaceSkillInstallRequest,
			resourceVersion: string,
			idempotencyKey: string,
		): Promise<HostedWorkspaceSkillMutationResponse> =>
			mutateWorkspaceSkill(
				deploymentId,
				{ action: "install", request },
				resourceVersion,
				idempotencyKey,
			),
		uninstallWorkspaceSkill: async (
			deploymentId: string,
			skillKey: string,
			resourceVersion: string,
			idempotencyKey: string,
		): Promise<HostedWorkspaceSkillMutationResponse> =>
			mutateWorkspaceSkill(
				deploymentId,
				{ action: "uninstall", skillKey },
				resourceVersion,
				idempotencyKey,
			),

		listDeployments: async (): Promise<HostedDeployment[]> =>
			unwrapDeploymentList(unwrapDeploy(await api.GET("/v2/deployments"))),
		getDeploymentEventStreamHandoff,
		openDeploymentEventStream,
		getDeployment,
		waitForDeploymentRequest,
		createDeployment: async (
			body: DeploymentCreateRequest,
			idempotencyKey: string,
		): Promise<AcceptedOperation> =>
			acceptDeclarativeOperation({
				operation: unwrapDeploy(
					await api.POST("/v2/deployments", {
						params: { header: { "Idempotency-Key": idempotencyKey } },
						body,
					}),
				),
			}),
		createTerminalSession: async (id: string) =>
			unwrapDeploy(
				await api.POST("/v2/deployments/{deployment_id}/terminal", {
					params: { path: { deployment_id: id } },
				}),
			),
		getRuntimeUiCredentials: async (id: string, resourceVersion: string) =>
			unwrapDeploy(
				await api.POST("/v2/deployments/{deployment_id}/runtime-ui/credentials", {
					params: {
						path: { deployment_id: id },
						header: { "If-Match": strongResourceEtag(resourceVersion) },
					},
				}),
			),
		resetRuntimeUiAccess: async (id: string, idempotencyKey: string) =>
			acceptDeploymentMutation(id, idempotencyKey, (headers) =>
				api.POST("/v2/deployments/{deployment_id}/runtime-ui/access/reset", {
					params: { path: { deployment_id: id }, header: headers },
				}),
			),
		setDeploymentDesiredState: async (
			id: string,
			desiredLifecycle: DeploymentDesiredLifecycle,
			idempotencyKey: string,
		) =>
			acceptDeploymentMutation(id, idempotencyKey, (headers) =>
				desiredLifecycle === "running"
					? api.POST("/v2/deployments/{deployment_id}/start", {
							params: { path: { deployment_id: id }, header: headers },
						})
					: api.POST("/v2/deployments/{deployment_id}/stop", {
							params: { path: { deployment_id: id }, header: headers },
						}),
			),
		restartDeployment: async (id: string, idempotencyKey: string) =>
			acceptDeploymentMutation(id, idempotencyKey, (headers) =>
				api.POST("/v2/deployments/{deployment_id}/restart", {
					params: { path: { deployment_id: id }, header: headers },
				}),
			),
		updateDeployment: async (id: string, body: DeploymentUpdateRequest, idempotencyKey: string) =>
			acceptDeploymentMutation(id, idempotencyKey, (headers) =>
				api.PATCH("/v2/deployments/{deployment_id}", {
					params: { path: { deployment_id: id }, header: headers },
					body,
				}),
			),
		cancelDeploymentOperation: async (operationName: string, idempotencyKey: string) => {
			unwrapDeploy(
				await api.POST("/v2/operations/{operation_id}:cancel", {
					params: {
						path: { operation_id: operationIdFromName(operationName) },
						header: { "Idempotency-Key": idempotencyKey },
					},
				}),
			);
		},
		deleteDeployment,
	};
}

export type BillingClient = ReturnType<typeof createBillingClient>;
export type CheckoutOperationResult = Awaited<ReturnType<BillingClient["checkout"]>>;

export function useBillingClient() {
	const { getToken } = useAuthToken();
	return useMemo(() => createBillingClient(getToken), [getToken]);
}
