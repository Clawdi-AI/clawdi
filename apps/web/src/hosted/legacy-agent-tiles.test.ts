import { afterEach, describe, expect, it } from "bun:test";
import type { components } from "@clawdi/shared/api";
import { legacyConnectedAgentTiles } from "@/hosted/legacy-agent-tiles";

type Env = components["schemas"]["AgentResponse"];
const originalWindow = (globalThis as unknown as Record<string, unknown>).window;

function setBrowserHostname(hostname: string) {
	Object.defineProperty(globalThis, "window", {
		value: { location: { hostname } },
		configurable: true,
	});
}

afterEach(() => {
	if (originalWindow === undefined) {
		Reflect.deleteProperty(globalThis, "window");
		return;
	}
	Object.defineProperty(globalThis, "window", {
		value: originalWindow,
		configurable: true,
	});
});

function env(overrides: Partial<Env> = {}): Env {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		name: "workstation",
		default_name: "workstation",
		machine_name: "workstation",
		agent_type: "openclaw",
		agent_version: null,
		os: "linux",
		display_name: null,
		avatar_url: null,
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

describe("legacyConnectedAgentTiles", () => {
	it("carries the legacy dashboard href when the URL is available", () => {
		setBrowserHostname("localhost");
		const legacy = env({
			id: "33333333-3333-4333-8333-333333333333",
		});

		const [tile] = legacyConnectedAgentTiles([legacy], new Set([legacy.id]));
		expect(tile.manageHref).toBe("http://localhost:3000/dashboard");
	});
});
