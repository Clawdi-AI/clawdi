import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cliRoot = resolve(import.meta.dir, "../..");
const genericSkill = readFileSync(resolve(cliRoot, "skills/clawdi/SKILL.md"), "utf-8");
const hostedSkill = readFileSync(resolve(cliRoot, "skills/hosted/clawdi/SKILL.md"), "utf-8");

function section(content: string, heading: string): string {
	const marker = `## ${heading}`;
	const start = content.indexOf(marker);
	if (start === -1) throw new Error(`missing ${marker}`);
	const bodyStart = start + marker.length;
	const nextHeading = content.indexOf("\n## ", bodyStart);
	return content.slice(start, nextHeading === -1 ? content.length : nextHeading).trim();
}

describe("bundled Clawdi skill connector contract", () => {
	const genericConnectors = section(genericSkill, "Connectors");
	const hostedConnectors = section(hostedSkill, "Connectors");

	it("keeps the generic and hosted connector workflows aligned", () => {
		expect(hostedConnectors).toBe(genericConnectors);
	});

	it("uses Composio meta-tools with schema-driven discovery and execution", () => {
		for (const connectors of [genericConnectors, hostedConnectors]) {
			expect(connectors).toContain("Start every external-app task with `COMPOSIO_SEARCH_TOOLS`");
			expect(connectors).toContain("`COMPOSIO_GET_TOOL_SCHEMAS`");
			expect(connectors).toContain("Never invent tool slugs, field names, or inputs");
			expect(connectors).toContain("`COMPOSIO_MULTI_EXECUTE_TOOL`");
			expect(connectors).not.toMatch(
				/dynamically registered|individual tools|already authenticated/i,
			);
		}
	});

	it("documents a schema-driven auth-link handshake", () => {
		for (const connectors of [genericConnectors, hostedConnectors]) {
			expect(connectors).toContain("`COMPOSIO_MANAGE_CONNECTIONS`");
			expect(connectors).toContain("returned `redirect_url` as a clickable Markdown");
			expect(connectors).toContain("authentication is pending");
			expect(connectors).toContain("do not claim it is complete");
			expect(connectors).toContain("connection wait or status operation when");
			expect(connectors).toContain("otherwise stop");
			expect(connectors).toContain("`COMPOSIO_SEARCH_TOOLS`");
			expect(connectors).toMatch(/connection is\s+active, and retry the interrupted workflow/);
			expect(connectors).toContain("never ask for or copy OAuth credentials, API keys, or tokens");
			expect(connectors).not.toMatch(/dashboard/i);
		}
	});

	it("keeps result handling and confirmation conditional on the exposed contract", () => {
		for (const connectors of [genericConnectors, hostedConnectors]) {
			expect(connectors).toContain("`COMPOSIO_REMOTE_BASH_TOOL`");
			expect(connectors).toContain("`COMPOSIO_REMOTE_WORKBENCH`");
			expect(connectors).toContain("signed file URLs");
			expect(connectors).toContain("pagination fields and termination signals");
			expect(connectors).toContain("multiple accounts only when");
			expect(connectors).toContain("user's exact instruction already authorizes that exact action");
			expect(connectors).toContain("Do not ask for redundant");
		}
	});

	it("keeps hosted-only guidance free of local Clawdi capabilities", () => {
		expect(hostedSkill).not.toMatch(/\bMemory\b|memory_(?:search|add|extract)/i);
		expect(hostedSkill).not.toMatch(
			/\bVault\b|\bAI Provider\b|\bCLI\b|\bconfig(?:uration)?\b|\bsetup\b/i,
		);
		expect(hostedSkill).not.toMatch(/dashboard/i);
		expect(genericSkill).toContain("## Memory");
		expect(genericSkill).toContain("## Vault CLI");
		expect(genericSkill).toContain("## AI Provider CLI");
	});
});
