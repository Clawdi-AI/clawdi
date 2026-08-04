import type { DeployComponents } from "@clawdi/shared/api";
import type { SkillCardEntity } from "@/components/skills/skill-card";
import type { components } from "@/lib/api-schemas";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type HostedSkillCatalogItem = DeployComponents["schemas"]["V1SkillCatalogItem"];
type HostedSkillInstallResponse = DeployComponents["schemas"]["V1SkillInstallResponse"];
type HostedSkillStatusItem = DeployComponents["schemas"]["V1SkillStatusItem"];

export type WorkspaceRuntimeSkill = {
	entity: SkillCardEntity;
	cloudProjection: SkillSummary | null;
	installed: boolean;
	locked: boolean;
	installable: boolean;
};

export type HostedSkillInstallOutcome = "installed" | "pending" | "failed";

export function hostedSkillInstallOutcome(
	result: Pick<HostedSkillInstallResponse, "ok" | "status">,
): HostedSkillInstallOutcome {
	if (result.status === "pending") return "pending";
	return result.ok ? "installed" : "failed";
}

export function mergeWorkspaceRuntimeSkills(
	projections: readonly SkillSummary[],
	statuses: readonly HostedSkillStatusItem[],
	catalog: readonly HostedSkillCatalogItem[],
): WorkspaceRuntimeSkill[] {
	const projectionByKey = new Map(projections.map((skill) => [skill.skill_key, skill]));
	const statusByKey = new Map(
		statuses.filter((skill) => skill.skill_key).map((skill) => [skill.skill_key, skill]),
	);
	const catalogByKey = new Map(catalog.map((skill) => [skill.skill_key, skill]));
	const keys = new Set([...projectionByKey.keys(), ...statusByKey.keys(), ...catalogByKey.keys()]);

	return [...keys]
		.map((skillKey): WorkspaceRuntimeSkill => {
			const projection = projectionByKey.get(skillKey);
			const status = statusByKey.get(skillKey);
			const catalogItem = catalogByKey.get(skillKey);
			return {
				entity:
					projection ??
					workspaceRuntimeSkillEntity(skillKey, {
						name: status?.name || catalogItem?.name || skillKey,
						description: status?.description ?? catalogItem?.description ?? null,
						source: status?.source ?? "Agent runtime",
						sourceRepo: catalogItem?.homepage ?? status?.homepage ?? null,
					}),
				cloudProjection: projection ?? null,
				installed: Boolean(status),
				locked: status?.always === true || status?.bundled === true,
				installable: !status && catalogItem?.installable === true,
			};
		})
		.sort(
			(left, right) =>
				Number(right.installed) - Number(left.installed) ||
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
