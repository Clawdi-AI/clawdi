import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { components } from "@clawdi/shared/api";
import type { AgentTile } from "@/components/dashboard/agents-card";
import {
	claimedEnvIdsFromDeployments,
	hostedDeploymentMembers,
} from "@/hosted/hosted-agent-resolution";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

type Env = components["schemas"]["AgentResponse"];
type SelectUnifiedAgentList =
	typeof import("@/hosted/use-unified-agent-list").selectUnifiedAgentList;
type DeploymentToTiles = typeof import("@/hosted/use-hosted-agent-tiles").deploymentToTiles;
type ResolveLegacyEnvIds = typeof import("@/hosted/agents/ownership-sensor").resolveLegacyEnvIds;

let getUnifiedAgentList: SelectUnifiedAgentList | null = null;
let getDeploymentToTiles: DeploymentToTiles | null = null;
let getLegacyEnvIdsResolution: ResolveLegacyEnvIds | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/use-unified-agent-list");
	getUnifiedAgentList = module.selectUnifiedAgentList;
	const tilesModule = await import("@/hosted/use-hosted-agent-tiles");
	getDeploymentToTiles = tilesModule.deploymentToTiles;
	const ownershipModule = await import("@/hosted/agents/ownership-sensor");
	getLegacyEnvIdsResolution = ownershipModule.resolveLegacyEnvIds;
});

function selectUnifiedAgentList(args: Parameters<SelectUnifiedAgentList>[0]) {
	if (!getUnifiedAgentList) throw new Error("selectUnifiedAgentList was not loaded");
	return getUnifiedAgentList(args);
}

function deploymentToTiles(...args: Parameters<DeploymentToTiles>) {
	if (!getDeploymentToTiles) throw new Error("deploymentToTiles was not loaded");
	return getDeploymentToTiles(...args);
}

function resolveLegacyEnvIds(...args: Parameters<ResolveLegacyEnvIds>) {
	if (!getLegacyEnvIdsResolution) throw new Error("resolveLegacyEnvIds was not loaded");
	return getLegacyEnvIdsResolution(...args);
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
			href: null,
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
			href: null,
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

	test("withholds connected classification when legacy access is unresolved but legacy tiles are hidden", () => {
		const possibleLegacy = env("22222222-2222-4222-8222-222222222222", "possible-legacy-env");
		const selection = selectUnifiedAgentList({
			cloudEnvs: [possibleLegacy],
			hostedTiles: [],
			claimedEnvIds: new Set(),
			legacyEnvIds: null,
			hostedInventoryStatus: "resolved",
			showLegacyAgents: false,
		});

		expect(selection.connectedTiles).toEqual([]);
		expect(selection.membershipResolved).toBe(false);
	});

	test("uses resolved legacy ownership for deduplication even when legacy tiles are hidden", () => {
		const legacy = env("22222222-2222-4222-8222-222222222222", "legacy-env");
		const connected = env("33333333-3333-4333-8333-333333333333", "connected-env");
		const selection = selectUnifiedAgentList({
			cloudEnvs: [legacy, connected],
			hostedTiles: [],
			claimedEnvIds: new Set(),
			legacyEnvIds: new Set([legacy.id]),
			hostedInventoryStatus: "resolved",
			showLegacyAgents: false,
		});

		expect(selection.connectedTiles.map((tile) => tile.id)).toEqual([connected.id]);
		expect(selection.membershipResolved).toBe(true);
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
			href: `/agents/${claimed.id}?source=on-clawdi&d=dep_running`,
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

	test("hides a deleted deployment without resurfacing its lagging environment as connected", () => {
		const projected = env("44444444-4444-4444-8444-444444444444", "deleted-hosted-env");
		const deleted = hostedDeploymentFixture({
			id: "dep_deleted",
			status: "deleted",
			cloudEnvironments: { openclaw: projected.id },
		});
		const deployments = hostedDeploymentMembers([deleted]);
		const hostedTiles = deploymentToTiles(deleted, new Map([[projected.id, projected]]));
		const selection = selectUnifiedAgentList({
			cloudEnvs: [projected],
			hostedTiles,
			claimedEnvIds: claimedEnvIdsFromDeployments(deployments),
			legacyEnvIds: new Set(),
			hostedInventoryStatus: "resolved",
			showLegacyAgents: false,
		});

		expect(deployments).toEqual([deleted]);
		expect(selection.hostedTiles).toEqual([]);
		expect(selection.connectedTiles).toEqual([]);
		expect(selection.tiles).toEqual([]);
	});
});

describe("legacy membership resolution", () => {
	test("keeps loading and failed access unresolved", () => {
		const error = new Error("access unavailable");

		expect(resolveLegacyEnvIds("unresolved", ["cached-legacy-env"], null)).toEqual({
			envIds: null,
			error: null,
			isLoading: true,
		});
		expect(resolveLegacyEnvIds("unresolved", ["cached-legacy-env"], error)).toEqual({
			envIds: null,
			error,
			isLoading: false,
		});
	});

	test("only treats an authoritative denial as empty legacy ownership", () => {
		expect(resolveLegacyEnvIds("disabled", undefined, null)).toEqual({
			envIds: new Set(),
			error: null,
			isLoading: false,
		});
	});

	test("surfaces an initial endpoint failure instead of remaining in loading state", () => {
		const error = new Error("legacy endpoint unavailable");
		const unifiedSource = readFileSync(
			new URL("./use-unified-agent-list.ts", import.meta.url),
			"utf8",
		);
		const sectionSource = readFileSync(
			new URL("./hosted-agents-section.tsx", import.meta.url),
			"utf8",
		);

		expect(resolveLegacyEnvIds("enabled", undefined, error)).toEqual({
			envIds: null,
			error,
			isLoading: false,
		});
		expect(unifiedSource).toContain("error: hosted.error ?? legacy.error");
		expect(sectionSource).toContain("{unified.error ? (");
		expect(sectionSource).toContain("<HostedUnavailableBanner");
	});
});

describe("unified list consumers", () => {
	test("sidebar and homepage use the shared unified list hook", () => {
		const srcDir = resolve(import.meta.dir, "..");
		const sidebar = readFileSync(resolve(srcDir, "components/app-sidebar.tsx"), "utf8");
		const homepage = readFileSync(resolve(srcDir, "hosted/hosted-agents-section.tsx"), "utf8");
		const onboarding = readFileSync(
			resolve(srcDir, "components/dashboard/onboarding-card.tsx"),
			"utf8",
		);

		expect(sidebar).toContain('import("@/hosted/use-unified-agent-list")');
		expect(sidebar).toContain("hostedMembershipResolved");
		expect(sidebar).toContain("activeAgentTile");
		expect(homepage).toContain("useUnifiedAgentList({");
		expect(homepage).not.toContain("connectedAgentTilesForHostedView");
		expect(homepage).not.toContain("useHostedAgentTiles({");
		expect(homepage).toContain("<HostedEmptyAccountHero canDeployOnClawdi={canDeployOnClawdi} />");
		expect(homepage).toContain("<WelcomeWalletCard showDeployAction={false} />");
		expect(onboarding).toContain("Deploy on Clawdi");
		expect(onboarding).toContain("Connect an agent on your machine");
	});
});
