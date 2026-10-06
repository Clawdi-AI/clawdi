import { describe, expect, test } from "bun:test";
import {
	ApiClientError,
	type DeployComponents,
	type HostedDeployPlan,
	type HostedDeployWizardDraft,
	type HostedIncludedBasicAvailability,
	validateAndBuildHostedDeployRequest,
} from "@clawdi/shared/api";
import {
	type CreationAttempt,
	canDiscardCreationAttempt,
	isDefinitiveAdmissionRejection,
	offeredQuoteSelections,
	parseCreationAttempt,
	serverAllowsEntitledCreation,
} from "@/hosted/billing/deploy/deploy-request";

describe("durable creation boundary", () => {
	const capabilities: DeployComponents["schemas"]["V1UserProductCapabilities"] = {
		can_use_v1: true,
		can_use_v2: true,
		can_create_v1_deployment: false,
	};
	const included: HostedIncludedBasicAvailability = {
		total_slots: 1,
		used_slots: 0,
		available_slots: 1,
	};
	const basic: HostedDeployPlan = {
		slug: "compute_basic",
		name: "Basic",
		price_cents: 1000,
		vcpu: 1,
		ram_gb: 2,
		disk_size: 20,
		signup_grant_usd: "0",
	};
	test("creation requires actual capability, matching inventory and a supported catalog plan", () => {
		expect(serverAllowsEntitledCreation(capabilities, included, basic)).toBe(true);
		expect(
			serverAllowsEntitledCreation({ ...capabilities, can_use_v2: false }, included, basic),
		).toBe(false);
		expect(serverAllowsEntitledCreation(undefined, included, basic)).toBe(false);
		expect(
			serverAllowsEntitledCreation(capabilities, { ...included, available_slots: 0 }, basic),
		).toBe(false);
		expect(serverAllowsEntitledCreation(capabilities, included, undefined)).toBe(false);
		expect(
			serverAllowsEntitledCreation(capabilities, included, {
				...basic,
				slug: "compute_performance",
			}),
		).toBe(false);
	});
	test("quote choices follow offered plans and monthly/annual terms", () => {
		const performance: HostedDeployPlan = {
			...basic,
			slug: "compute_performance",
			offers: [
				{
					billing_term_months: 12,
					price_cents: 10000,
					effective_monthly_price_cents: 833,
					discount_percent: 17,
				},
			],
		};
		expect(offeredQuoteSelections([basic, performance])).toEqual([
			{ planSlug: "compute_basic", billingTermMonths: 1, fundingSource: "stripe" },
			{ planSlug: "compute_performance", billingTermMonths: 12, fundingSource: "stripe" },
		]);
	});
	test("same-key recovery does not depend on capacity consumed by the original admission", () => {
		expect(
			serverAllowsEntitledCreation(capabilities, undefined, undefined, { hasSavedAttempt: true }),
		).toBe(true);
		expect(
			serverAllowsEntitledCreation({ ...capabilities, can_use_v2: false }, included, basic, {
				hasSavedAttempt: true,
			}),
		).toBe(false);
		const reusable: DeployComponents["schemas"]["V2ComputeReusableSubscriptionItem"] = {
			subscription_id: "csub_K8fJ3pQm",
			plan_slug: "compute_basic",
			billing_term_months: 1,
			funding_source: "stripe",
			status: "active",
			currency: "usd",
			entitled_until: "2026-11-01T00:00:00Z",
			cancel_at_period_end: false,
		};
		const performance = { ...basic, slug: "compute_performance" };
		expect(
			serverAllowsEntitledCreation(capabilities, included, performance, { reusable: [reusable] }),
		).toBe(false);
		expect(
			serverAllowsEntitledCreation(capabilities, included, performance, {
				reusable: [{ ...reusable, plan_slug: "compute_performance" }],
			}),
		).toBe(true);
		expect(
			serverAllowsEntitledCreation(
				capabilities,
				included,
				{ ...performance, slug: "unknown" },
				{ reusable: [reusable] },
			),
		).toBe(false);
		expect(
			serverAllowsEntitledCreation(capabilities, { ...included, available_slots: 0 }, basic, {
				reusable: [reusable],
			}),
		).toBe(true);
		expect(
			serverAllowsEntitledCreation(capabilities, { ...included, available_slots: 0 }, basic, {
				reusable: [{ ...reusable, plan_slug: "compute_performance" }],
			}),
		).toBe(false);
	});
	test("restore rejects malformed IDs and unsupported runtime", () => {
		const draft: HostedDeployWizardDraft = {
			runtime: "hermes",
			computePlanSlug: "compute_basic",
			agentName: " A ",
			language: "en",
			timezone: "",
			ai: { mode: "unmanaged" },
		};
		const built = validateAndBuildHostedDeployRequest(draft);
		if (!built.ok) throw new Error("Invalid fixture");
		const id = "8e244ab3-1111-4111-8111-111111111111";
		const saved: CreationAttempt = {
			version: 1,
			submission: "prepared",
			id,
			draft,
			request: { ...built.request, deploy_request_id: id },
		};
		expect(parseCreationAttempt(JSON.stringify(saved))).toEqual(saved);
		const performanceDraft: HostedDeployWizardDraft = {
			...draft,
			computePlanSlug: "compute_performance",
		};
		const performanceBuilt = validateAndBuildHostedDeployRequest(performanceDraft);
		if (!performanceBuilt.ok) throw new Error("Invalid Performance fixture");
		const performanceSaved: CreationAttempt = {
			...saved,
			submission: "uncertain",
			draft: performanceDraft,
			request: { ...performanceBuilt.request, deploy_request_id: id },
		};
		expect(parseCreationAttempt(JSON.stringify(performanceSaved))).toEqual(performanceSaved);
		expect(canDiscardCreationAttempt(performanceSaved)).toBe(false);
		expect(
			parseCreationAttempt(JSON.stringify({ ...saved, submission: undefined }))?.submission,
		).toBe("uncertain");
		expect(
			parseCreationAttempt(JSON.stringify({ ...saved, submission: "unrecognized" })),
		).toBeNull();
		expect(canDiscardCreationAttempt(saved)).toBe(true);
		expect(canDiscardCreationAttempt({ ...saved, submission: "entitlement_rejected" })).toBe(true);
		expect(canDiscardCreationAttempt({ ...saved, submission: "uncertain" })).toBe(false);
		const denied = new ApiClientError(409, "compute_entitlement_required");
		expect(isDefinitiveAdmissionRejection(saved, denied)).toBe(true);
		expect(isDefinitiveAdmissionRejection({ ...saved, submission: "uncertain" }, denied)).toBe(
			false,
		);
		for (const error of [
			new ApiClientError(404),
			new ApiClientError(409, "compute_entitlement_pending"),
			new ApiClientError(500),
			new Error("network"),
		])
			expect(isDefinitiveAdmissionRejection(saved, error)).toBe(false);
		expect(parseCreationAttempt(JSON.stringify({ ...saved, id: "weak-id" }))).toBeNull();
		expect(
			parseCreationAttempt(
				JSON.stringify({ ...saved, draft: { ...saved.draft, runtime: "other" } }),
			),
		).toBeNull();
		expect(
			parseCreationAttempt(
				JSON.stringify({ ...saved, request: { ...saved.request, name: "different" } }),
			),
		).toBeNull();
		expect(
			parseCreationAttempt(
				JSON.stringify({
					...saved,
					request: { ...saved.request, deploy_request_id: "another-key" },
				}),
			),
		).toBeNull();
		expect(parseCreationAttempt("{broken")).toBeNull();
	});
});
