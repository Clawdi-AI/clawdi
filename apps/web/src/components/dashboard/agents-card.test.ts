import { describe, expect, it } from "bun:test";
import type { components } from "@clawdi/shared/api";
import { selfManagedAgentTiles } from "@/components/dashboard/agents-card";

type Env = components["schemas"]["AgentResponse"];

function env(overrides: Partial<Env> = {}): Env {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		name: "dev-laptop",
		default_name: "dev-laptop",
		machine_name: "dev-laptop",
		agent_type: "openclaw",
		agent_version: null,
		os: "linux",
		last_seen_at: null,
		last_sync_at: null,
		last_sync_error: null,
		last_revision_seen: null,
		sort_order: 0,
		queue_depth_high_water: 0,
		dropped_count: 0,
		sync_enabled: false,
		default_project_id: "22222222-2222-4222-8222-222222222222",
		...overrides,
	} as Env;
}

describe("selfManagedAgentTiles", () => {
	it("projects cloud-api environments without reading deployment ownership fields", () => {
		const first = env();
		const second = env({
			id: "33333333-3333-4333-8333-333333333333",
			name: "workstation-two",
			default_name: "workstation-two",
			machine_name: "workstation-two",
		});

		expect(selfManagedAgentTiles([second, first]).map((tile) => tile.id)).toEqual([
			second.id,
			first.id,
		]);
	});

	it("keeps identity labels separate from machine metadata", () => {
		const [tile] = selfManagedAgentTiles([
			env({
				name: "Research Agent",
				default_name: "Research Agent",
				display_name: "Launch runner",
				machine_name: "shared-host",
			}),
		]);

		expect(tile).toMatchObject({
			name: "Launch runner",
		});
		expect("runtimeLabel" in tile).toBe(false);
	});
});
