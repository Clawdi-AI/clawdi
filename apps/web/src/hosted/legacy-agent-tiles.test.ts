import { describe, expect, it } from "bun:test";
import type { components } from "@clawdi/shared/api";
import { legacyConnectedAgentTiles } from "@/hosted/legacy-agent-tiles";

type Env = components["schemas"]["EnvironmentResponse"];

function env(overrides: Partial<Env> = {}): Env {
	return {
		id: "11111111-1111-4111-8111-111111111111",
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
		hosted_managed: false,
		default_project_id: "22222222-2222-4222-8222-222222222222",
		...overrides,
	};
}

describe("legacyConnectedAgentTiles", () => {
	it("projects legacy hosted environments as legacy-badged connected agent tiles", () => {
		const hostedManaged = env({
			id: "33333333-3333-4333-8333-333333333333",
			machine_name: "v1-hosted-runtime",
			hosted_managed: true,
			hosted_deployment_id: "hdep_test",
		});

		expect(legacyConnectedAgentTiles([env(), hostedManaged])).toEqual([
			expect.objectContaining({
				id: hostedManaged.id,
				source: "legacy-hosted",
				name: "v1-hosted-runtime",
				runtimeLabel: "OpenClaw",
				href: `/agents/${hostedManaged.id}`,
			}),
		]);
	});

	it("omits env so the tile never renders self-managed daemon remediation", () => {
		const hostedManaged = env({
			id: "33333333-3333-4333-8333-333333333333",
			hosted_managed: true,
		});

		const [tile] = legacyConnectedAgentTiles([hostedManaged]);
		expect(tile.env).toBeUndefined();
	});

	it("excludes environments already claimed by a Cloud deploy-API tile", () => {
		const claimed = env({
			id: "44444444-4444-4444-8444-444444444444",
			machine_name: "v2-cloud-runtime",
			hosted_managed: true,
		});
		const legacyOnly = env({
			id: "55555555-5555-4555-8555-555555555555",
			machine_name: "v1-hosted-runtime",
			hosted_managed: true,
		});

		const tiles = legacyConnectedAgentTiles(
			[claimed, legacyOnly],
			// claimedEnvIds is lower-cased at insertion in useHostedAgentTiles;
			// mixed-case env ids on the cloud-api side must still match.
			new Set([claimed.id.toLowerCase()]),
		);
		expect(tiles.map((t) => t.id)).toEqual([legacyOnly.id]);
	});
});
