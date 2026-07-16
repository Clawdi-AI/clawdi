import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { components } from "@clawdi/shared/api";
import type { AgentTile } from "@/components/dashboard/agents-card";

type Env = components["schemas"]["AgentResponse"];
type SelectUnifiedAgentList =
	typeof import("@/hosted/use-unified-agent-list").selectUnifiedAgentList;

let getUnifiedAgentList: SelectUnifiedAgentList | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/use-unified-agent-list");
	getUnifiedAgentList = module.selectUnifiedAgentList;
});

function selectUnifiedAgentList(args: Parameters<SelectUnifiedAgentList>[0]) {
	if (!getUnifiedAgentList) throw new Error("selectUnifiedAgentList was not loaded");
	return getUnifiedAgentList(args);
}

function env(id: string, name: string): Env {
	return {
		id,
		name,
		default_name: name,
		machine_name: name,
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
		sync_enabled: true,
		explicit_identity: false,
		default_project_id: "22222222-2222-4222-8222-222222222222",
	};
}

describe("selectUnifiedAgentList", () => {
	test("joins hosted, legacy, and self-managed membership without duplicates", () => {
		const claimed = env("11111111-1111-4111-8111-111111111111", "claimed-cloud-env");
		const legacy = env("22222222-2222-4222-8222-222222222222", "legacy-env");
		const connected = env("33333333-3333-4333-8333-333333333333", "connected-env");
		const hostedTile: AgentTile = {
			id: "dep_failed",
			source: "on-clawdi",
			name: "OpenClaw",
			agentType: "openclaw",
			statusLabel: "Failed",
			href: null,
			active: false,
			env: null,
		};

		const selection = selectUnifiedAgentList({
			cloudEnvs: [claimed, legacy, connected],
			hostedTiles: [hostedTile],
			claimedEnvIds: new Set([claimed.id.toLowerCase()]),
			legacyEnvIds: new Set([legacy.id.toLowerCase()]),
			hostedInventoryStatus: "resolved",
			showLegacyAgents: true,
		});

		expect(selection.tiles.map((tile) => [tile.id, tile.source])).toEqual([
			["dep_failed", "on-clawdi"],
			[legacy.id, "legacy-hosted"],
			[connected.id, "self-managed"],
		]);
		expect(selection.tiles[0]?.statusLabel).toBe("Failed");
		expect(selection.tiles.some((tile) => tile.id === claimed.id)).toBe(false);
	});

	test("keeps known hosted membership but withholds connected classification while ownership is unresolved", () => {
		const claimed = env("11111111-1111-4111-8111-111111111111", "claimed-cloud-env");
		const connected = env("33333333-3333-4333-8333-333333333333", "connected-env");
		const hostedTile: AgentTile = {
			id: "dep_starting",
			source: "on-clawdi",
			name: "OpenClaw",
			agentType: "openclaw",
			statusLabel: "Starting",
			href: null,
			active: false,
			env: null,
		};

		const selection = selectUnifiedAgentList({
			cloudEnvs: [claimed, connected],
			hostedTiles: [hostedTile],
			claimedEnvIds: new Set([claimed.id.toLowerCase()]),
			legacyEnvIds: null,
			hostedInventoryStatus: "resolved",
			showLegacyAgents: true,
		});

		expect(selection.tiles.map((tile) => tile.id)).toEqual(["dep_starting"]);
		expect(selection.connectedTiles).toEqual([]);
		expect(selection.membershipResolved).toBe(false);
	});

	test("never reclassifies cloud projections while deployment membership is unresolved", () => {
		const possibleHostedProjection = env(
			"11111111-1111-4111-8111-111111111111",
			"possible-hosted-projection",
		);
		const selection = selectUnifiedAgentList({
			cloudEnvs: [possibleHostedProjection],
			hostedTiles: [],
			claimedEnvIds: new Set(),
			legacyEnvIds: new Set(),
			hostedInventoryStatus: "loading",
			showLegacyAgents: false,
		});

		expect(selection.tiles).toEqual([]);
		expect(selection.connectedTiles).toEqual([]);
		expect(selection.membershipResolved).toBe(false);
	});

	test("retains known hosted membership without classifying other projections after refresh failure", () => {
		const claimed = env("11111111-1111-4111-8111-111111111111", "claimed-cloud-env");
		const unknown = env("33333333-3333-4333-8333-333333333333", "unknown-projection");
		const hostedTile: AgentTile = {
			id: "dep_running",
			source: "on-clawdi",
			name: "OpenClaw",
			agentType: "openclaw",
			statusLabel: "Running",
			href: `/agents/${claimed.id}?source=on-clawdi&d=dep_running`,
			active: true,
			env: claimed,
		};
		const selection = selectUnifiedAgentList({
			cloudEnvs: [claimed, unknown],
			hostedTiles: [hostedTile],
			claimedEnvIds: new Set([claimed.id.toLowerCase()]),
			legacyEnvIds: new Set(),
			hostedInventoryStatus: "error",
			showLegacyAgents: false,
		});

		expect(selection.tiles.map((tile) => [tile.id, tile.source])).toEqual([
			["dep_running", "on-clawdi"],
		]);
		expect(selection.connectedTiles).toEqual([]);
		expect(selection.membershipResolved).toBe(false);
	});

	test("classifies projections as connected only after an authoritative empty snapshot", () => {
		const connected = env("33333333-3333-4333-8333-333333333333", "connected-env");
		const selection = selectUnifiedAgentList({
			cloudEnvs: [connected],
			hostedTiles: [],
			claimedEnvIds: new Set(),
			legacyEnvIds: new Set(),
			hostedInventoryStatus: "resolved",
			showLegacyAgents: false,
		});

		expect(selection.tiles.map((tile) => [tile.id, tile.source])).toEqual([
			[connected.id, "self-managed"],
		]);
		expect(selection.membershipResolved).toBe(true);
	});
});

describe("unified list consumers", () => {
	test("sidebar and homepage use the shared unified list hook", () => {
		const srcDir = resolve(import.meta.dir, "..");
		const sidebar = readFileSync(resolve(srcDir, "components/app-sidebar.tsx"), "utf8");
		const homepage = readFileSync(resolve(srcDir, "hosted/hosted-agents-section.tsx"), "utf8");

		expect(sidebar).toContain('import("@/hosted/use-unified-agent-list")');
		expect(sidebar).toContain("hostedMembershipResolved");
		expect(sidebar).toContain("activeAgentTile");
		expect(homepage).toContain("useUnifiedAgentList({");
		expect(homepage).not.toContain("connectedAgentTilesForHostedView");
		expect(homepage).not.toContain("useHostedAgentTiles({");
	});
});
