import { randomUUID } from "node:crypto";
import * as p from "@clack/prompts";
import { projectUserSelectableAiProviders } from "@clawdi/shared";
import {
	buildHostedAiBindingFields,
	buildHostedDeployCheckoutRequest,
	buildHostedDeploySubscriptionQuoteRequest,
	DEFAULT_HOSTED_DEPLOY_AI_ACCESS_MODE,
	DEFAULT_HOSTED_DEPLOY_BILLING_TERM,
	DEFAULT_HOSTED_DEPLOY_COMPUTE_PLAN,
	DEFAULT_HOSTED_DEPLOY_RUNTIME,
	HOSTED_DEPLOY_LANGUAGE_OPTIONS,
	type HostedDeployCheckoutRequest,
	type HostedDeployCheckoutResult,
	type HostedDeployComputePlanSlug,
	type HostedDeployDeployment,
	type HostedDeployOperation,
	type HostedDeployPlan,
	type HostedDeployRequest,
	type HostedDeployRequestStatus,
	type HostedDeployRuntime,
	type HostedDeploySubscriptionQuote,
	type HostedDeploySubscriptionQuoteRequest,
	type HostedSavedAiProvider,
	hostedDeployRuntimeLabel,
	isHostedDeployBillingTerm,
	isHostedDeployComputePlan,
	isHostedDeployRuntime,
	isValidHostedDeployTimezone,
	type ManagedModelCatalogItem,
	projectHostedDeployRequest,
	resolveHostedDeployIncludedBasicSelection,
	selectHostedDeployOfferForTerm,
	usesHostedDeployIncludedBasicSlot,
	validateAndBuildHostedDeployRequest,
} from "@clawdi/shared/api";
import chalk from "chalk";
import { openInBrowser } from "../lib/browser";
import { ClerkOAuthError } from "../lib/clerk-oauth";
import { HostedDeployAuthorizationError } from "../lib/hosted-deploy-auth";
import { HostedDeployApiError, HostedDeployClient } from "../lib/hosted-deploy-client";
import { isInteractive } from "../lib/tty";

export type DeployCommandOptions = {
	runtime?: string;
	provider?: string;
	model?: string;
	compute?: string;
	term?: string;
	payment?: string;
	name?: string;
	language?: string;
	timezone?: string;
	requestId?: string;
	yes?: boolean;
	wait?: boolean;
	open?: boolean;
	json?: boolean;
};

export type DeployCommandDependencies = {
	client?: HostedDeployGateway;
	interactive?: boolean;
	writeStdout?: (value: string) => void;
	writeStderr?: (value: string) => void;
};

type DeployAiMode = "managed" | "saved" | "unmanaged";
type DeployPaymentMethod = "wallet" | "card";

export type ParsedDeployOptions = {
	runtime?: HostedDeployRuntime;
	aiMode?: DeployAiMode;
	providerId?: string;
	model?: string;
	computePlanSlug?: HostedDeployComputePlanSlug;
	billingTermMonths?: 1 | 12;
	payment?: DeployPaymentMethod;
	assistantName?: string;
	language?: string;
	timezone?: string;
	requestId?: string;
	yes: boolean;
	wait: boolean;
	open: boolean;
	json: boolean;
};

export class DeployInputError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DeployInputError";
		this.code = code;
	}
}

const REQUEST_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseDeployCommandOptions(options: DeployCommandOptions): ParsedDeployOptions {
	let runtime: HostedDeployRuntime | undefined;
	if (options.runtime) {
		const value = options.runtime.trim().toLowerCase();
		if (!isHostedDeployRuntime(value)) {
			throw new DeployInputError("invalid_runtime", "--runtime must be hermes or openclaw.");
		}
		runtime = value;
	}

	let aiMode: DeployAiMode | undefined;
	let providerId: string | undefined;
	if (options.provider) {
		const value = options.provider.trim();
		if (!value) {
			throw new DeployInputError(
				"invalid_provider",
				"--provider must be managed, unmanaged, or an exact saved provider id.",
			);
		}
		const keyword = value.toLowerCase();
		if (keyword === "managed" || keyword === "unmanaged") aiMode = keyword;
		else {
			aiMode = "saved";
			providerId = value;
		}
	}
	if (aiMode === "unmanaged" && options.model?.trim()) {
		throw new DeployInputError(
			"model_with_unmanaged_provider",
			"--model cannot be used with --provider unmanaged; configure the model inside the agent.",
		);
	}

	let computePlanSlug: HostedDeployComputePlanSlug | undefined;
	if (options.compute) {
		const aliases: Record<string, string> = {
			basic: "compute_basic",
			performance: "compute_performance",
		};
		const normalized = options.compute.trim().toLowerCase();
		const value = aliases[normalized] ?? normalized;
		if (!isHostedDeployComputePlan(value)) {
			throw new DeployInputError("invalid_compute", "--compute must be basic or performance.");
		}
		computePlanSlug = value;
	}

	let billingTermMonths: 1 | 12 | undefined;
	if (options.term) {
		const value = Number(options.term);
		if (!Number.isInteger(value) || !isHostedDeployBillingTerm(value)) {
			throw new DeployInputError("invalid_term", "--term must be 1 or 12 months.");
		}
		billingTermMonths = value;
	}

	let payment: DeployPaymentMethod | undefined;
	if (options.payment) {
		const normalized = options.payment.trim().toLowerCase();
		const value = normalized === "stripe" ? "card" : normalized;
		if (value !== "wallet" && value !== "card") {
			throw new DeployInputError("invalid_payment", "--payment must be wallet or card.");
		}
		payment = value;
	}

	const language = options.language?.trim() ?? undefined;
	if (
		language &&
		language !== "default" &&
		!HOSTED_DEPLOY_LANGUAGE_OPTIONS.some((option) => option.code === language)
	) {
		throw new DeployInputError(
			"invalid_language",
			`--language must be default or one of: ${HOSTED_DEPLOY_LANGUAGE_OPTIONS.map((option) => option.code).join(", ")}.`,
		);
	}

	const requestId = options.requestId?.trim();
	if (requestId && !REQUEST_ID_PATTERN.test(requestId)) {
		throw new DeployInputError("invalid_request_id", "--request-id must be a UUID.");
	}
	const timezone = options.timezone;
	if (timezone && !isValidHostedDeployTimezone(timezone)) {
		throw new DeployInputError(
			"invalid_timezone",
			"--timezone must be a valid IANA timezone without surrounding whitespace, or empty for the runtime default.",
		);
	}

	return {
		runtime,
		aiMode,
		providerId,
		model: options.model?.trim() || undefined,
		computePlanSlug,
		billingTermMonths,
		payment,
		assistantName: options.name,
		language: language === "default" ? "" : language,
		timezone,
		requestId,
		yes: options.yes ?? false,
		wait: options.wait ?? true,
		open: options.open ?? true,
		json: options.json ?? false,
	};
}

