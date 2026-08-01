import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENT_SECTION_NAVIGATION_ITEMS, agentNavigationGroups } from "@/lib/navigation-model";

describe("agent Skills resource boundary", () => {
	test("keeps persisted Agent Project rows read-only without cleanup mutations", () => {
		const source = readFileSync(new URL("./agent-skills-tab.tsx", import.meta.url), "utf8");
		const normalizedSource = source.replace(/\s+/g, " ");

		expect(source).toContain('kind: "environment"');
		expect(normalizedSource).toContain("No empty filesystem inventory is being inferred");
		expect(source).not.toContain("cleanupOnly");
		expect(source).not.toMatch(/api\.DELETE|useMutation/);
		expect(source).toContain("AGENT_PROJECT_SKILLS_REFRESH_POLICY");
		expect(source).not.toMatch(/manifest|reservedSkill|leadingCards/i);
		expect(source).not.toMatch(/managed_resources|mcp_server|MCP servers/i);
		expect(source).not.toMatch(/has_mcp|Deployment MCP/i);
	});

	test("describes both Agent Skill surfaces as filesystem projections", () => {
		const connectedSkills = agentNavigationGroups("connected").flatMap((group) => group.items);
		const hostedSkills = agentNavigationGroups("hosted").flatMap((group) => group.items);

		expect(connectedSkills).toContain(AGENT_SECTION_NAVIGATION_ITEMS.skills);
		expect(hostedSkills).toContain(AGENT_SECTION_NAVIGATION_ITEMS.skills);
		expect(AGENT_SECTION_NAVIGATION_ITEMS.skills.description).toBe(
			"Skills synced from this agent's filesystem.",
		);
		expect(AGENT_SECTION_NAVIGATION_ITEMS.skills.description).not.toContain(
			"Manifest configuration",
		);
	});
});
