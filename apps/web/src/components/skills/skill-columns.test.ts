import { describe, expect, it } from "bun:test";
import type { components } from "@clawdi/shared/api";
import { resolveSkillProjectAccess } from "./skill-columns";

type Project = components["schemas"]["ProjectResponse"];

function project(kind: string, isOwner = true) {
	return { kind, is_owner: isOwner } satisfies Pick<Project, "kind" | "is_owner">;
}

describe("resolveSkillProjectAccess", () => {
	it("fails closed before Project metadata loads", () => {
		expect(
			resolveSkillProjectAccess({
				authority: "cloud",
				project_id: "project-current",
				project_kind: null,
			}),
		).toBe("unknown");
	});

	it("keeps legacy rows in orphan environment Projects read-only", () => {
		expect(
			resolveSkillProjectAccess(
				{ authority: "cloud", project_id: "project-orphan", project_kind: "environment" },
				{
					projectsById: new Map([["project-orphan", project("environment")]]),
				},
			),
		).toBe("read-only");
	});

	it("keeps agent-synced rows read-only", () => {
		expect(
			resolveSkillProjectAccess(
				{ authority: "agent_sync", project_id: "project-current", project_kind: "workspace" },
				{
					projectsById: new Map([["project-current", project("workspace")]]),
				},
			),
		).toBe("read-only");
	});

	it("allows only owned Cloud Project rows", () => {
		expect(
			resolveSkillProjectAccess(
				{ authority: "cloud", project_id: "project-current", project_kind: "workspace" },
				{
					projectsById: new Map([["project-current", project("workspace")]]),
				},
			),
		).toBe("writable");
	});
});