export interface HostedDeployGateway {
	supportsPaidCheckout(): boolean;
	getPlans(): Promise<HostedDeployPlan[]>;
	listDeployments(): Promise<HostedDeployDeployment[]>;
	getManagedModels(): Promise<ManagedModelCatalogItem[]>;
	getSavedAiProviders(): Promise<HostedSavedAiProvider[]>;
	quoteSubscription(
		body: HostedDeploySubscriptionQuoteRequest,
	): Promise<HostedDeploySubscriptionQuote>;
	createDeployment(
		body: HostedDeployRequest,
		idempotencyKey: string,
	): Promise<HostedDeployOperation>;
	checkout(
		body: HostedDeployCheckoutRequest,
		idempotencyKey: string,
	): Promise<HostedDeployCheckoutResult>;
	getOperation(operationName: string): Promise<HostedDeployOperation>;
	getDeploymentRequest(requestId: string): Promise<HostedDeployRequestStatus>;
}

type PromptOption = { value: string; label: string; hint?: string };

export interface DeployPromptAdapter {
	intro(message: string): void;
	select(message: string, options: readonly PromptOption[], initialValue?: string): Promise<string>;
	text(message: string, initialValue: string, placeholder?: string): Promise<string>;
	confirm(message: string, initialValue?: boolean): Promise<boolean>;
	note(message: string, title?: string): void;
	outro(message: string): void;
}

class DeployCancelledError extends Error {
	constructor() {
		super("Deployment cancelled.");
		this.name = "DeployCancelledError";
	}
}

function clackPromptAdapter(): DeployPromptAdapter {
	return {
		intro: (message) => p.intro(message),
		async select(message, options, initialValue) {
			const result = await p.select({ message, options: [...options], initialValue });
			if (p.isCancel(result)) throw new DeployCancelledError();
			return String(result);
		},
		async text(message, initialValue, placeholder) {
			const result = await p.text({ message, initialValue, placeholder });
			if (p.isCancel(result)) throw new DeployCancelledError();
			return result;
		},
		async confirm(message, initialValue = true) {
			const result = await p.confirm({ message, initialValue });
			if (p.isCancel(result)) throw new DeployCancelledError();
			return result;
		},
		note: (message, title) => p.note(message, title),
		outro: (message) => p.outro(message),
	};
}

type DeployFlowEvent = {
	stage: "loading" | "quote" | "payment_required" | "accepted" | "progress" | "succeeded";
	message: string;
};

export type DeployAutomationResult = {
	schema_version: "clawdi.deploy.v1";
	status: "payment_required" | "accepted" | "succeeded";
	request_id: string;
	deployment_id: string | null;
	operation_name: string | null;
	deploy_request_id: string | null;
	runtime: HostedDeployRuntime;
	compute_plan_slug: HostedDeployComputePlanSlug;
	ai_provider: string;
	primary_model: string | null;
	payment:
		| { kind: "included_basic" }
		| {
				kind: "wallet";
				debit_usd: string;
				balance_after_usd: string;
				quote_expires_at: string;
		  }
		| {
				kind: "card";
				checkout_url: string | null;
		  };
};

export type DeployFlowDependencies = {
	client: HostedDeployGateway;
	interactive: boolean;
	prompts?: DeployPromptAdapter;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	pollIntervalMs?: number;
	pollLimit?: number;
	openUrl?: (url: string) => void;
	onEvent?: (event: DeployFlowEvent) => void;
};

export const DEFAULT_DEPLOY_POLL_LIMIT = 1_200;

class PublicDeployFailure extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "PublicDeployFailure";
		this.code = code;
	}
}

function exactUsd(
	value: string | null | undefined,
	field: string,
	options: { allowNegative?: boolean } = {},
): string {
	const normalized = value?.trim() ?? "";
	if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
		throw new Error(`Hosted Wallet quote is missing ${field}.`);
	}
	const amount = Number(normalized);
	if (!Number.isFinite(amount) || (!options.allowNegative && amount < 0)) {
		throw new Error(`Hosted Wallet quote contains an invalid ${field}.`);
	}
	return normalized;
}

function formatUsd(value: string): string {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : `${value} USD`;
}

function formatCents(value: number): string {
	return `$${(value / 100).toFixed(2)}`;
}

function defaultTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
	} catch {
		return "Etc/UTC";
	}
}

function defaultManagedModel(models: readonly ManagedModelCatalogItem[]): string {
	return models.find((model) => model.is_default)?.id ?? models[0]?.id ?? "";
}

function savedProviderLabel(provider: HostedSavedAiProvider): string {
	return provider.label?.trim() || provider.provider_id;
}

function savedProviderDefaultModel(provider: HostedSavedAiProvider): string | null {
	const models = (provider.models ?? []).filter(
		(model, index, all) =>
			model.id.trim() && all.findIndex((candidate) => candidate.id === model.id) === index,
	);
	if (models.length === 1) return models[0]?.id ?? null;
	const explicitDefault = models.filter((model) => model.alias?.trim().toLowerCase() === "default");
	return explicitDefault.length === 1 ? (explicitDefault[0]?.id ?? null) : null;
}

