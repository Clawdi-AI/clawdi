import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("agent Skills resource boundary", () => {
	test("keeps persisted Agent Project rows read-only without cleanup mutations", () => {
		const source = readFileSync(new URL("./agent-skills-tab.tsx", import.meta.url), "utf8");

		expect(source).toContain('kind: "environment"');
		expect(source).toContain("conflictSkillCheck");
		expect(source).toContain("If the local Skill is still user-owned");
		expect(source).toContain("projection cleanup will converge automatically");
		expect(source).not.toContain("cleanupOnly");
		expect(source).not.toMatch(/api\.DELETE|useMutation/);
		expect(source).toContain("AGENT_PROJECT_SKILLS_REFRESH_POLICY");
		expect(source).toContain("No empty filesystem inventory is being inferred");
		expect(source).not.toMatch(/managed_resources|mcp_server|MCP servers/i);
		expect(source).not.toMatch(/has_mcp|Deployment MCP/i);
	});
});
