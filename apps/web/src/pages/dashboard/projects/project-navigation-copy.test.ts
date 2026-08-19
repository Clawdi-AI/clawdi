import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { agentSectionLabel } from "@/lib/agent-routes";

const projectDetailSource = readFileSync(new URL("./[id]/page.tsx", import.meta.url), "utf8");

describe("Project navigation instructions", () => {
	test("derive every agent Projects reference from the canonical navigation label", () => {
		expect(agentSectionLabel("projects")).toBe("Projects");
		expect(projectDetailSource).toContain(
			'const AGENT_PROJECTS_SECTION_LABEL = agentSectionLabel("projects");',
		);
		expect(projectDetailSource.match(/\{AGENT_PROJECTS_SECTION_LABEL\}/g)).toHaveLength(1);
		expect(projectDetailSource).not.toContain("Project Access section");
	});
});
