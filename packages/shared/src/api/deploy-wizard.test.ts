import { describe, expect, test } from "bun:test";
import type {
	HostedDeployCheckoutUiMode,
	HostedDeployPlan,
	HostedDeployRequestStatus,
} from "./deploy-wizard";
import {
	buildHostedDeployCheckoutRequest,
	buildHostedDeployRequest,
	buildHostedDeploySubscriptionQuoteRequest,
	isValidHostedDeployTimezone,
	projectHostedDeployRequest,
	resolveHostedDeployIncludedBasicSelection,
	selectHostedDeployOfferForTerm,
	validateAndBuildHostedDeployRequest,
} from "./deploy-wizard";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
		? true
		: false;
type Assert<Condition extends true> = Condition;
type CheckoutModeIsExact = Assert<Equal<HostedDeployCheckoutUiMode, "custom" | "hosted">>;

const checkoutModeIsExact: CheckoutModeIsExact = true;
// @ts-expect-error Stripe Checkout UI mode must stay on the backend's narrow generated union.
const unsupportedCheckoutMode: HostedDeployCheckoutUiMode = "elements";
void unsupportedCheckoutMode;

const managedModelMetadata = {
	provider_id: "openai-codex",
	description: null,
	capabilities: {
		context_window: 128_000,
		max_context_window: null,
		max_input_tokens: 128_000,
		max_output_tokens: null,
		input_modalities: ["text" as const],
		supports_vision: false,
		supports_reasoning: null,
		supports_tools: null,
	},
};

function plan(
	slug: HostedDeployPlan["slug"],
	priceCents: number,
	offers: HostedDeployPlan["offers"] = [],
): HostedDeployPlan {
	return {
		slug,
		name: slug === "compute_basic" ? "Basic" : "Performance",
		price_cents: priceCents,
		signup_grant_usd: "0",
		vcpu: 2,
		ram_gb: 4,
		disk_size: 20,
		offers,
	};
}

describe("hosted deploy request contract", () => {
	test("keeps the Agent name outside runtime configuration", () => {
		const result = validateAndBuildHostedDeployRequest(
			{
				runtime: "hermes",
				computePlanSlug: "compute_basic",
				agentName: "  Researcher  ",
				language: "en",
				timezone: "Etc/UTC",
				ai: { mode: "managed", model: "gpt-test" },
			},
			[
				{
					...managedModelMetadata,
					id: "gpt-test",
					display_name: "GPT Test",
					is_default: true,
					is_featured: true,
				},
			],
		);

		expect(result).toEqual({
			ok: true,
			request: {
				compute_plan_slug: "compute_basic",
				runtime: "hermes",
				name: "Researcher",
				language: "en",
				timezone: "Etc/UTC",
				ai_provider_auth_kind: "managed",
				ai_provider_id: null,
				provider_ids: ["clawdi"],
				primary_model: { provider_id: "clawdi", model: "gpt-test" },
				config: {
					runtime: "hermes",
					language: "en",
					timezone: "Etc/UTC",
				},
			},
		});
	});

	test("validates persona and managed catalog boundaries without throwing", () => {
		const result = validateAndBuildHostedDeployRequest(
			{
				runtime: "openclaw",
				computePlanSlug: "compute_performance",
				agentName: " ",
				language: "xx",
				timezone: "Etc/UTC",
				ai: { mode: "managed", model: "missing" },
			},
			[
				{
					...managedModelMetadata,
					id: "available",
					display_name: "Available",
					is_default: true,
					is_featured: true,
				},
			],
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues.map((issue) => issue.field)).toEqual([
			"agentName",
			"language",
			"ai.model",
		]);
	});

	test("matches Hosted IANA timezone boundary semantics", () => {
		expect(isValidHostedDeployTimezone("Etc/UTC")).toBe(true);
		expect(isValidHostedDeployTimezone("America/Los_Angeles")).toBe(true);
		expect(isValidHostedDeployTimezone(" Factory")).toBe(false);
		expect(isValidHostedDeployTimezone("Factory")).toBe(false);
		expect(isValidHostedDeployTimezone("localtime")).toBe(false);
		expect(isValidHostedDeployTimezone("Mars/Olympus_Mons")).toBe(false);
	});

	test("builds explicit unmanaged requests without provider material", () => {
		expect(
			buildHostedDeployRequest({
				computePlanSlug: "compute_basic",
				runtime: "openclaw",
				persona: { agentName: "OpenClaw", language: "", timezone: "" },
				aiFields: { ai_provider_auth_kind: "unmanaged" },
			}),
		).toEqual({
			compute_plan_slug: "compute_basic",
			runtime: "openclaw",
			name: "OpenClaw",
			language: null,
			timezone: null,
			ai_provider_auth_kind: "unmanaged",
			config: {
				runtime: "openclaw",
				language: null,
				timezone: null,
			},
		});
	});
});

