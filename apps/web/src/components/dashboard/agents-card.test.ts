import { describe, expect, it } from "bun:test";
import type { components } from "@clawdi/shared/api";
import { isHostedManagedEnv, selfManagedAgentTiles } from "@/components/dashboard/agents-card";

type Env = components["schemas"]["EnvironmentResponse"];

function env(overrides: Partial<Env> = {}): Env {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		machine_name: "dev-laptop",
		agent_type: "openclaw",
		agent_version: null,
		os: "linux",
		last_seen_at: null,
		last_sync_at: null,
		last_sync_error: null,
		last_revision_seen: null,
		queue_depth_high_water: 0,
		dropped_count: 0,
		sync_enabled: false,
		hosted_managed: false,
		default_project_id: "22222222-2222-4222-8222-222222222222",
		...overrides,
	};
}

describe("selfManagedAgentTiles", () => {
	it("keeps hosted-managed environments out of connected-agent tiles", () => {
		const selfManaged = env();
		const hostedManaged = env({
			id: "33333333-3333-4333-8333-333333333333",
			machine_name: "v2-hosted-runtime",
			hosted_managed: true,
		});

		expect(isHostedManagedEnv(hostedManaged)).toBe(true);
		expect(selfManagedAgentTiles([hostedManaged, selfManaged]).map((tile) => tile.id)).toEqual([
			selfManaged.id,
		]);
	});

	it("treats hosted_deployment_id as a backwards-compatible hosted marker", () => {
		expect(isHostedManagedEnv(env({ hosted_deployment_id: "hdep_test" }))).toBe(true);
	});
});
