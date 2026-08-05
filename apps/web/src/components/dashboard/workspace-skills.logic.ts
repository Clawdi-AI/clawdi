import type { DeployComponents } from "@clawdi/shared/api";
import type { SkillCardEntity } from "@/components/skills/skill-card";
import type { components } from "@/lib/api-schemas";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type HostedSkillCatalogItem = DeployComponents["schemas"]["V1SkillCatalogItem"];
type HostedWorkspaceSkillDesiredItem = DeployComponents["schemas"]["V2WorkspaceSkillDesiredItem"];

export type WorkspaceRuntimeSkill = {
	entity: SkillCardEntity;
	cloudProjection: SkillSummary | null;
	desired: HostedWorkspaceSkillDesiredItem | null;
	installable: boolean;
};

export function mergeWorkspaceRuntimeSkills(
	projections: readonly SkillSummary[],
	desiredItems: readonly HostedWorkspaceSkillDesiredItem[],
	catalog: readonly HostedSkillCatalogItem[],
): WorkspaceRuntimeSkill[] {
	const projectionByKey = new Map(projections.map((skill) => [skill.skill_key, skill]));
	const desiredByKey = new Map(desiredItems.map((skill) => [skill.skill_key, skill]));
	const catalogByKey = new Map(catalog.map((skill) => [skill.skill_key, skill]));
	const keys = new Set([...projectionByKey.keys(), ...desiredByKey.keys(), ...catalogByKey.keys()]);

	return [...keys]
		.map((skillKey): WorkspaceRuntimeSkill => {
			const projection = projectionByKey.get(skillKey);
			const desired = desiredByKey.get(skillKey);
			const catalogItem = catalogByKey.get(skillKey);
			return {
				entity:
					projection ??
					workspaceRuntimeSkillEntity(skillKey, {
						name: catalogItem?.name || skillKey,
						description: catalogItem?.description ?? null,
						source: desired ? "Runtime Workspace" : "Skill catalog",
						sourceRepo: catalogItem?.homepage ?? desired?.source.url ?? null,
					}),
				cloudProjection: projection ?? null,
				desired: desired ?? null,
				installable: !desired && !projection && catalogItem?.installable === true,
			};
		})
		.sort(
			(left, right) =>
				Number(Boolean(right.desired)) - Number(Boolean(left.desired)) ||
				Number(Boolean(right.cloudProjection)) - Number(Boolean(left.cloudProjection)) ||
				left.entity.name.localeCompare(right.entity.name),
		);
}

function workspaceRuntimeSkillEntity(
	skillKey: string,
	metadata: { name: string; description: string | null; source: string; sourceRepo: string | null },
): SkillCardEntity {
	return {
		skill_key: skillKey,
		name: metadata.name,
		description: metadata.description,
		source: metadata.source,
		source_repo: metadata.sourceRepo,
	};
}

export function workspaceSkillInstallCommand(repo: string, agentType: string): string {
	return `clawdi skill install ${shellArgument(repo.trim())} --agent ${shellArgument(agentType)}`;
}

export function workspaceSkillRemoveCommand(skillKey: string, agentType: string): string {
	return `clawdi skill rm ${shellArgument(skillKey)} --agent ${shellArgument(agentType)}`;
}

function shellArgument(value: string): string {
	if (/^[a-zA-Z0-9_./:@+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
