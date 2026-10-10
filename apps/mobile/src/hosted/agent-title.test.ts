import { expect, test } from "bun:test";
import { hostedAgentTitle } from "@/hosted/agent-title";
import { hostedDeploymentFixture } from "../../../../packages/shared/src/view/hosted-deployment.test-fixture";

test("the Agent's own name wins over the deployment's default name", () => {
	const deployment = hostedDeploymentFixture({ runtime: "openclaw" });
	deployment.resource.name = "openclaw-default-7f3a";
	expect(
		hostedAgentTitle({ display_name: "Smoke QA Agent", agent_type: "openclaw" }, deployment),
	).toBe("Smoke QA Agent");
	expect(hostedAgentTitle(undefined, deployment)).toBe("openclaw-default-7f3a");
	expect(hostedAgentTitle(undefined, undefined)).toBeNull();
});
