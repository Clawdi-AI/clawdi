import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deploymentManagedMcpValue } from "./use-agent-runtime-observed";

describe("deployment-managed MCP inventory", () => {
	test("reports the manifest-managed state when it is known", () => {
		expect(deploymentManagedMcpValue({ has_mcp: true }, false)).toBe("Managed");
		expect(deploymentManagedMcpValue({ has_mcp: false }, false)).toBe("Not managed");
	});

	test("does not turn mixed-version or failed reads into an empty inventory", () => {
		expect(deploymentManagedMcpValue({}, false)).toBe("—");
		expect(deploymentManagedMcpValue(undefined, false)).toBe("—");
		expect(deploymentManagedMcpValue({ has_mcp: false }, true)).toBe("—");
	});

	test("renders the summary only in the existing Hosted Overview inventory", () => {
		const overview = readFileSync(
			new URL("../hosted/agents/hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		expect(overview).toContain('label="Deployment MCP"');
		expect(overview).toContain("deploymentManagedMcpValue(");
		expect(overview).toContain("!projectionAvailable || runtimeObserved.isLoading");
		expect(overview).not.toMatch(/mcp_server|managed_resources|desired_config_generation/);
	});
});