function planLabel(planSlug: HostedDeployComputePlanSlug): string {
	return planSlug === "compute_performance" ? "Performance" : "Basic";
}

function publicProjectedDetail(value: string): string | null {
	const normalized = Array.from(value, (character) => {
		const code = character.charCodeAt(0);
		return code <= 0x1f || code === 0x7f ? " " : character;
	})
		.join("")
		.trim();
	return normalized ? normalized.slice(0, 500) : null;
}

function publicProjectedCode(value: string): string {
	const normalized = value.trim();
	return /^[a-z][a-z0-9_]{0,79}$/.test(normalized) ? normalized : "deployment_failed";
}

function operationFailure(operation: HostedDeployOperation): PublicDeployFailure | null {
	if (!operation.error) return null;
	const projectedProblem = Array.isArray(operation.error.details)
		? operation.error.details.find(
				(item) =>
					item["@type"] === "type.googleapis.com/clawdi.v2.LifecycleProblemDetails" &&
					typeof item.code === "string" &&
					typeof item.detail === "string" &&
					Number.isInteger(item.status) &&
					item.status >= 400 &&
					item.status <= 599,
			)
		: undefined;
	const detail = projectedProblem ? publicProjectedDetail(projectedProblem.detail) : null;
	return new PublicDeployFailure(
		projectedProblem ? publicProjectedCode(projectedProblem.code) : "deployment_failed",
		detail || "Hosted could not complete this deployment.",
	);
}

function terminalRequestFailure(
	requestStatus: "failed" | "expired" | "superseded",
): PublicDeployFailure {
	if (requestStatus === "superseded") {
		return new PublicDeployFailure(
			"deployment_superseded",
			"This deployment request was superseded by a newer attempt.",
		);
	}
	if (requestStatus === "expired") {
		return new PublicDeployFailure(
			"deployment_request_expired",
			"This deployment request expired before it could be completed.",
		);
	}
	return new PublicDeployFailure("deployment_failed", "Hosted could not complete this deployment.");
}

export function hostedCheckoutUrl(result: HostedDeployCheckoutResult): string {
	const raw = result.action_url?.trim() || result.checkout_url.trim();
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new PublicDeployFailure(
			"invalid_checkout_url",
			"Hosted did not return a valid secure card checkout URL.",
		);
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		[...url.searchParams.keys()].some((key) => key.toLowerCase() === "client_secret")
	) {
		throw new PublicDeployFailure(
			"invalid_checkout_url",
			"Hosted did not return a valid secure card checkout URL.",
		);
	}
	return url.toString();
}

async function waitForOperation({
	client,
	initial,
	pollIntervalMs,
	pollLimit,
	sleep,
	onEvent,
}: {
	client: HostedDeployGateway;
	initial: HostedDeployOperation;
	pollIntervalMs: number;
	pollLimit: number;
	sleep: (milliseconds: number) => Promise<void>;
	onEvent: (event: DeployFlowEvent) => void;
}): Promise<{ operation: HostedDeployOperation; completed: boolean }> {
	let operation = initial;
	for (let poll = 0; poll <= pollLimit; poll += 1) {
		const failure = operationFailure(operation);
		if (failure) throw failure;
		if (operation.done) return { operation, completed: true };
		if (poll === pollLimit) break;
		onEvent({ stage: "progress", message: "Agent infrastructure is still converging…" });
		await sleep(pollIntervalMs);
		operation = await client.getOperation(operation.name);
	}
	return { operation, completed: false };
}

async function waitForDeploymentRequest({
	client,
	requestId,
	pollIntervalMs,
	pollLimit,
	sleep,
	onEvent,
}: {
	client: HostedDeployGateway;
	requestId: string;
	pollIntervalMs: number;
	pollLimit: number;
	sleep: (milliseconds: number) => Promise<void>;
	onEvent: (event: DeployFlowEvent) => void;
}): Promise<{
	deploymentId: string | null;
	operation: HostedDeployOperation | null;
	completed: boolean;
	requestStatus: HostedDeployRequestStatus["request_status"] | null;
}> {
	let lastDeploymentId: string | null = null;
	let lastOperation: HostedDeployOperation | null = null;
	let lastRequestStatus: HostedDeployRequestStatus["request_status"] | null = null;
	for (let poll = 0; poll <= pollLimit; poll += 1) {
		const status = await client.getDeploymentRequest(requestId);
		lastRequestStatus = status.request_status;
		const projection = projectHostedDeployRequest(status);
		if (projection.kind === "terminal") {
			throw terminalRequestFailure(projection.requestStatus);
		}
		if (projection.kind === "deployment") {
			lastDeploymentId = projection.deploymentId;
			if (projection.completed) {
				return {
					deploymentId: projection.deploymentId,
					operation: null,
					completed: true,
					requestStatus: status.request_status,
				};
			}
		}
		if (projection.kind === "invalid_success") {
			throw new PublicDeployFailure(
				"invalid_deployment_result",
				"Hosted completed the request without returning the agent identifier.",
			);
		}
		if (projection.kind === "operation" || projection.kind === "operation_name") {
			const operation =
				projection.kind === "operation"
					? projection.operation
					: await client.getOperation(projection.operationName);
			lastDeploymentId = projection.deploymentId ?? lastDeploymentId;
			lastOperation = operation;
			const waited = await waitForOperation({
				client,
				initial: operation,
				pollIntervalMs,
				pollLimit: Math.max(0, pollLimit - poll),
				sleep,
				onEvent,
			});
			return {
				deploymentId: projection.deploymentId ?? lastDeploymentId,
				operation: waited.operation,
				completed: waited.completed,
				requestStatus: status.request_status,
			};
		}
		if (poll === pollLimit) {
			return {
				deploymentId: lastDeploymentId,
				operation: lastOperation,
				completed: false,
				requestStatus: lastRequestStatus,
			};
		}
		onEvent({ stage: "progress", message: "Waiting for payment and the agent request…" });
		await sleep(pollIntervalMs);
	}
	return {
		deploymentId: lastDeploymentId,
		operation: lastOperation,
		completed: false,
		requestStatus: lastRequestStatus,
	};
}

