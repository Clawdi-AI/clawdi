import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("agent Skills resource boundary", () => {
	test("renders managed Skills without MCP-derived UI", () => {
		const source = readFileSync(new URL("./agent-skills-tab.tsx", import.meta.url), "utf8");

		expect(source).toContain("managed_skills");
		expect(source).toContain("Deployment-managed Skills");
		expect(source).toContain("cleanupOnlySkillCheck");
		expect(source).not.toMatch(/managed_resources|mcp_server|MCP servers/i);
		expect(source).not.toMatch(/has_mcp|Deployment MCP/i);
	});
});
