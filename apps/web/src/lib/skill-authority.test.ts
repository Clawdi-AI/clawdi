import { describe, expect, test } from "bun:test";
import type { components } from "@clawdi/shared/api";
import { isBrowserWritableSkillProject, skillCapabilities } from "./skill-authority";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type Project = components["schemas"]["ProjectResponse"];

function skill(authority: SkillSummary["authority"] = "cloud") {
	return { authority, project_id: "project-1", project_kind: null };
}

function project(kind: string, isOwner = true) {
	return { kind, is_owner: isOwner } satisfies Pick<Project, "kind" | "is_owner">;
}

describe("skillCapabilities", () => {
	test("keeps agent-synced Skills read-only in every Project", () => {
		expect(skillCapabilities(skill("agent_sync"), project("workspace"))).toMatchObject({
			canUpdate: false,
			canDelete: false,
			canSend: false,
			canSelect: false,
			canSync: false,
			readOnlyReason: "agent-sync",
			badgeLabel: "Agent projection · Read-only",
		});
	});

	test("keeps legacy Cloud rows read-only by durable environment Project kind", () => {
		expect(skillCapabilities(skill("cloud"), project("environment"))).toMatchObject({
			canUpdate: false,
			readOnlyReason: "agent-project",
			badgeLabel: "Workspace · Read-only",
		});
	});

	test("does not restore writes when an orphan Agent Project loses its origin id", () => {
		const orphanProject = project("environment");
		expect(skillCapabilities(skill("cloud"), orphanProject).canDelete).toBe(false);
		expect(isBrowserWritableSkillProject(orphanProject)).toBe(false);
	});

	test("uses the persisted row's Project kind even when Project metadata is unavailable", () => {
		expect(
			skillCapabilities(
				{ authority: "cloud", project_id: "orphan", project_kind: "environment" },
				undefined,
			),
		).toMatchObject({ canUpdate: false, readOnlyReason: "agent-project" });
	});

	test("allows owned Cloud rows in workspace and personal Projects", () => {
		for (const kind of ["workspace", "personal"]) {
			expect(skillCapabilities(skill("cloud"), project(kind))).toMatchObject({
				canUpdate: true,
				canDelete: true,
				canSend: true,
				canSelect: true,
				canSync: true,
			});
		}
	});

	test("fails closed for shared or unresolved Projects", () => {
		expect(skillCapabilities(skill("cloud"), project("workspace", false)).readOnlyReason).toBe(
			"shared",
		);
		expect(skillCapabilities(skill("cloud"), undefined).readOnlyReason).toBe("unknown");
	});
});
