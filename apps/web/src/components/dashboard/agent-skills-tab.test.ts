import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("agent Skills resource boundary", () => {
	test("keeps persisted Agent Project rows read-only without cleanup mutations", () => {
		const source = readFileSync(new URL("./agent-skills-tab.tsx", import.meta.url), "utf8");
		const normalizedSource = source.replace(/\s+/g, " ");

		expect(source).toContain('kind: "environment"');
		expect(source).toContain("conflictSkillCheck");
		expect(normalizedSource).toContain("If the local Skill is still user-owned");
		expect(normalizedSource).toContain("projection cleanup will converge automatically");
		expect(source).not.toContain("cleanupOnly");
		expect(source).not.toMatch(/api\.DELETE|useMutation/);
		expect(source).toContain("AGENT_PROJECT_SKILLS_REFRESH_POLICY");
		expect(source).toContain("No empty filesystem inventory is being inferred");
		expect(source).not.toMatch(/managed_resources|mcp_server|MCP servers/i);
		expect(source).not.toMatch(/has_mcp|Deployment MCP/i);
	});

	test("keeps Connected and Hosted sidebar Skill ownership copy distinct", () => {
		const sidebar = readFileSync(new URL("../app-sidebar.tsx", import.meta.url), "utf8");
		const hostedStart = sidebar.indexOf("const HOSTED_AGENT_SECTIONS");
		expect(hostedStart).toBeGreaterThan(-1);
		const connected = sidebar.slice(0, hostedStart);
		const hosted = sidebar.slice(hostedStart);

		expect(connected).toContain("Skills synced from this Agent filesystem");
		expect(connected).not.toContain("Manifest configuration");
		expect(hosted).toContain("Manifest configuration and Agent filesystem Skills");
	});
});
