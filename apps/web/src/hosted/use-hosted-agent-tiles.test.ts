import { beforeAll, describe, expect, test } from "bun:test";
import type { components } from "@clawdi/shared/api";

type HostedAgentTileStatus = typeof import("@/hosted/use-hosted-agent-tiles").hostedAgentTileStatus;
type HostedRuntimeStatusView =
	typeof import("@/hosted/use-hosted-agent-tiles").hostedRuntimeStatusView;
type Env = components["schemas"]["AgentResponse"];

let getTileStatus: HostedAgentTileStatus | null = null;
let getRuntimeStatusView: HostedRuntimeStatusView | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/use-hosted-agent-tiles");
	getTileStatus = module.hostedAgentTileStatus;
	getRuntimeStatusView = module.hostedRuntimeStatusView;
});

function hostedAgentTileStatus(rawStatus: string) {
	if (!getTileStatus) throw new Error("hostedAgentTileStatus was not loaded");
	return getTileStatus(rawStatus);
}

function hostedRuntimeStatusView(rawStatus: string, environment: Env | null | undefined) {
	if (!getRuntimeStatusView) throw new Error("hostedRuntimeStatusView was not loaded");
	return getRuntimeStatusView({ status: rawStatus }, environment);
}

function env(overrides: Partial<Env> = {}): Env {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		name: "hosted-codex",
		default_name: "hosted-codex",
		machine_name: "hosted-codex",
		agent_type: "codex",
		agent_version: null,
		os: "linux",
		last_seen_at: null,
		last_sync_at: new Date().toISOString(),
		last_sync_error: null,
		last_revision_seen: null,
		sort_order: 0,
		queue_depth_high_water: 0,
		dropped_count: 0,
		sync_enabled: true,
		explicit_identity: false,
		default_project_id: "22222222-2222-4222-8222-222222222222",
		...overrides,
	};
}

describe("hostedAgentTileStatus", () => {
	test("marks running and ready deployments active", () => {
		expect(hostedAgentTileStatus("running")).toEqual({ label: "Running", active: true });
		expect(hostedAgentTileStatus("ready")).toEqual({ label: "Ready", active: true });
	});

	test("keeps transitional and failed deployments inactive with readable labels", () => {
		expect(hostedAgentTileStatus("restarting")).toEqual({
			label: "Restarting",
			active: false,
		});
		expect(hostedAgentTileStatus("failed")).toEqual({ label: "Failed", active: false });
	});

	test("passes unknown deploy-api statuses through as readable labels", () => {
		expect(hostedAgentTileStatus("queued_for_drain")).toEqual({
			label: "Queued For Drain",
			active: false,
		});
	});
});

describe("hostedRuntimeStatusView", () => {
	test("keeps compute primary and sync paused secondary while running", () => {
		const view = hostedRuntimeStatusView(
			"running",
			env({ last_sync_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }),
		);

		expect(view.primary.label).toBe("Running");
		expect(view.active).toBe(true);
		expect(view.sync?.kind).toBe("paused");
		expect(view.secondary?.label).toBe("Sync paused");
	});

	test("suppresses reassuring live sync when compute is stopped", () => {
		const view = hostedRuntimeStatusView("stopped", env());

		expect(view.primary.label).toBe("Stopped");
		expect(view.active).toBe(false);
		expect(view.sync?.kind).toBe("live");
		expect(view.secondary).toBeNull();
	});

	test("counts a hosted runtime active when its joined environment is fresh", () => {
		const view = hostedRuntimeStatusView(
			"stopped",
			env({ last_seen_at: new Date().toISOString() }),
		);

		expect(view.primary.label).toBe("Stopped");
		expect(view.active).toBe(true);
		expect(view.secondary).toBeNull();
	});

	test("suppresses live sync when compute is running", () => {
		const view = hostedRuntimeStatusView("running", env());

		expect(view.primary.label).toBe("Running");
		expect(view.sync?.kind).toBe("live");
		expect(view.secondary).toBeNull();
	});

	test("shows pending sync only when running without a registered environment", () => {
		const running = hostedRuntimeStatusView("running", null);
		const provisioning = hostedRuntimeStatusView("provisioning", null);

		expect(running.secondary?.label).toBe("Sync pending");
		expect(provisioning.primary.label).toBe("Provisioning");
		expect(provisioning.secondary).toBeNull();
	});
});
