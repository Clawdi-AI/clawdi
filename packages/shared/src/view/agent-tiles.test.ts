import { describe, expect, it } from "bun:test";
import type { components } from "../api";
import { type AgentTile, agentTileCardProjection, selfManagedAgentTiles } from "./agent-tiles";

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
	});
});

describe("agentTileCardProjection", () => {
	it("prioritizes hosted card status over activity and runtime identity", () => {
		const projected = env({
			last_seen_at: new Date(Date.now() - 30_000).toISOString(),
			last_sync_at: new Date().toISOString(),
			sync_enabled: true,
		});
		const tile: AgentTile = {
			id: projected.id,
			source: "on-clawdi",
			name: "Research agent",
			agentType: "openclaw",
			href: `/agents/${projected.id}`,
			env: projected,
			cardStatus: {
				visual: { label: "Running", tooltip: "Agent status: Running.", dotClass: "dot" },
				labels: ["Running", "Restart required"],
			},
		};

		const projection = agentTileCardProjection(tile);

		expect(projection.statusVisual).toMatchObject({
			label: "Running",
			tooltip: "Agent status: Running.",
		});
		expect(projection.meta).toEqual(["Running"]);
	});

	it("does not manufacture hosted sync status without an environment projection", () => {
		const tile: AgentTile = {
			id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			source: "on-clawdi",
			name: "Research agent",
			agentType: "openclaw",
			href: "/agents/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			env: null,
		};

		expect(agentTileCardProjection(tile)).toEqual({
			meta: ["OpenClaw"],
			statusVisual: null,
		});
	});

	it("keeps self-managed setup and legacy live-sync semantics", () => {
		const selfManaged: AgentTile = {
			id: "self",
			source: "self-managed",
			name: "Workstation",
			agentType: "codex",
			href: "/agents/self",
			env: env(),
		};
		const legacy: AgentTile = {
			...selfManaged,
			id: "legacy",
			source: "legacy-hosted",
			env: env({ last_sync_at: new Date().toISOString(), sync_enabled: true }),
		};

		expect(agentTileCardProjection(selfManaged).statusVisual?.label).toBe("Setup");
		expect(agentTileCardProjection(legacy).statusVisual?.label).toBe("Live");
	});

	it("falls back to activity ahead of runtime identity", () => {
		const [syncedTile, seenTile] = selfManagedAgentTiles([
			env({ last_sync_at: new Date().toISOString() }),
			env({
				id: "33333333-3333-4333-8333-333333333333",
				last_seen_at: new Date().toISOString(),
				last_sync_at: null,
			}),
		]);

		const syncedMeta = agentTileCardProjection(syncedTile).meta;
		const seenMeta = agentTileCardProjection(seenTile).meta;

		expect(syncedMeta).toHaveLength(1);
		expect(syncedMeta[0]).toStartWith("Synced ");
		expect(seenMeta).toHaveLength(1);
		expect(seenMeta[0]).toStartWith("Seen ");
	});
});
