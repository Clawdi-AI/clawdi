import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { agentRouteTargetsHostedDeployment } from "@/hosted/agent-identity";

const source = readFileSync(new URL("./agent-home.tsx", import.meta.url), "utf8");

describe("hosted agent home composition", () => {
	test("mounts the existing delete action only in the settled unresolved-hosted branch", () => {
		const loadingBranch = source.indexOf("if (isLoading ||");
		const errorBranch = source.indexOf("if (error && requestedHostedAgent && !deployment)");
		const ambiguousBranch = source.indexOf("if (ambiguousMatches.length > 0)");
		const resolvedBranch = source.indexOf("if (deployment)");
		const unresolvedBranch = source.indexOf("if (requestedHostedAgent)");
		const connectedBranch = source.lastIndexOf("<ConnectedAgentDetail");
		const unresolvedComposition = source.slice(unresolvedBranch, connectedBranch);

		expect(loadingBranch).toBeLessThan(unresolvedBranch);
		expect(errorBranch).toBeLessThan(unresolvedBranch);
		expect(ambiguousBranch).toBeLessThan(unresolvedBranch);
		expect(resolvedBranch).toBeLessThan(unresolvedBranch);
		expect(unresolvedComposition).toContain("<HostedDeploymentDeleteAction");
		expect(unresolvedComposition).toContain("deploymentId={unresolvedHostedDeploymentId}");
		expect(unresolvedComposition).toContain("<Trash2 /> Delete");
		expect(source.slice(resolvedBranch, unresolvedBranch)).toContain("<HostedAgentDetail");
	});

	test("recovers a bare UUID route from the Cloud environment mapping after lookup settles", () => {
		const productionEnvironmentId = "54a92911-97ca-5ba8-a25c-f413d99176d3";
		expect(agentRouteTargetsHostedDeployment(productionEnvironmentId, null, null)).toBe(false);
		expect(source).toContain('"/v1/environments/{environment_id}"');
		expect(source).toContain("cloudEnvironment.data?.hosted_deployment_id?.trim()");
		expect(source).toContain("Boolean(cloudHostedDeploymentId)");
		expect(source).toContain("!cloudEnvironment.isLoading");
		expect(source).toContain("!cloudEnvironment.error");
		expect(source).toContain("deploymentSelector ??\n\t\t\tcloudHostedDeploymentId ??");
		expect(source).toContain("const unresolvedHostedDeploymentId = unresolvedHostedAgent");
	});
});
