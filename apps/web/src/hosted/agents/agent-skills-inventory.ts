import type { components, DeployComponents } from "@clawdi/shared/api";
import {
	mergeWorkspaceRuntimeSkills,
	type WorkspaceRuntimeSkill,
} from "@/components/dashboard/workspace-skills.logic";

type ManagedSkill = components["schemas"]["AgentSkillDesiredResponse"];
type Projection = components["schemas"]["SkillSummaryResponse"];
type HostedDesired = DeployComponents["schemas"]["V2WorkspaceSkillDesiredItem"];

export type AgentSkillInventoryItem = WorkspaceRuntimeSkill & { managed: ManagedSkill | null };

export function agentSkillInventory(
	managed: readonly ManagedSkill[],
	projections: readonly Projection[],
	hosted: readonly HostedDesired[],
): AgentSkillInventoryItem[] {
	const rows = new Map<string, AgentSkillInventoryItem>(
		mergeWorkspaceRuntimeSkills(projections, hosted).map((row) => [
			row.entity.skill_key,
			{ ...row, managed: null },
		]),
	);
	for (const skill of managed) {
		const existing = rows.get(skill.skill_key);
		rows.set(skill.skill_key, {
			entity: {
				...existing?.entity,
				skill_key: skill.skill_key,
				name: skill.name,
				description: skill.description ?? null,
			},
			cloudProjection: existing?.cloudProjection ?? null,
			desired: existing?.desired ?? null,
			projectionOnly: false,
			managed: skill,
		});
	}
	return [...rows.values()].sort((left, right) =>
		left.entity.name.localeCompare(right.entity.name),
	);
}