export async function runDeployFlow(
	parsed: ParsedDeployOptions,
	dependencies: DeployFlowDependencies,
): Promise<DeployAutomationResult> {
	const prompts = dependencies.prompts ?? clackPromptAdapter();
	const onEvent = dependencies.onEvent ?? (() => undefined);
	const sleep =
		dependencies.sleep ??
		((milliseconds: number) =>
			new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)));
	const pollIntervalMs = dependencies.pollIntervalMs ?? 1_000;
	const pollLimit = dependencies.pollLimit ?? DEFAULT_DEPLOY_POLL_LIMIT;
	const openUrl = dependencies.openUrl ?? openInBrowser;
	const now = dependencies.now ?? Date.now;
	const interactive = dependencies.interactive;
	const paidCheckoutSupported = dependencies.client.supportsPaidCheckout();
	if (!interactive && !parsed.requestId) {
		throw new DeployInputError(
			"request_id_required",
			"--request-id is required for every non-interactive deploy before any Hosted mutation. Reuse the same UUID to recover an ambiguous attempt safely.",
		);
	}
	const requestId = parsed.requestId ?? randomUUID();

	if (interactive) prompts.intro("clawdi deploy");
	let existingBasicCreateRequest = false;
	if (
		parsed.requestId &&
		(parsed.computePlanSlug ?? DEFAULT_HOSTED_DEPLOY_COMPUTE_PLAN) === "compute_basic"
	) {
		try {
			await dependencies.client.getDeploymentRequest(requestId);
			existingBasicCreateRequest = true;
		} catch (error) {
			if (!(error instanceof HostedDeployApiError && error.status === 404)) throw error;
		}
	}
	onEvent({ stage: "loading", message: "Loading Hosted plans and agent availability…" });
	const needsManagedModels =
		interactive || parsed.aiMode === undefined || parsed.aiMode === "managed";
	const needsSavedProviders = interactive || parsed.aiMode === "saved";
	const savedProvidersPromise = needsSavedProviders
		? dependencies.client.getSavedAiProviders().catch(() => {
				if (!interactive || parsed.aiMode === "saved") {
					throw new DeployInputError(
						"provider_metadata_unavailable",
						"Saved AI provider metadata could not be loaded. Retry before deploying with an exact saved provider id.",
					);
				}
				prompts.note(
					"Saved AI providers could not be loaded. Continue with Clawdi AI or Configure inside agent.",
					"Saved providers unavailable",
				);
				return [];
			})
		: Promise.resolve([]);
	const [plans, deployments, managedModels, savedProviderInventory] = await Promise.all([
		dependencies.client.getPlans(),
		dependencies.client.listDeployments(),
		needsManagedModels ? dependencies.client.getManagedModels() : Promise.resolve([]),
		savedProvidersPromise,
	]);
	const savedProviders = projectUserSelectableAiProviders(savedProviderInventory);

	let runtime = parsed.runtime ?? DEFAULT_HOSTED_DEPLOY_RUNTIME;
	if (interactive && !parsed.runtime) {
		const selected = await prompts.select(
			"Runtime",
			[
				{
					value: "hermes",
					label: "Hermes",
					hint: "Recommended — dashboard-first agent experience",
				},
				{ value: "openclaw", label: "OpenClaw", hint: "Control UI and OpenClaw workflows" },
			],
			DEFAULT_HOSTED_DEPLOY_RUNTIME,
		);
		if (!isHostedDeployRuntime(selected)) throw new Error("Invalid runtime selection.");
		runtime = selected;
	}

	let aiMode = parsed.aiMode ?? "managed";
	let providerId = parsed.providerId;
	const unusableProviders = savedProviders.filter((provider) => !provider.usable);
	if (interactive && !parsed.aiMode) {
		if (unusableProviders.length > 0) {
			prompts.note(
				unusableProviders
					.map((provider) => {
						const label = savedProviderLabel(provider);
						const identity =
							label === provider.provider_id ? label : `${label} (${provider.provider_id})`;
						return `${identity}\n  Fix: clawdi ai-provider test ${provider.provider_id}`;
					})
					.join("\n"),
				"Saved providers needing setup",
			);
		}
		const selected = await prompts.select(
			"AI provider",
			[
				{ value: "managed", label: "Clawdi AI", hint: "Ready when the agent starts" },
				...savedProviders
					.filter((provider) => provider.usable)
					.map((provider) => ({
						value: provider.provider_id,
						label: savedProviderLabel(provider),
						hint: `Saved provider · ${provider.provider_id}`,
					})),
				{
					value: "unmanaged",
					label: "Configure inside agent",
					hint: "No provider credential is sent by this wizard",
				},
			],
			DEFAULT_HOSTED_DEPLOY_AI_ACCESS_MODE === "configured" ? "managed" : "unmanaged",
		);
		if (selected === "managed" || selected === "unmanaged") {
			aiMode = selected;
			providerId = undefined;
		} else if (
			savedProviders.some((provider) => provider.usable && provider.provider_id === selected)
		) {
			aiMode = "saved";
			providerId = selected;
		} else {
			throw new Error("Invalid AI provider selection.");
		}
	}

	const selectedSavedProvider =
		aiMode === "saved"
			? savedProviders.find((provider) => provider.provider_id === providerId)
			: undefined;
	if (aiMode === "saved" && !selectedSavedProvider) {
		throw new DeployInputError(
			"provider_missing",
			`Saved AI provider ${providerId ?? ""} was not found. Pass its exact provider id or run \`clawdi ai-provider list\`.`,
		);
	}
	if (selectedSavedProvider && !selectedSavedProvider.usable) {
		throw new DeployInputError(
			"provider_unusable",
			`${savedProviderLabel(selectedSavedProvider)} (${selectedSavedProvider.provider_id}) has no usable credential. Run \`clawdi ai-provider test ${selectedSavedProvider.provider_id}\` and finish its setup.`,
		);
	}

	let model = parsed.model ?? (aiMode === "managed" ? defaultManagedModel(managedModels) : "");
	if (aiMode === "managed") {
		if (managedModels.length === 0) {
			throw new Error(
				"The Clawdi AI model catalog is empty. Retry later or configure AI inside the agent.",
			);
		}
		if (interactive && !parsed.model) {
			model = await prompts.select(
				"Primary model",
				managedModels.map((item) => ({
					value: item.id,
					label: item.display_name,
					hint: item.is_default ? "Recommended" : undefined,
				})),
				defaultManagedModel(managedModels),
			);
		}
	} else if (selectedSavedProvider) {
		const catalog = selectedSavedProvider.models ?? [];
		const automaticModel = savedProviderDefaultModel(selectedSavedProvider);
		if (interactive && !parsed.model) {
			if (catalog.length > 0) {
				const customChoice = "__clawdi_custom_model__";
				const selected = await prompts.select(
					"Primary model",
					[
						...catalog.map((item) => ({
							value: item.id,
							label: item.label || item.alias || item.id,
						})),
						{ value: customChoice, label: "Custom model", hint: "Enter an exact model id" },
					],
					automaticModel ?? catalog[0]?.id,
				);
				model =
					selected === customChoice
						? await prompts.text("Primary model", "", "model id")
						: selected;
			} else {
				model = await prompts.text("Primary model", "", "model id");
			}
		} else if (!parsed.model) {
			if (!automaticModel) {
				throw new DeployInputError(
					"model_required",
					`--model is required for saved provider ${selectedSavedProvider.provider_id} because it has no unique default model.`,
				);
			}
			model = automaticModel;
		}
	}

	let term = parsed.billingTermMonths ?? DEFAULT_HOSTED_DEPLOY_BILLING_TERM;
	const basicPlan = plans.find((plan) => plan.slug === "compute_basic");
	const performancePlan = plans.find((plan) => plan.slug === "compute_performance");
	const includedSlotUsage = usesHostedDeployIncludedBasicSlot(deployments);
	let basicSelection = resolveHostedDeployIncludedBasicSelection({
		basicPlan,
		billingTermMonths: term,
		includedSlotAvailable: existingBasicCreateRequest
			? true
			: includedSlotUsage === null
				? null
				: !includedSlotUsage,
	});
	let performanceSelection = performancePlan
		? selectHostedDeployOfferForTerm(performancePlan, term)
		: null;
	const computeOptions: PromptOption[] = [];
	if (basicSelection.mode === "included") {
		computeOptions.push({
			value: "compute_basic",
			label: "Basic",
			hint: `${basicSelection.plan.vcpu} vCPU · ${basicSelection.plan.ram_gb} GB RAM · included`,
		});
	} else if (basicSelection.mode === "checkout" && paidCheckoutSupported) {
		computeOptions.push({
			value: "compute_basic",
			label: "Basic",
			hint: `${basicSelection.plan.vcpu} vCPU · ${basicSelection.plan.ram_gb} GB RAM · ${formatCents(basicSelection.offer.price_cents)}`,
		});
	}
	if (performancePlan && performanceSelection && paidCheckoutSupported) {
		computeOptions.push({
			value: "compute_performance",
			label: "Performance",
			hint: `${performancePlan.vcpu} vCPU · ${performancePlan.ram_gb} GB RAM · ${formatCents(performanceSelection.offer.price_cents)}`,
		});
	}
	if (computeOptions.length === 0) {
		if (!paidCheckoutSupported) {
			throw new DeployInputError(
				"paid_checkout_unavailable",
				"This Hosted CLI authorization can create only the included free Basic agent. Paid Wallet and card checkout are not granted to CLI tokens; use the Web Deploy Wizard.",
			);
		}
		throw new PublicDeployFailure(
			"compute_unavailable",
			"No Hosted compute plan is currently available for deployment.",
		);
	}

	let computePlanSlug = parsed.computePlanSlug ?? DEFAULT_HOSTED_DEPLOY_COMPUTE_PLAN;
	if (interactive && !parsed.computePlanSlug) {
		const defaultCompute = computeOptions.some((option) => option.value === computePlanSlug)
			? computePlanSlug
			: computeOptions[0]?.value;
		const selected = await prompts.select("Compute", computeOptions, defaultCompute);
		if (!isHostedDeployComputePlan(selected)) throw new Error("Invalid compute selection.");
		computePlanSlug = selected;
	}
	if (!computeOptions.some((option) => option.value === computePlanSlug)) {
		const reason = !paidCheckoutSupported
			? "This Hosted CLI authorization can create only the included free Basic agent. Paid Wallet and card checkout are not granted to CLI tokens; use the Web Deploy Wizard."
			: computePlanSlug === "compute_basic" && basicSelection.mode === "unavailable"
				? `Basic compute is unavailable (${basicSelection.reason.replace(/_/g, " ")}).`
				: `${planLabel(computePlanSlug)} compute is unavailable.`;
		throw new DeployInputError(
			paidCheckoutSupported ? "compute_unavailable" : "paid_checkout_unavailable",
			reason,
		);
	}

	const includedBasic = computePlanSlug === "compute_basic" && basicSelection.mode === "included";
	if (interactive && !includedBasic && parsed.billingTermMonths === undefined) {
		const selectedPlan = computePlanSlug === "compute_basic" ? basicPlan : performancePlan;
		const termOptions = (
			selectedPlan?.offers?.length
				? selectedPlan.offers
				: selectedPlan
					? [{ billing_term_months: 1 }]
					: []
		)
			.filter((offer) => isHostedDeployBillingTerm(offer.billing_term_months))
			.filter(
				(offer, index, offers) =>
					offers.findIndex(
						(candidate) => candidate.billing_term_months === offer.billing_term_months,
					) === index,
			)
			.map((offer) => ({
				value: String(offer.billing_term_months),
				label: offer.billing_term_months === 12 ? "Annual" : "Monthly",
			}));
		if (termOptions.length === 0) {
			throw new Error("The selected compute plan has no supported billing term.");
		}
		const selected = await prompts.select("Billing term", termOptions, String(term));
		const selectedTerm = Number(selected);
		if (!isHostedDeployBillingTerm(selectedTerm)) {
			throw new Error("Invalid billing term selection.");
		}
		term = selectedTerm;
		basicSelection = resolveHostedDeployIncludedBasicSelection({
			basicPlan,
			billingTermMonths: term,
			includedSlotAvailable: existingBasicCreateRequest
				? true
				: includedSlotUsage === null
					? null
					: !includedSlotUsage,
		});
		performanceSelection = performancePlan
			? selectHostedDeployOfferForTerm(performancePlan, term)
			: null;
	}
	const paidSelection =
		computePlanSlug === "compute_performance"
			? performanceSelection
			: basicSelection.mode === "checkout"
				? basicSelection
				: null;
	if (!includedBasic && !paidSelection) {
		throw new Error("The selected compute plan has no purchasable offer.");
	}
	if (
		paidSelection &&
		parsed.billingTermMonths !== undefined &&
		paidSelection.billingTermMonths !== parsed.billingTermMonths
	) {
		throw new DeployInputError(
			"billing_term_unavailable",
			`The selected compute plan does not offer a ${parsed.billingTermMonths}-month billing term.`,
		);
	}

	let payment = parsed.payment;
	if (!includedBasic) {
		if (!paidCheckoutSupported) {
			throw new DeployInputError(
				"paid_checkout_unavailable",
				"This Hosted CLI authorization does not grant paid checkout. No quote or payment was started; use the Web Deploy Wizard.",
			);
		}
		if (interactive && !payment) {
			const selected = await prompts.select(
				"Payment",
				[
					{ value: "wallet", label: "Clawdi Wallet", hint: "Exact quote and confirmation next" },
					{
						value: "card",
						label: "Card",
						hint: "Secure Hosted Checkout opens in your browser",
					},
				],
				"wallet",
			);
			if (selected !== "wallet" && selected !== "card") {
				throw new Error("Invalid payment selection.");
			}
			payment = selected;
		}
		if (!interactive && !payment) {
			throw new DeployInputError(
				"missing_non_interactive_option",
				"--payment is required when the deploy wizard cannot prompt.",
			);
		}
	}
	let assistantName = parsed.assistantName ?? hostedDeployRuntimeLabel(runtime);
	if (interactive && parsed.assistantName === undefined) {
		assistantName = await prompts.text(
			"Agent name",
			hostedDeployRuntimeLabel(runtime),
			"Research Assistant",
		);
	}

	let language = parsed.language ?? "";
	if (interactive && parsed.language === undefined) {
		const selected = await prompts.select(
			"Language",
			[
				{ value: "default", label: "Default" },
				...HOSTED_DEPLOY_LANGUAGE_OPTIONS.map((option) => ({
					value: option.code,
					label: option.label,
				})),
			],
			"default",
		);
		language = selected === "default" ? "" : selected;
	}

	let timezone = parsed.timezone ?? defaultTimezone();
	if (interactive && parsed.timezone === undefined) {
		timezone = await prompts.text("Timezone", defaultTimezone(), "Etc/UTC");
	}

	const built = validateAndBuildHostedDeployRequest(
		{
			runtime,
			computePlanSlug,
			assistantName,
			language,
			timezone,
			ai: aiMode === "managed" ? { mode: "managed", model } : { mode: "unmanaged" },
		},
		managedModels,
	);
	if (!built.ok) {
		throw new DeployInputError(
			"invalid_deploy_request",
			built.issues.map((issue) => issue.message).join(" "),
		);
	}
	const aiFields = buildHostedAiBindingFields({
		managedModels,
		mode: "create",
		providers: savedProviders,
		selection:
			aiMode === "managed"
				? { mode: "managed", model }
				: aiMode === "unmanaged"
					? { mode: "unmanaged" }
					: {
							mode: "saved",
							model,
							primaryProviderId: selectedSavedProvider?.provider_id ?? "",
							providerIds: selectedSavedProvider ? [selectedSavedProvider.provider_id] : [],
						},
	});
	const deployRequest: HostedDeployRequest = { ...built.request, ...aiFields };

	let walletQuote: HostedDeploySubscriptionQuote | null = null;
	let walletDebitUsd: string | null = null;
	let walletBalanceAfterUsd: string | null = null;
	if (!includedBasic && payment === "wallet") {
		if (!paidSelection) throw new Error("Wallet payment selection is incomplete.");
		const billingTermMonths = paidSelection.billingTermMonths;
		if (!isHostedDeployBillingTerm(billingTermMonths)) {
			throw new Error("Wallet subscriptions support 1- or 12-month billing terms only.");
		}
		onEvent({ stage: "quote", message: "Getting an exact Wallet quote…" });
		walletQuote = await dependencies.client.quoteSubscription(
			buildHostedDeploySubscriptionQuoteRequest({
				planSlug: computePlanSlug,
				billingTermMonths,
				fundingSource: "wallet",
			}),
		);
		if (
			walletQuote.plan_slug !== computePlanSlug ||
			walletQuote.billing_term_months !== billingTermMonths ||
			walletQuote.funding_source !== "wallet"
		) {
			throw new Error("Hosted Wallet quote does not match the selected compute plan.");
		}
		if (
			!Number.isFinite(Date.parse(walletQuote.expires_at)) ||
			Date.parse(walletQuote.expires_at) <= now()
		) {
			throw new Error("Hosted Wallet quote is already expired. Retry to get a fresh quote.");
		}
		walletDebitUsd = exactUsd(walletQuote.debit_amount_usd, "the exact debit");
		walletBalanceAfterUsd = exactUsd(walletQuote.balance_after_usd, "the balance after debit", {
			allowNegative: true,
		});
		const shortfall = Number(walletBalanceAfterUsd) < 0;
		if (shortfall) {
			throw new DeployInputError(
				"insufficient_wallet_balance",
				`Wallet balance is insufficient for the exact ${formatUsd(walletDebitUsd)} debit. Top up in the dashboard and request a fresh quote.`,
			);
		}
	}

	const summary = [
		`Runtime: ${hostedDeployRuntimeLabel(runtime)}`,
		`AI: ${
			aiMode === "managed"
				? `Clawdi AI · ${model}`
				: aiMode === "saved"
					? `${selectedSavedProvider ? savedProviderLabel(selectedSavedProvider) : providerId} · ${model}`
					: "Configure inside agent"
		}`,
		`Compute: ${planLabel(computePlanSlug)}${includedBasic ? " · included" : ` · ${paidSelection?.billingTermMonths} month term`}`,
		`Persona: ${assistantName.trim()} · ${language || "default language"} · ${timezone.trim() || "default timezone"}`,
		...(walletQuote && walletDebitUsd && walletBalanceAfterUsd
			? [
					`Wallet: debit ${formatUsd(walletDebitUsd)} · balance after ${formatUsd(walletBalanceAfterUsd)}`,
					`Quote expires: ${walletQuote.expires_at}`,
				]
			: []),
		...(payment === "card"
			? ["Card: secure Hosted Checkout · no card details are handled by the CLI"]
			: []),
		`Request ID: ${requestId}`,
	].join("\n");

	if (interactive) {
		prompts.note(summary, "Review deployment");
		const confirmationMessage = includedBasic
			? "Deploy this agent?"
			: payment === "wallet"
				? "Debit this exact Wallet quote and deploy?"
				: "Open secure card checkout for this agent?";
		const confirmed = parsed.yes || (await prompts.confirm(confirmationMessage));
		if (!confirmed) throw new DeployCancelledError();
	} else if (!parsed.yes) {
		throw new DeployInputError(
			"confirmation_required",
			"--yes is required when the deploy wizard cannot prompt. Review flags carefully before confirming.",
		);
	}

	let deploymentId: string | null = null;
	let operation: HostedDeployOperation | null = null;
	let deployRequestId: string | null = null;
	let checkoutUrl: string | null = null;
	let paymentRequired = false;
	let completed = false;
	if (includedBasic) {
		operation = await dependencies.client.createDeployment(deployRequest, requestId);
		const immediateFailure = operationFailure(operation);
		if (immediateFailure) throw immediateFailure;
		deploymentId = operation.metadata.deploymentId.trim() || null;
		if (!deploymentId) throw new Error("Hosted deploy API accepted creation without an agent id.");
		onEvent({ stage: "accepted", message: `Accepted ${deploymentId} (${operation.name}).` });
		completed = operation.done;
		if (parsed.wait) {
			const waited = await waitForOperation({
				client: dependencies.client,
				initial: operation,
				pollIntervalMs,
				pollLimit,
				sleep,
				onEvent,
			});
			operation = waited.operation;
			completed = waited.completed;
		}
	} else {
		if (!paidSelection || !payment) throw new Error("Paid deployment selection is incomplete.");
		const billingTermMonths = paidSelection.billingTermMonths;
		if (!isHostedDeployBillingTerm(billingTermMonths)) {
			throw new Error("Hosted subscriptions support 1- or 12-month billing terms only.");
		}
		if (payment === "wallet" && (!walletQuote || !walletDebitUsd || !walletBalanceAfterUsd)) {
			throw new Error("Wallet quote is unavailable at confirmation.");
		}
		const fundingSource = payment === "wallet" ? "wallet" : "stripe";
		const checkout = await dependencies.client.checkout(
			buildHostedDeployCheckoutRequest({
				selection: {
					planSlug: computePlanSlug,
					billingTermMonths,
					fundingSource,
				},
				target: { kind: "new_deployment", deployRequest },
				idempotencyKey: requestId,
				quote: fundingSource === "wallet" ? walletQuote : null,
				uiMode: "hosted",
			}),
			requestId,
		);
		if (checkout.client_secret?.trim()) {
			throw new PublicDeployFailure(
				"invalid_checkout_response",
				"Hosted returned a browser-only checkout secret that the CLI will not handle.",
			);
		}
		if (checkout.funding_source !== fundingSource) {
			throw new PublicDeployFailure(
				"checkout_mismatch",
				"Hosted checkout did not match the selected payment method.",
			);
		}
		const returnedRequestId = checkout.deploy_request_id?.trim() || null;
		if (returnedRequestId && returnedRequestId !== requestId) {
			throw new PublicDeployFailure(
				"checkout_mismatch",
				"Hosted checkout did not match the requested deployment intent.",
			);
		}
		deployRequestId = requestId;
		deploymentId = checkout.deployment_id?.trim() || null;
		if (payment === "wallet" && checkout.flow_type !== "subscription_activation") {
			throw new PublicDeployFailure(
				"wallet_activation_incomplete",
				"Wallet checkout did not confirm subscription activation. No additional payment was sent.",
			);
		}
		if (checkout.flow_type === "subscription_activation" && !deploymentId) {
			throw new PublicDeployFailure(
				"invalid_deployment_result",
				"Hosted accepted payment without returning the agent identifier. Do not start another payment; check Agents in the dashboard.",
			);
		}

		if (checkout.flow_type === "checkout_session") {
			if (payment !== "card") {
				throw new PublicDeployFailure(
					"wallet_activation_incomplete",
					"Wallet checkout did not confirm subscription activation. No additional payment was sent.",
				);
			}
			checkoutUrl = hostedCheckoutUrl(checkout);
			paymentRequired = true;
			onEvent({
				stage: "payment_required",
				message: "Secure card checkout is ready in your browser.",
			});
			if (interactive) {
				prompts.note(checkoutUrl, "Complete secure card checkout");
				if (parsed.open) openUrl(checkoutUrl);
			}
		} else {
			onEvent({
				stage: "accepted",
				message:
					payment === "wallet"
						? `Wallet debit accepted; creating ${deploymentId}.`
						: `Card checkout recovered; creating ${deploymentId}.`,
			});
		}

		const shouldWatch = parsed.wait && checkout.flow_type === "subscription_activation";
		if (shouldWatch && deployRequestId) {
			const waited = await waitForDeploymentRequest({
				client: dependencies.client,
				requestId: deployRequestId,
				pollIntervalMs,
				pollLimit,
				sleep,
				onEvent,
			});
			deploymentId = waited.deploymentId ?? deploymentId;
			operation = waited.operation;
			completed = waited.completed;
			const hasAcceptanceEvidence = Boolean(deploymentId || operation);
			paymentRequired = payment === "card" && !hasAcceptanceEvidence;
			if (deploymentId && !completed) {
				onEvent({ stage: "accepted", message: `Agent ${deploymentId} is still starting.` });
			}
		}
	}

	const result: DeployAutomationResult = {
		schema_version: "clawdi.deploy.v1",
		status: completed ? "succeeded" : paymentRequired ? "payment_required" : "accepted",
		request_id: requestId,
		deployment_id: deploymentId,
		operation_name: operation?.name ?? null,
		deploy_request_id: deployRequestId,
		runtime,
		compute_plan_slug: computePlanSlug,
		ai_provider: aiMode === "saved" ? (selectedSavedProvider?.provider_id ?? "") : aiMode,
		primary_model: aiMode === "unmanaged" ? null : model,
		payment: includedBasic
			? { kind: "included_basic" }
			: payment === "wallet"
				? {
						kind: "wallet",
						debit_usd: walletDebitUsd ?? "",
						balance_after_usd: walletBalanceAfterUsd ?? "",
						quote_expires_at: walletQuote?.expires_at ?? "",
					}
				: { kind: "card", checkout_url: checkoutUrl },
	};
	if (completed && deploymentId) {
		onEvent({ stage: "succeeded", message: `Agent ${deploymentId} is ready.` });
	}
	if (interactive) {
		const finalMessage =
			completed && deploymentId
				? `${chalk.green("✓")} Agent ${chalk.bold(deploymentId)} is ready.`
				: paymentRequired
					? "Complete secure card checkout in your browser. Re-run with the same request ID to recover this attempt."
					: deploymentId
						? `${chalk.green("✓")} Agent ${chalk.bold(deploymentId)} was accepted. Check the dashboard for progress.`
						: `${chalk.green("✓")} Deployment request accepted. Check the dashboard for progress.`;
		prompts.outro(finalMessage);
	}
	return result;
}

