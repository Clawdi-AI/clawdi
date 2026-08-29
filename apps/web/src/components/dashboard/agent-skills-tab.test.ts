import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENT_SECTION_NAVIGATION_ITEMS, agentNavigationGroups } from "@/lib/navigation-model";

describe("agent Skills resource boundary", () => {
	test("keeps effective Project rows scoped with ownership-aware resource actions", () => {
		const source = readFileSync(new URL("./agent-skills-tab.tsx", import.meta.url), "utf8");

		expect(source).toContain("resolveAgentProjectScope");
		expect(source).toContain("fetchAgentProjectSkills");
		expect(source).toContain("sourceLabelFor");
		expect(source).not.toContain("cleanupOnly");
		expect(source).toContain('api.DELETE("/v1/projects/{project_id}/skills/{skill_key}"');
		expect(source).toContain("capabilitiesFor");
		expect(source).toContain("onUninstall");
		expect(source).toContain("AGENT_PROJECT_SKILLS_REFRESH_POLICY");
		expect(source).not.toMatch(/manifest|reservedSkill|leadingCards/i);
		expect(source).not.toMatch(/managed_resources|mcp_server|MCP servers/i);
		expect(source).not.toMatch(/has_mcp|Deployment MCP/i);
		expect(source).not.toMatch(/runtime-observed|managed_skills/i);
		expect(source).not.toContain("user-visible");
		expect(source).not.toContain("Skills appear here through");
		expect(source).toContain('emptyMessage="No Skills yet."');
		expect(source).not.toContain("No Skills are available through");
	});

	test("keeps Skill metadata for Project hubs without restoring flat navigation", () => {
		const connectedSkills = agentNavigationGroups("connected").flatMap((group) => group.items);
		const hostedSkills = agentNavigationGroups("hosted").flatMap((group) => group.items);

		expect(connectedSkills).not.toContain(AGENT_SECTION_NAVIGATION_ITEMS.skills);
		expect(hostedSkills).not.toContain(AGENT_SECTION_NAVIGATION_ITEMS.skills);
		expect(AGENT_SECTION_NAVIGATION_ITEMS.skills.description).toBe(
			"Skills installed in this Agent's Workspace.",
		);
		expect(AGENT_SECTION_NAVIGATION_ITEMS.skills.description).not.toContain(
			"Manifest configuration",
		);
	});
});
