import { describe, expect, test } from "bun:test";
import type { components } from "@/lib/api-schemas";
import {
	mergeWorkspaceRuntimeSkills,
	parseWorkspaceSkillGitHubInput,
	workspaceSkillInstallCommand,
	workspaceSkillMutationsAvailable,
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
	test("fails closed unless the read capability is explicitly available", () => {
		const status = {
			deployment_id: "dep_test",
			deployment_resource_version: "rv_test",
			manifest_generation: 1,
			capability: { available: true, reason: "available" as const },
		};
		expect(workspaceSkillMutationsAvailable(status, null)).toBe(true);
		expect(
			workspaceSkillMutationsAvailable(
				{ ...status, capability: { available: false, reason: "rollout_not_enabled" } },
				null,
			),
		).toBe(false);
		expect(workspaceSkillMutationsAvailable(status, new Error("status unavailable"))).toBe(false);
		expect(workspaceSkillMutationsAvailable({ ...status, capability: undefined }, null)).toBe(
			false,
		);
		expect(workspaceSkillMutationsAvailable(undefined, null)).toBe(false);
	});

	test("keeps Workspace desired state authoritative and only projection-only Skills read-only", () => {
		const inventory = mergeWorkspaceRuntimeSkills(
			[projection("projected"), projection("manifest-owned")],
			[
				{
					skill_key: "manifest-owned",
					source: {
						type: "github",
						url: "https://github.com/example/skills",
						path: "skills/manifest-owned",
						commit: "a".repeat(40),
					},
					status: "managed",
					failure_message: null,
				},
				{
					skill_key: "failed",
					source: {
						type: "github",
						url: "https://github.com/example/skills",
						path: "skills/failed",
						commit: "b".repeat(40),
					},
					status: "failed",
					failure_message: "Retry pending.",
				},
			],
		);

		expect(inventory.find((item) => item.entity.skill_key === "projected")).toMatchObject({
			desired: null,
			cloudProjection: { authority: "agent_sync" },
			projectionOnly: true,
		});
		const manifestOwned = inventory.find((item) => item.entity.skill_key === "manifest-owned");
		expect(manifestOwned).toMatchObject({
			desired: { status: "managed" },
			cloudProjection: { authority: "agent_sync" },
			projectionOnly: false,
		});
		expect(manifestOwned?.entity).toMatchObject({
			skill_key: "manifest-owned",
			name: "manifest-owned",
			description: "Cloud projection",
			source: "Agent Workspace",
			source_repo: "example/skills/skills/manifest-owned",
		});
		expect(inventory.find((item) => item.entity.skill_key === "failed")?.desired).toMatchObject({
			status: "failed",
			failure_message: "Retry pending.",
		});
	});

	test("parses the GitHub repository input used by the install dialog", () => {
		expect(parseWorkspaceSkillGitHubInput("owner/repo/path/to-skill")).toEqual({
			repo: "owner/repo",
			path: "path/to-skill",
		});
		expect(parseWorkspaceSkillGitHubInput("https://github.com/owner/repo/")).toEqual({
			repo: "owner/repo",
			path: undefined,
		});
		expect(parseWorkspaceSkillGitHubInput("  owner/repo/path with spaces/@team:skill/  ")).toEqual({
			repo: "owner/repo",
			path: "path with spaces/@team:skill",
		});
		expect(() => parseWorkspaceSkillGitHubInput("missing-repo")).toThrow("owner/repo");
		expect(() => parseWorkspaceSkillGitHubInput("https://gitlab.com/owner/repo")).toThrow(
			"github.com",
		);
		expect(() => parseWorkspaceSkillGitHubInput("https://github.com/owner/repo?q=1")).toThrow(
			"canonical",
		);
		expect(() => parseWorkspaceSkillGitHubInput("https://user@github.com/owner/repo")).toThrow(
			"canonical",
		);
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
						url: "https://github.com/example/skills",
						path: "skills/desired",
						commit: "c".repeat(40),
					},
					status: "requested",
				},
			],
		);

		expect(inventory).toHaveLength(1);
		expect(inventory[0]).toMatchObject({
			desired: { status: "requested" },
		});
	});
});
