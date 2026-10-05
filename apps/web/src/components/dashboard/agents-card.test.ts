import { beforeAll, describe, expect, it } from "bun:test";
import type { components } from "@clawdi/shared/api";
import type { AgentTile } from "@clawdi/shared/view";
import { agentTileMatchesRouteId } from "@/components/dashboard/agents-card";

type FocusHeaderSyncSource = typeof import("@/components/app-sidebar").focusHeaderSyncSource;
type FocusHeaderComputeStatus = typeof import("@/components/app-sidebar").focusHeaderComputeStatus;
type ScopedAgentResourceSidebarTarget =
	typeof import("@/components/app-sidebar").scopedAgentResourceSidebarTarget;

type Env = components["schemas"]["AgentResponse"];

let getFocusHeaderSyncSource: FocusHeaderSyncSource | null = null;
let getFocusHeaderComputeStatus: FocusHeaderComputeStatus | null = null;
let getScopedAgentResourceSidebarTarget: ScopedAgentResourceSidebarTarget | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const sidebar = await import("@/components/app-sidebar");
	getFocusHeaderSyncSource = sidebar.focusHeaderSyncSource;
	getFocusHeaderComputeStatus = sidebar.focusHeaderComputeStatus;
	getScopedAgentResourceSidebarTarget = sidebar.scopedAgentResourceSidebarTarget;
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

describe("focused sidebar status projection", () => {
	it("uses compute status for hosted agents and never reclassifies it from sync", () => {
		if (!getFocusHeaderSyncSource) throw new Error("focusHeaderSyncSource was not loaded");
		if (!getFocusHeaderComputeStatus) throw new Error("focusHeaderComputeStatus was not loaded");
		const hosted: AgentTile = {
			id: "hosted",
			source: "on-clawdi",
			name: "Hosted agent",
			agentType: "hermes",
			href: "/agents/hosted",
			env: env({ sync_enabled: true, last_sync_at: "2020-01-01T00:00:00Z" }),
			cardStatus: {
				visual: { label: "Running", tooltip: "Compute status: Running.", dotClass: "dot" },
				labels: ["Running"],
			},
		};

		expect(getFocusHeaderSyncSource("cloud", true)).toBeNull();
		expect(getFocusHeaderSyncSource("cloud", false)).toBeNull();
		expect(getFocusHeaderComputeStatus("cloud", hosted)?.label).toBe("Running");
		expect(getFocusHeaderComputeStatus("cloud", { ...hosted, cardStatus: undefined })).toBeNull();
	});

	it("preserves connected and legacy status copy", () => {
		if (!getFocusHeaderSyncSource) throw new Error("focusHeaderSyncSource was not loaded");

		expect(getFocusHeaderSyncSource("connected", true)).toBe("self-managed");
		expect(getFocusHeaderSyncSource("legacy", true)).toBe("on-clawdi");
		if (!getFocusHeaderComputeStatus) throw new Error("focusHeaderComputeStatus was not loaded");
		expect(getFocusHeaderComputeStatus("connected", null)).toBeNull();
	});
});

describe("focused sidebar resource scope", () => {
	it("activates the exact Workspace resource for primary-scoped detail routes", () => {
		if (!getScopedAgentResourceSidebarTarget) {
			throw new Error("scopedAgentResourceSidebarTarget was not loaded");
		}

		expect(
			getScopedAgentResourceSidebarTarget(
				"/agents/agent-one/skills/vendor/review",
				"?project=workspace-one",
				"workspace-one",
				["context-one"],
			),
		).toEqual({ kind: "workspace", resource: "skills" });
		expect(
			getScopedAgentResourceSidebarTarget(
				"/agents/agent-one/vaults/production",
				"?project=WORKSPACE-ONE",
				"workspace-one",
				["context-one"],
			),
		).toEqual({ kind: "workspace", resource: "vaults" });
	});

	it("activates Projects only for a bound context Project", () => {
		if (!getScopedAgentResourceSidebarTarget) {
			throw new Error("scopedAgentResourceSidebarTarget was not loaded");
		}

		expect(
			getScopedAgentResourceSidebarTarget(
				"/agents/agent-one/skills/vendor/review",
				"?project=context-one",
				"workspace-one",
				["context-one"],
			),
		).toEqual({ kind: "projects" });
		expect(
			getScopedAgentResourceSidebarTarget(
				"/agents/agent-one/vaults/production",
				"?project=unbound-project",
				"workspace-one",
				["context-one"],
			),
		).toBeNull();
	});
});

describe("agentTileMatchesRouteId", () => {
	it("matches hosted tiles only by canonical Agent identity", () => {
		const projected = env({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
		const tile: AgentTile = {
			id: projected.id,
			source: "on-clawdi",
			name: "Hosted agent",
			agentType: "openclaw",
			href: `/agents/${projected.id}`,
			env: projected,
		};

		expect(agentTileMatchesRouteId(tile, projected.id)).toBe(true);
		expect(agentTileMatchesRouteId(tile, projected.id.toUpperCase())).toBe(true);
		expect(agentTileMatchesRouteId(tile, "hdep_paid")).toBe(false);
	});
});
