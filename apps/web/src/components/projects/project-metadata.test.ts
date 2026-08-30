import { describe, expect, test } from "bun:test";
import {
	projectAgentLabel,
	projectMatchesSearch,
	projectSearchRank,
	projectSearchSupportingText,
} from "@/components/projects/project-metadata";

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
		).toBe("Research Agent");
	});

	test("prefers the display name across Project surfaces", () => {
		expect(
			projectAgentLabel({
				id: "agent-1",
				display_name: "Launch runner",
				default_name: "Research Agent",
				machine_name: "Shared Hosted Compute",
				agent_type: "codex",
			}),
		).toBe("Launch runner");
	});
});

describe("Project search projection", () => {
	const project = {
		name: "Launch control",
		slug: "launch-control",
		description: "Coordinates the production rollout across services.",
		is_owner: false,
		owner_display: "Ada Lovelace",
		owner_handle: "ada-lovelace-a1b2",
	};

	test("matches every visible Project identity field", () => {
		for (const query of [
			"launch control",
			"launch-control",
			"production rollout",
			"ada lovelace",
			"a1b2",
		]) {
			expect(projectMatchesSearch(project, query)).toBe(true);
		}
		expect(projectMatchesSearch(project, "unrelated")).toBe(false);
	});

	test("explains matches that are not visible in the title", () => {
		expect(projectSearchSupportingText(project, "production rollout")).toContain(
			"production rollout",
		);
		expect(projectSearchSupportingText(project, "launch-control")).toBe("Slug: launch-control");
		expect(projectSearchSupportingText(project, "a1b2")).toBe("Shared by ada-lovelace-a1b2");
	});

	test("orders strong identity matches before supporting metadata", () => {
		expect(projectSearchRank(project, "launch control")).toBe(0);
		expect(projectSearchRank(project, "launch-")).toBe(3);
		expect(projectSearchRank(project, "production rollout")).toBe(6);
		expect(projectSearchRank(project, "a1b2")).toBe(7);
	});

	test("matches terms across fields and explains the supporting match", () => {
		expect(projectMatchesSearch(project, "launch production")).toBe(true);
		expect(projectSearchSupportingText(project, "launch production")).toContain("production");
		expect(projectMatchesSearch(project, "launch missing")).toBe(false);
	});
});
