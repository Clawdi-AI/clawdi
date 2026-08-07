import { describe, expect, test } from "bun:test";
import type { components } from "@clawdi/shared/api";
import { agentRegistrationDescription } from "@/components/dashboard/agent-registration-status";

type Env = components["schemas"]["AgentResponse"];

function env(overrides: Partial<Env> = {}): Env {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		name: "workstation",
		default_name: "workstation",
		machine_name: "workstation",
		agent_type: "codex",
		agent_version: null,
		os: "linux",
		last_seen_at: new Date().toISOString(),
		last_sync_at: null,
		last_sync_error: null,
		last_revision_seen: null,
		sort_order: 0,
		queue_depth_high_water: 0,
		dropped_count: 0,
		sync_enabled: true,
		default_project_id: "22222222-2222-4222-8222-222222222222",
		...overrides,
	} as Env;
}

describe("agentRegistrationDescription", () => {
	test("does not promise automatic session sync from registration alone", () => {
		expect(agentRegistrationDescription([env()])).toBe(
			"Registration is complete. Waiting for the first successful sync.",
		);
	});

	test("confirms automatic flow only after a fresh successful sync", () => {
		expect(agentRegistrationDescription([env({ last_sync_at: new Date().toISOString() })])).toBe(
			"Live sync confirmed. New sessions can now appear here automatically.",
		);
	});
});
