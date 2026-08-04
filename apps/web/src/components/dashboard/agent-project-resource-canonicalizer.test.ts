import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveAgentProjectResourceContext } from "./agent-project-resource-context";

describe("legacy Agent Project-resource collections", () => {
	test("require one explicit bound Project and never choose the primary by default", () => {
		const bindings = [{ project_id: "primary" }, { project_id: "context" }];
		expect(resolveAgentProjectResourceContext(bindings, null)).toBeNull();
		expect(resolveAgentProjectResourceContext(bindings, "")).toBeNull();
		expect(resolveAgentProjectResourceContext(bindings, "unbound")).toBeNull();
		expect(resolveAgentProjectResourceContext(bindings, " context ")).toBe("context");
	});

	test("keeps compatibility redirects behind the fail-closed Agent identity gate", () => {
		const source = readFileSync(
			new URL("./agent-project-resource-canonicalizer.tsx", import.meta.url),
			"utf8",
		);
		expect(source).toContain("<AgentResourceRouteGate");
		expect(source).toContain("enabled: Boolean(requestedProjectId)");
		expect(source).toContain("agentDeploymentRouteQuery(routeSearch)");
		expect(source).not.toContain('binding_type === "primary"');
	});
});