describe("hosted deploy compute and payment contract", () => {
	test("keeps every product checkout mode in the generated narrow union", () => {
		expect(checkoutModeIsExact).toBe(true);
	});

	test("requires an explicit Basic offer once the free slot is occupied", () => {
		const basic = plan("compute_basic", 900);
		expect(
			resolveHostedDeployIncludedBasicSelection({
				basicPlan: basic,
				billingTermMonths: 1,
				includedSlotAvailable: false,
			}),
		).toEqual({ mode: "unavailable", reason: "offers_missing" });
		expect(selectHostedDeployOfferForTerm(basic, 1)).toMatchObject({
			offer: { price_cents: 900 },
			billingTermMonths: 1,
		});
	});

	test("carries the exact wallet quote into checkout and binds the request id", () => {
		const selection = {
			planSlug: "compute_performance" as const,
			billingTermMonths: 12 as const,
			fundingSource: "wallet" as const,
		};
		const quote = {
			plan_slug: "compute_performance" as const,
			billing_term_months: 12 as const,
			funding_source: "wallet" as const,
			currency: "usd",
			term_price_cents: 9_900,
			expires_at: "2026-07-28T00:05:00Z",
			debit_amount_usd: "99.000000",
			balance_before_usd: "100.000000",
			balance_after_usd: "1.000000",
		};
		const deployRequest = buildHostedDeployRequest({
			computePlanSlug: "compute_performance",
			runtime: "hermes",
			persona: { agentName: "Hermes", language: "en", timezone: "Etc/UTC" },
			aiFields: { ai_provider_auth_kind: "unmanaged" },
		});

		expect(buildHostedDeploySubscriptionQuoteRequest(selection)).toEqual({
			plan_slug: "compute_performance",
			billing_term_months: 12,
			funding_source: "wallet",
		});
		expect(
			buildHostedDeployCheckoutRequest({
				selection,
				subscriptionSelection: { mode: "new" },
				target: { kind: "new_deployment", deployRequest },
				idempotencyKey: "request-stable",
				quote,
				uiMode: "hosted",
			}),
		).toMatchObject({
			funding_source: "wallet",
			ui_mode: "hosted",
			quote,
			subscription_selection: { mode: "new" },
			deploy_config: { deploy_request_id: "request-stable" },
		});
	});
});

describe("hosted deploy request projection", () => {
	function requestStatus(overrides: Partial<HostedDeployRequestStatus>): HostedDeployRequestStatus {
		return {
			deploy_request_id: "request-stable",
			request_status: "pending",
			...overrides,
		};
	}

	test("prioritizes terminal outcomes, then accepted deployment identity", () => {
		expect(
			projectHostedDeployRequest(
				requestStatus({
					request_status: "failed",
					lineage_tail: {
						deployment_id: "hdep_stale",
						lineage_version: 1,
						lineage_state: "failed",
						termination_reason: { internal: "not projected" },
					},
				}),
			),
		).toEqual({ kind: "terminal", requestStatus: "failed" });
		expect(
			projectHostedDeployRequest(
				requestStatus({
					request_status: "ready",
					lineage_tail: {
						deployment_id: "hdep_test",
						agent_id: "55555555-5555-4555-8555-555555555555",
						operation_name: "operations/deploy-test",
						lineage_version: 1,
						lineage_state: "processing",
					},
				}),
			),
		).toEqual({
			kind: "deployment",
			agentId: "55555555-5555-4555-8555-555555555555",
			completed: false,
			deploymentId: "hdep_test",
		});
		expect(
			projectHostedDeployRequest(
				requestStatus({
					request_status: "pending",
					lineage_tail: {
						operation_name: "operations/deploy-test",
						lineage_version: 1,
						lineage_state: "processing",
					},
				}),
			),
		).toEqual({
			kind: "operation_name",
			agentId: null,
			deploymentId: null,
			operationName: "operations/deploy-test",
		});
	});

	test("separates incomplete deployment evidence, waiting, and invalid success", () => {
		expect(
			projectHostedDeployRequest(
				requestStatus({
					request_status: "processing",
					lineage_tail: {
						deployment_id: "hdep_test",
						lineage_version: 1,
						lineage_state: "processing",
					},
				}),
			),
		).toEqual({
			kind: "deployment",
			agentId: null,
			completed: false,
			deploymentId: "hdep_test",
		});
		expect(projectHostedDeployRequest(requestStatus({}))).toEqual({ kind: "wait" });
		expect(projectHostedDeployRequest(requestStatus({ request_status: "succeeded" }))).toEqual({
			kind: "invalid_success",
		});
	});
});
