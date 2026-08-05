import type { DeployComponents } from "@clawdi/shared/api";
import type { SkillCardEntity } from "@/components/skills/skill-card";
import type { components } from "@/lib/api-schemas";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type HostedWorkspaceSkillInstallRequest =
	DeployComponents["schemas"]["V2WorkspaceSkillInstallRequest"];
type HostedWorkspaceSkillDesiredItem = DeployComponents["schemas"]["V2WorkspaceSkillDesiredItem"];
type HostedWorkspaceSkillListResponse = DeployComponents["schemas"]["V2WorkspaceSkillListResponse"];
type WorkspaceSkillStatusBoundary = Omit<HostedWorkspaceSkillListResponse, "capability"> & {
	capability?: HostedWorkspaceSkillListResponse["capability"];
};

export type WorkspaceRuntimeSkill = {
	entity: SkillCardEntity;
	cloudProjection: SkillSummary | null;
	desired: HostedWorkspaceSkillDesiredItem | null;
};

export function workspaceSkillMutationsAvailable(
	status: WorkspaceSkillStatusBoundary | undefined,
	error: unknown,
): boolean {
	return !error && status?.capability?.available === true;
}

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
			return {
				entity:
					projection ??
					workspaceRuntimeSkillEntity(skillKey, {
						name: skillKey,
						description: null,
						source: "Agent Workspace",
						sourceRepo: desired?.source.url ?? null,
					}),
				cloudProjection: projection ?? null,
				desired: desired ?? null,
			};
		})
		.sort(
			(left, right) =>
				Number(Boolean(right.desired)) - Number(Boolean(left.desired)) ||
				Number(Boolean(right.cloudProjection)) - Number(Boolean(left.cloudProjection)) ||
				left.entity.name.localeCompare(right.entity.name),
		);
}

export function parseWorkspaceSkillGitHubInput(input: string): HostedWorkspaceSkillInstallRequest {
	const clean = input
		.trim()
		.replace(/^https?:\/\/github\.com\//, "")
		.replace(/\/$/, "");
	const parts = clean.split("/").filter(Boolean);
	if (parts.length < 2) {
		throw new Error("Enter as `owner/repo` or `owner/repo/path-to-skill`.");
	}
	return {
		repo: `${parts[0]}/${parts[1]}`,
		path: parts.length > 2 ? parts.slice(2).join("/") : undefined,
	};
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
