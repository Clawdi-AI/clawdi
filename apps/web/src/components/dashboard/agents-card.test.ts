import { beforeAll, describe, expect, it } from "bun:test";
import type { components } from "@clawdi/shared/api";
import {
	type AgentTile,
	agentTileCardProjection,
	agentTileMatchesRouteId,
	fleetSummaryFromTiles,
	selfManagedAgentTiles,
} from "@/components/dashboard/agents-card";

type FocusHeaderSyncSource = typeof import("@/components/app-sidebar").focusHeaderSyncSource;

type Env = components["schemas"]["AgentResponse"];

let getFocusHeaderSyncSource: FocusHeaderSyncSource | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const sidebar = await import("@/components/app-sidebar");
	getFocusHeaderSyncSource = sidebar.focusHeaderSyncSource;
});

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
		expect("statusLabel" in tile).toBe(false);
		expect("runtimeLabel" in tile).toBe(false);
	});
});

describe("agentTileCardProjection", () => {
	it("shows real v2 hosted live sync and retains useful card metadata", () => {
		const projected = env({
			last_seen_at: new Date(Date.now() - 30_000).toISOString(),
			last_sync_at: new Date().toISOString(),
			sync_enabled: true,
		});
		const tile: AgentTile = {
			id: "hdep_live",
			source: "on-clawdi",
			name: "Research agent",
			agentType: "openclaw",
			href: `/agents/${projected.id}`,
			env: projected,
		};

		const projection = agentTileCardProjection(tile);

		expect(projection.statusVisual).toMatchObject({
			kind: "live",
			label: "Live",
			tooltip: "Sync is live.",
		});
		expect(projection.meta[0]).toBe("OpenClaw");
		expect(projection.meta[1]).toStartWith("Synced ");
	});

	it("does not manufacture hosted sync status without an environment projection", () => {
		const tile: AgentTile = {
			id: "hdep_pending_projection",
			source: "on-clawdi",
			name: "Research agent",
			agentType: "openclaw",
			href: "/agents/env_pending",
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

	it("labels last-seen fallback explicitly when no sync timestamp exists", () => {
		const [tile] = selfManagedAgentTiles([
			env({ last_seen_at: new Date().toISOString(), last_sync_at: null }),
		]);

		expect(agentTileCardProjection(tile).meta[1]).toStartWith("Seen ");
	});
});

describe("focused sidebar sync projection", () => {
	it("shows Cloud sync only after the environment projection exists", () => {
		if (!getFocusHeaderSyncSource) throw new Error("focusHeaderSyncSource was not loaded");

		expect(getFocusHeaderSyncSource("cloud", true)).toBe("on-clawdi");
		expect(getFocusHeaderSyncSource("cloud", false)).toBeNull();
	});

	it("preserves connected and legacy status copy", () => {
		if (!getFocusHeaderSyncSource) throw new Error("focusHeaderSyncSource was not loaded");

		expect(getFocusHeaderSyncSource("connected", true)).toBe("self-managed");
		expect(getFocusHeaderSyncSource("legacy", true)).toBe("on-clawdi");
	});
});

describe("agentTileMatchesRouteId", () => {
	it("matches hosted tiles by deployment id or projected environment id", () => {
		const projected = env({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
		const tile: AgentTile = {
			id: "hdep_paid",
			source: "on-clawdi",
			name: "Hosted agent",
			agentType: "openclaw",
			href: `/agents/${projected.id}?source=on-clawdi&d=hdep_paid`,
			env: projected,
		};

		expect(agentTileMatchesRouteId(tile, "hdep_paid")).toBe(true);
		expect(agentTileMatchesRouteId(tile, projected.id)).toBe(true);
		expect(agentTileMatchesRouteId(tile, projected.id.toUpperCase())).toBe(true);
		expect(agentTileMatchesRouteId(tile, "hdep_other")).toBe(false);
	});

	it("uses the deployment selector when multiple hosted tiles claim the route id", () => {
		const projected = env({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
		const selected: AgentTile = {
			id: "hdep_selected",
			source: "on-clawdi",
			name: "Selected deployment",
			agentType: "openclaw",
			href: `/agents/${projected.id}?source=on-clawdi&d=hdep_selected`,
			env: null,
		};
		const replacement: AgentTile = {
			...selected,
			id: "hdep_replacement",
			name: "Replacement deployment",
			env: projected,
		};

		expect(agentTileMatchesRouteId(selected, projected.id, "hdep_selected")).toBe(true);
		expect(agentTileMatchesRouteId(replacement, projected.id, "hdep_selected")).toBe(false);
		expect(agentTileMatchesRouteId(replacement, projected.id, "hdep_missing")).toBe(false);
	});
});

describe("fleetSummaryFromTiles", () => {
	it("summarizes inventory without inventing an activity clock", () => {
		const selfManaged = selfManagedAgentTiles([
			env({
				last_seen_at: new Date().toISOString(),
			}),
		]);
		const hostedRunningWithoutEnv: AgentTile = {
			id: "dep_123:codex",
			source: "on-clawdi",
			name: "Codex",
			agentType: "codex",
			href: "/agents/dep_123",
			env: null,
		};
		const hostedStoppedWithFreshEnv: AgentTile = {
			id: "dep_456:codex",
			source: "on-clawdi",
			name: "Stopped Codex",
			agentType: "codex",
			href: "/agents/dep_456",
			env: env({ last_seen_at: new Date().toISOString() }),
		};

		expect(
			fleetSummaryFromTiles([...selfManaged, hostedRunningWithoutEnv, hostedStoppedWithFreshEnv]),
		).toEqual({ total: 3 });
	});
});
