import { describe, expect, test } from "bun:test";
import { projectAgentLabel } from "@/components/projects/project-metadata";

describe("projectAgentLabel", () => {
	test("uses the canonical agent identity fallback", () => {
		expect(
			projectAgentLabel({
				id: "agent-1",
				name: "API Alias",
				default_name: "Research Agent",
				machine_name: "Shared Hosted Compute",
				agent_type: "codex",
			}),
		).toBe("Research Agent · Codex");
	});

	test("prefers display name across managed project chrome", () => {
		expect(
			projectAgentLabel({
				id: "agent-1",
				display_name: "Launch runner",
				default_name: "Research Agent",
				machine_name: "Shared Hosted Compute",
				agent_type: "codex",
			}),
		).toBe("Launch runner · Codex");
	});
});