export function safeDeployError(error: unknown): { code: string; message: string } {
	if (error instanceof DeployInputError) return { code: error.code, message: error.message };
	if (error instanceof PublicDeployFailure) return { code: error.code, message: error.message };
	if (error instanceof DeployCancelledError) return { code: "cancelled", message: error.message };
	if (error instanceof HostedDeployAuthorizationError || error instanceof ClerkOAuthError) {
		return { code: error.code, message: error.message };
	}
	if (error instanceof HostedDeployApiError) {
		if (error.status === 0) {
			return {
				code: "hosted_network_error",
				message:
					"Could not reach Hosted. The request may still have been accepted; retry with the same --request-id.",
			};
		}
		if (error.status === 401) {
			return {
				code: "hosted_auth_required",
				message: "Hosted CLI authorization was rejected. Re-authorize and try again.",
			};
		}
		if (error.status === 403) {
			return { code: "hosted_forbidden", message: "This account cannot use Hosted deployment." };
		}
		if (error.status === 402) {
			return {
				code: "insufficient_wallet_balance",
				message:
					"Wallet funds changed before payment completed. Top up in the dashboard and retry with a fresh quote.",
			};
		}
		if (error.status === 404) {
			return { code: "hosted_not_found", message: "The Hosted deployment request was not found." };
		}
		if (error.status === 429) {
			return { code: "hosted_rate_limited", message: "Hosted is busy. Wait a moment and retry." };
		}
		if (error.status >= 500) {
			return {
				code: "hosted_unavailable",
				message: "Hosted deployment is temporarily unavailable.",
			};
		}
		if (error.status === 400 || error.status === 422) {
			return {
				code: "hosted_invalid_request",
				message: "Hosted rejected the deployment input. Review the selected options and retry.",
			};
		}
		if (error.status === 409) {
			return {
				code: "hosted_conflict",
				message:
					"Hosted could not reuse this request ID for the selected options. Retry with the same options or choose a new request ID.",
			};
		}
		return {
			code: "hosted_api_error",
			message: "Hosted deploy API rejected the request.",
		};
	}
	return {
		code: "deploy_failed",
		message: "Deployment could not be completed. Retry with the same --request-id.",
	};
}

