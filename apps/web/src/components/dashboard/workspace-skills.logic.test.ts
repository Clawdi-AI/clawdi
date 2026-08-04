import { describe, expect, test } from "bun:test";
import type { components } from "@/lib/api-schemas";
import {
	hostedSkillInstallOutcome,
	mergeWorkspaceRuntimeSkills,
	workspaceSkillInstallCommand,
	workspaceSkillRemoveCommand,
} from "./workspace-skills.logic";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

function projection(skillKey: string): SkillSummary {
	return {
		id: `cloud:${skillKey}`,
		skill_key: skillKey,
		name: skillKey,
		description: "Cloud projection",
		version: 2,
		source: "agent_sync",
		authority: "agent_sync",
		source_repo: null,
		agent_types: ["openclaw"],
		file_count: 1,
		content_hash: "hash",
		is_active: true,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		project_id: "workspace-project",
		project_kind: "environment",
	};
}

describe("Workspace Skill runtime authority", () => {
	test("uses runtime status for install and locked-removal controls", () => {
		const inventory = mergeWorkspaceRuntimeSkills(
			[projection("projected"), projection("available")],
			[
				{
					name: "projected",
					skill_key: "projected",
					always: false,
					bundled: false,
					disabled: false,
					blocked_by_allowlist: false,
					eligible: true,
					requirements: {},
					missing: {},
					config_checks: [],
				},
				{
					name: "runtime core",
					skill_key: "runtime-core",
					always: true,
					bundled: true,
					disabled: false,
					blocked_by_allowlist: false,
					eligible: true,
					requirements: {},
					missing: {},
					config_checks: [],
				},
			],
			[
				{
					skill_key: "available",
					name: "available",
					description: "Catalog Skill",
					emoji: "✨",
					category: "tools",
					featured: false,
					headline: "",
					languages: [],
					trust_level: "community",
					tags: [],
					status: "active",
					installable: true,
					connector_requirements: [],
				},
			],
		);

		expect(inventory.find((item) => item.entity.skill_key === "projected")).toMatchObject({
			installed: true,
			locked: false,
			installable: false,
			cloudProjection: { authority: "agent_sync" },
		});
		expect(inventory.find((item) => item.entity.skill_key === "available")).toMatchObject({
			installed: false,
			installable: true,
			cloudProjection: { authority: "agent_sync" },
		});
		const runtimeOnly = inventory.find((item) => item.entity.skill_key === "runtime-core");
		expect(runtimeOnly).toMatchObject({
			installed: true,
			locked: true,
			cloudProjection: null,
		});
		expect(runtimeOnly?.entity).toEqual({
			skill_key: "runtime-core",
			name: "runtime core",
			description: null,
			source: "Agent runtime",
			source_repo: null,
		});
		expect(runtimeOnly?.entity).not.toHaveProperty("authority");
		expect(runtimeOnly?.entity).not.toHaveProperty("id");
		expect(runtimeOnly?.entity).not.toHaveProperty("version");
		expect(runtimeOnly?.entity).not.toHaveProperty("updated_at");
	});

	test("builds only the real connected CLI handoff commands", () => {
		expect(workspaceSkillInstallCommand("owner/repo/skills/review", "codex")).toBe(
			"clawdi skill install owner/repo/skills/review --agent codex",
		);
		expect(workspaceSkillRemoveCommand("review-pr", "claude_code")).toBe(
			"clawdi skill rm review-pr --agent claude_code",
		);
	});

	test("keeps status-backed Skills when discovery metadata is unavailable", () => {
		const inventory = mergeWorkspaceRuntimeSkills(
			[],
			[
				{
					name: "installed",
					skill_key: "installed",
					always: false,
					bundled: false,
					disabled: false,
					blocked_by_allowlist: false,
					eligible: true,
					requirements: {},
					missing: {},
					config_checks: [],
				},
			],
			[],
		);

		expect(inventory).toHaveLength(1);
		expect(inventory[0]).toMatchObject({ installed: true, installable: false });
	});

	test("treats gateway detection timeout as pending runtime truth", () => {
		expect(hostedSkillInstallOutcome({ ok: false, status: "pending" })).toBe("pending");
		expect(hostedSkillInstallOutcome({ ok: true, status: "installed" })).toBe("installed");
		expect(hostedSkillInstallOutcome({ ok: false, status: "failed" })).toBe("failed");
	});
});
