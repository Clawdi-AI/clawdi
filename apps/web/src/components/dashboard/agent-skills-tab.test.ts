import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENT_SECTION_NAVIGATION_ITEMS, agentNavigationGroups } from "@/lib/navigation-model";

describe("agent Skills resource boundary", () => {
	test("keeps the retired aggregate implementation read-only while Project hubs own management", () => {
		const source = readFileSync(new URL("./agent-skills-tab.tsx", import.meta.url), "utf8");

		expect(source).toContain("resolveAgentProjectScope");
		expect(source).toContain("fetchAgentProjectSkills");
		expect(source).toContain("sourceLabelFor");
		expect(source).not.toContain("cleanupOnly");
		expect(source).not.toMatch(/api\.DELETE|useMutation|AgentSkillAddDialog/);
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

	test("keeps Skills and Vaults out of the top-level sidebar while retaining legacy route metadata", () => {
		const connectedItems = agentNavigationGroups("connected").flatMap((group) => group.items);
		const hostedItems = agentNavigationGroups("hosted").flatMap((group) => group.items);

		expect(connectedItems).not.toContain(AGENT_SECTION_NAVIGATION_ITEMS.skills);
		expect(connectedItems).not.toContain(AGENT_SECTION_NAVIGATION_ITEMS.vaults);
		expect(hostedItems).not.toContain(AGENT_SECTION_NAVIGATION_ITEMS.skills);
		expect(hostedItems).not.toContain(AGENT_SECTION_NAVIGATION_ITEMS.vaults);
		expect(AGENT_SECTION_NAVIGATION_ITEMS.skills.description).toBe(
			"Legacy link — choose a Project to manage its Skills.",
		);
		expect(AGENT_SECTION_NAVIGATION_ITEMS.vaults.description).toBe(
			"Legacy link — choose a Project to manage attached Vaults.",
		);
	});
});
