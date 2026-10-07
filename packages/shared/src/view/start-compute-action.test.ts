import { describe, expect, test } from "bun:test";
import { hostedDeploymentFixture } from "./hosted-deployment.test-fixture";
import { startComputeActionPresentation } from "./start-compute-action";

describe("startComputeActionPresentation", () => {
	test("never offers payment while the subscription is updating or start is unavailable", () => {
		for (const [startAction, label] of [
			[null, "Updating subscription"],
			["wait", "Updating subscription"],
			["unavailable", "Start unavailable"],
		] as const) {
			expect(
				startComputeActionPresentation(hostedDeploymentFixture({ status: "stopped", startAction })),
			).toEqual({ target: null, label, enabled: false });
		}
	});

	test("billing recovery is enabled only when the lifecycle can start", () => {
		expect(
			startComputeActionPresentation(
				hostedDeploymentFixture({ status: "stopped", startAction: "fix_payment" }),
			),
		).toEqual({ target: "fix_payment", label: "Pay to start", enabled: true });
		expect(
			startComputeActionPresentation(
				hostedDeploymentFixture({ status: "stopping", startAction: "top_up" }),
			).enabled,
		).toBe(false);
	});
});
