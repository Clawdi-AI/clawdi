import { describe, expect, test } from "bun:test";
import type { components } from "@/lib/api-schemas";
import {
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
	test("keeps manifest desired state authoritative and agent_sync projections read-only", () => {
		const inventory = mergeWorkspaceRuntimeSkills(
			[projection("projected")],
			[
				{
					skill_key: "manifest-owned",
					source: {
						type: "github",
						url: "https://github.com/Clawdi-AI/store",
						path: "skills/manifest-owned",
						commit: "a".repeat(40),
					},
					reconciliation_status: "reconciling",
					failure_message: null,
				},
				{
					skill_key: "failed",
					source: {
						type: "github",
						url: "https://github.com/Clawdi-AI/store",
						path: "skills/failed",
						commit: "b".repeat(40),
					},
					reconciliation_status: "failed",
					failure_message: "Retry pending.",
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
				{
					skill_key: "projected",
					name: "projected",
					description: "Catalog collision",
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
			desired: null,
			installable: false,
			cloudProjection: { authority: "agent_sync" },
		});
		expect(inventory.find((item) => item.entity.skill_key === "available")).toMatchObject({
			desired: null,
			installable: true,
			cloudProjection: null,
		});
		const manifestOwned = inventory.find((item) => item.entity.skill_key === "manifest-owned");
		expect(manifestOwned).toMatchObject({
			desired: { reconciliation_status: "reconciling" },
			installable: false,
			cloudProjection: null,
		});
		expect(manifestOwned?.entity).toEqual({
			skill_key: "manifest-owned",
			name: "manifest-owned",
			description: null,
			source: "Runtime Workspace",
			source_repo: "https://github.com/Clawdi-AI/store",
		});
		expect(inventory.find((item) => item.entity.skill_key === "failed")?.desired).toMatchObject({
			reconciliation_status: "failed",
			failure_message: "Retry pending.",
		});
	});

	test("builds only the real connected CLI handoff commands", () => {
		expect(workspaceSkillInstallCommand("owner/repo/skills/review", "codex")).toBe(
			"clawdi skill install owner/repo/skills/review --agent codex",
		);
		expect(workspaceSkillRemoveCommand("review-pr", "claude_code")).toBe(
			"clawdi skill rm review-pr --agent claude_code",
		);
	});

	test("keeps desired Skills when discovery metadata is unavailable", () => {
		const inventory = mergeWorkspaceRuntimeSkills(
			[],
			[
				{
					skill_key: "desired",
					source: {
						type: "github",
						url: "https://github.com/Clawdi-AI/store",
						path: "skills/desired",
						commit: "c".repeat(40),
					},
					reconciliation_status: "reconciling",
				},
			],
			[],
		);

		expect(inventory).toHaveLength(1);
		expect(inventory[0]).toMatchObject({
			desired: { reconciliation_status: "reconciling" },
			installable: false,
		});
	});
});
