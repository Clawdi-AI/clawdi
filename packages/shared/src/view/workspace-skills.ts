import type { DeployComponents } from "@clawdi/shared/api";

export {
	parseWorkspaceSkillGitHubInput,
	workspaceSkillMutationsAvailable,
} from "@clawdi/shared/api";

import type { components } from "../api";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
export type SkillCardEntity = Pick<SkillSummary, "skill_key" | "name" | "description"> &
	Partial<Pick<SkillSummary, "source" | "source_repo" | "version" | "updated_at">>;
type HostedWorkspaceSkillDesiredItem = DeployComponents["schemas"]["V2WorkspaceSkillDesiredItem"];
export type WorkspaceRuntimeSkill = {
	entity: SkillCardEntity;
	cloudProjection: SkillSummary | null;
	desired: HostedWorkspaceSkillDesiredItem | null;
	projectionOnly: boolean;
};

export function mergeWorkspaceRuntimeSkills(
	projections: readonly SkillSummary[],
	desiredItems: readonly HostedWorkspaceSkillDesiredItem[],
): WorkspaceRuntimeSkill[] {
	const projectionByKey = new Map(projections.map((skill) => [skill.skill_key, skill]));
	const desiredByKey = new Map(desiredItems.map((skill) => [skill.skill_key, skill]));
	const keys = new Set([...projectionByKey.keys(), ...desiredByKey.keys()]);

	return [...keys]
		.map((skillKey): WorkspaceRuntimeSkill => {
			const projection = projectionByKey.get(skillKey);
			const desired = desiredByKey.get(skillKey);
			const desiredSource = desired
				? [desired.source.url.replace("https://github.com/", ""), desired.source.path]
						.filter(Boolean)
						.join("/")
				: null;
			return {
				entity:
					projection && desired
						? { ...projection, source: "Agent workspace", source_repo: desiredSource }
						: (projection ??
							workspaceRuntimeSkillEntity(skillKey, {
								name: skillKey,
								description: null,
								source: "Agent workspace",
								sourceRepo: desiredSource,
							})),
				cloudProjection: projection ?? null,
				desired: desired ?? null,
				projectionOnly: Boolean(projection && !desired),
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

export const workspaceSkillInstallCopy = {
	title: "Install skill",
	description: "Choose a skill from your library or a public GitHub repository.",
	library: "Library",
	github: "GitHub",
} as const;
