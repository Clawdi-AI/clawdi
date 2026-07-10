import { describe, expect, test } from "bun:test";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { usesActiveFreeComputeSlot } from "@/hosted/billing/deploy/deploy-model";

function deployment(
	status: string,
	computePlanSlug: "compute_free" | "compute_performance",
): HostedDeployment {
	return {
		id: `hdep_${status}_${computePlanSlug}`,
		user_id: "usr_test",
		name: "Test agent",
		app_id: "v2-test",
		status,
		created_at: "2026-06-24T00:00:00Z",
		upgrade_available: false,
		config_info: {
			compute_plan_slug: computePlanSlug,
			mux_enabled: false,
			telegram_mux_enabled: false,
			discord_mux_enabled: false,
			whatsapp_mux_enabled: false,
			imessage_mux_enabled: false,
			kobb_available: false,
			ai_provider_auth_kind: "managed",
			runtime: "openclaw",
			clawdi_cloud_environments: {},
			ai_provider_bindings: {},
			public_ports: [],
		},
	};
}

describe("usesActiveFreeComputeSlot", () => {
	test("treats non-stopped Free deployments as occupying the user Free slot", () => {
		expect(usesActiveFreeComputeSlot([deployment("running", "compute_free")])).toBe(true);
		expect(usesActiveFreeComputeSlot([deployment("starting", "compute_free")])).toBe(true);
		expect(usesActiveFreeComputeSlot([deployment("failed", "compute_free")])).toBe(true);
		expect(usesActiveFreeComputeSlot([deployment("deleting", "compute_free")])).toBe(true);
	});

	test("does not count stopped or deleted Free deployments or Performance deployments", () => {
		expect(usesActiveFreeComputeSlot([deployment("stopped", "compute_free")])).toBe(false);
		expect(usesActiveFreeComputeSlot([deployment("deleted", "compute_free")])).toBe(false);
		expect(usesActiveFreeComputeSlot([deployment("running", "compute_performance")])).toBe(false);
	});
});

/**
 * The compute-slot contract. Every row must match the deploy-API's
 * `slot_occupancy.py::v2_hosted_deployment_occupies_compute_slot` exactly —
 * a divergence here is what locked a production user out of deploying
 * (a `failed` row with no k8s resources held the free slot forever, while
 * the agents view sourced from cloud-api envs never showed it).
 */
describe("usesActiveFreeComputeSlot agrees with the backend predicate", () => {
	const cases: Array<{ status: string; failureReason: string | null; occupies: boolean }> = [
		{ status: "running", failureReason: null, occupies: true },
		{ status: "starting", failureReason: null, occupies: true },
		{ status: "creating", failureReason: null, occupies: true },
		{ status: "deleting", failureReason: null, occupies: true },
		{ status: "stopped", failureReason: null, occupies: false },
		{ status: "deleted", failureReason: null, occupies: false },
		// failed: only released when the reason proves the infra is gone.
		{ status: "failed", failureReason: "backend_status=not_found", occupies: false },
		{
			status: "failed",
			failureReason: "backend_status=not_found; statefulset missing",
			occupies: false,
		},
		{ status: "failed", failureReason: "creation_interrupted", occupies: false },
		{ status: "failed", failureReason: "startup_probe_failing; restart_count=2", occupies: true },
		{ status: "failed", failureReason: null, occupies: true },
		// unknown future statuses are treated as occupying (fail closed).
		{ status: "some_future_state", failureReason: null, occupies: true },
	];

	for (const { status, failureReason, occupies } of cases) {
		test(`${status} / ${failureReason ?? "no reason"} → ${occupies ? "occupies" : "free"}`, () => {
			const d = { ...deployment(status, "compute_free"), failure_reason: failureReason };
			expect(usesActiveFreeComputeSlot([d])).toBe(occupies);
		});
	}

	test("ignores non-free plans entirely", () => {
		const d = { ...deployment("running", "compute_performance"), failure_reason: null };
		expect(usesActiveFreeComputeSlot([d])).toBe(false);
	});
});