export async function deployCommand(
	options: DeployCommandOptions = {},
	dependencies: DeployCommandDependencies = {},
): Promise<void> {
	let parsed: ParsedDeployOptions | null = null;
	const terminalInteractive = dependencies.interactive ?? isInteractive();
	let machineOutput = options.json === true || !terminalInteractive;
	const writeStdout = dependencies.writeStdout ?? console.log;
	const writeStderr = dependencies.writeStderr ?? console.error;
	try {
		parsed = parseDeployCommandOptions(options);
		const interactive = terminalInteractive && !parsed.json;
		machineOutput = parsed.json || !interactive;
		const result = await runDeployFlow(parsed, {
			client: dependencies.client ?? new HostedDeployClient(),
			interactive,
			onEvent: parsed.json
				? undefined
				: (event) => {
						if (!interactive) writeStderr(chalk.gray(event.message));
					},
		});
		if (machineOutput) writeStdout(JSON.stringify(result, null, 2));
	} catch (error) {
		const safe = safeDeployError(error);
		if (machineOutput) {
			const authorizationRequired =
				safe.code === "hosted_oauth_login_required" || safe.code === "oauth_login_required";
			writeStdout(
				JSON.stringify(
					authorizationRequired
						? {
								schema_version: "clawdi.deploy.v1",
								status: "authorization_required",
								authorization: { command: "clawdi auth login" },
							}
						: {
								schema_version: "clawdi.deploy.v1",
								status: "error",
								error: safe,
							},
					null,
					2,
				),
			);
			process.exitCode = 1;
			return;
		}
		throw new Error(safe.message);
	}
}
