import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./agent-home.tsx", import.meta.url), "utf8");

describe("hosted agent home composition", () => {
	test("mounts the existing delete action only in the settled unresolved-hosted branch", () => {
		const loadingBranch = source.indexOf("if (isLoading)");
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

	test("derives the orphan delete target from existing route identity only after lookup settles", () => {
		expect(source).toContain(
			"requestedHostedAgent && !deployment && ambiguousMatches.length === 0 && !error && !isLoading",
		);
		expect(source).toContain(
			"deploymentSelector ?? (!isCloudEnvironmentId ? environmentId : null)",
		);
		expect(source).toContain("const unresolvedHostedDeploymentId = unresolvedHostedAgent");
	});
});
