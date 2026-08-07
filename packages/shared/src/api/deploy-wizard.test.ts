import { describe, expect, test } from "bun:test";
import type {
	HostedDeployCheckoutUiMode,
	HostedDeployDeployment,
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
	usesHostedDeployIncludedBasicSlot,
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

function includedDeployment(occupiesSlot: boolean | null): HostedDeployDeployment {
	return {
		resource: {
			id: "hdep_test",
			name: "Hermes",
			owner_user_id: "usr_test",
			commercial_revision: 0,
			deployment_target: "test",
			metadata: {
				generation: 1,
				manifestETag: "manifest-1",
				resourceVersion: "1",
				createdAt: "2026-07-28T00:00:00Z",
				updatedAt: "2026-07-28T00:00:00Z",
			},
			spec: {
				schema_version: 1,
				desired_lifecycle: "running",
				runtime: "hermes",
				runtime_version: "test",
				resources: { vcpu: 2, memory_mib: 4096, disk_gib: 20 },
				agents: [],
				ports: [],
				runtime_configuration: { providers: [], features: [] },
				rollout_nonce: 0,
				secret_references: [],
			},
			status: {
				summary_state: "running",
				observedGeneration: 1,
				conditions: [],
				backing_infrastructure: "present",
				driver_acknowledged_generation: 1,
				driver_applied_generation: 1,
				driver_observation_sequence: 1,
				endpoints: [],
			},
		},
		clawdi_cloud_environments: {},
		ai_provider_auth_kinds: { hermes: "managed" },
		accepted_operation: null,
		commercial_display: {
			compute_subscription: {
				status: "active",
				funding_source: null,
				payment_state: "ok",
				billing_term_months: 1,
				price_cents: 0,
				currency: "usd",
				cancel_at_period_end: false,
			},
			latest_funding_fact: null,
		},
		current_plan_slug: "compute_basic",
		upgrade_available: true,
		upgrade_eligibility: { eligible: true, reason: null },
		compute_slot_occupancy:
			occupiesSlot === null
				? null
				: {
						occupies_slot: occupiesSlot,
						backing_infra: occupiesSlot ? "present" : "absent",
						reason: occupiesSlot ? "backing_infra_present" : "authoritative_absence",
					},
	};
}

function acceptedDeleteOperation(): NonNullable<HostedDeployDeployment["accepted_operation"]> {
	return {
		name: "operations/delete-hdep_test",
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_test",
			verb: "delete",
			targetGeneration: 2,
			manifestETag: "manifest-delete",
			createTime: "2026-07-28T00:01:00Z",
			updateTime: "2026-07-28T00:01:00Z",
		},
		done: false,
		response: null,
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

	test("distinguishes an occupied, available, and unknown included Basic slot", () => {
		expect(usesHostedDeployIncludedBasicSlot([includedDeployment(true)])).toBe(true);
		expect(usesHostedDeployIncludedBasicSlot([includedDeployment(false)])).toBe(false);
		expect(usesHostedDeployIncludedBasicSlot([includedDeployment(null)])).toBeNull();
	});

	test("honors delete_accepted occupancy while backing infrastructure remains", () => {
		const deleting = includedDeployment(false);
		deleting.compute_slot_occupancy = {
			occupies_slot: false,
			backing_infra: "present",
			reason: "delete_accepted",
		};

		expect(usesHostedDeployIncludedBasicSlot([deleting])).toBe(false);
	});

	test("optimistically releases the included Basic slot as soon as delete is accepted", () => {
		const deleting = includedDeployment(true);
		deleting.accepted_operation = acceptedDeleteOperation();

		expect(usesHostedDeployIncludedBasicSlot([deleting])).toBe(false);
		expect(usesHostedDeployIncludedBasicSlot([deleting, includedDeployment(true)])).toBe(true);
	});

	test("restores included Basic occupancy when an accepted delete is cancelled", () => {
		const restored = includedDeployment(true);
		const acceptedDelete = acceptedDeleteOperation();
		restored.accepted_operation = {
			...acceptedDelete,
			done: true,
			error: {
				code: 1,
				message: "Delete was cancelled before teardown.",
				details: [],
			},
			response: null,
		};

		expect(usesHostedDeployIncludedBasicSlot([restored])).toBe(true);
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
				target: { kind: "new_deployment", deployRequest },
				idempotencyKey: "request-stable",
				quote,
				uiMode: "hosted",
			}),
		).toMatchObject({
			funding_source: "wallet",
			ui_mode: "hosted",
			quote,
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

	test("preserves the browser projection order for terminal, operation, and deployment evidence", () => {
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
					request_status: "processing",
					lineage_tail: {
						deployment_id: "hdep_test",
						operation_name: "operations/deploy-test",
						lineage_version: 1,
						lineage_state: "processing",
					},
				}),
			),
		).toEqual({ kind: "deployment", completed: false, deploymentId: "hdep_test" });
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
		).toEqual({ kind: "deployment", completed: false, deploymentId: "hdep_test" });
		expect(projectHostedDeployRequest(requestStatus({}))).toEqual({ kind: "wait" });
		expect(projectHostedDeployRequest(requestStatus({ request_status: "succeeded" }))).toEqual({
			kind: "invalid_success",
		});
	});
});
