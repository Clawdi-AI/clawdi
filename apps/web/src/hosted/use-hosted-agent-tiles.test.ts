import { beforeAll, describe, expect, test } from "bun:test";

type HostedAgentTileStatus = typeof import("@/hosted/use-hosted-agent-tiles").hostedAgentTileStatus;

let getTileStatus: HostedAgentTileStatus | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	getTileStatus = (await import("@/hosted/use-hosted-agent-tiles")).hostedAgentTileStatus;
});

function hostedAgentTileStatus(rawStatus: string) {
	if (!getTileStatus) throw new Error("hostedAgentTileStatus was not loaded");
	return getTileStatus(rawStatus);
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
