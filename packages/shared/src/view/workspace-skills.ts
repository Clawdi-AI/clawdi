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

/** Explains hosted Workspace Skill error codes without exposing server internals. */
export function workspaceSkillErrorMessage(code: unknown): string | null {
	switch (code) {
		case "workspace_skill_source_invalid":
			return "Couldn't find a valid skill at this GitHub path. Check the repository and try again.";
		case "workspace_skill_source_unavailable":
			return "GitHub is temporarily unavailable. Try again.";
		case "workspace_skill_source_conflict":
			return "A skill with this name is installed from another repository. Uninstall it first.";
		case "workspace_skill_reserved":
			return "This skill is built in and can't be changed.";
		case "workspace_skills_capability_unavailable":
			return "Skill installation will be available when your agent is ready and up to date.";
		default:
			return null;
	}
}

type ManagedAgentSkill = components["schemas"]["AgentSkillDesiredResponse"];
export type AgentSkillInventoryItem = WorkspaceRuntimeSkill & { managed: ManagedAgentSkill | null };

/**
 * One row per skill an Agent's Skills page lists: managed skills plus the workspace's agent-synced
 * projections and hosted GitHub desired state, as Web's Skills tab and both overviews count them.
 */
export function agentSkillInventory(
	managed: readonly ManagedAgentSkill[],
	projections: readonly SkillSummary[],
	hosted: readonly HostedWorkspaceSkillDesiredItem[],
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
