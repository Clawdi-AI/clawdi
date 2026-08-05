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

function hasAsciiControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code <= 0x1f || code === 0x7f;
	});
}

export type WorkspaceRuntimeSkill = {
	entity: SkillCardEntity;
	cloudProjection: SkillSummary | null;
	desired: HostedWorkspaceSkillDesiredItem | null;
	projectionOnly: boolean;
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
			const desiredSource = desired
				? [desired.source.url.replace("https://github.com/", ""), desired.source.path]
						.filter(Boolean)
						.join("/")
				: null;
			return {
				entity:
					projection && desired
						? { ...projection, source: "Agent Workspace", source_repo: desiredSource }
						: (projection ??
							workspaceRuntimeSkillEntity(skillKey, {
								name: skillKey,
								description: null,
								source: "Agent Workspace",
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

export function parseWorkspaceSkillGitHubInput(input: string): HostedWorkspaceSkillInstallRequest {
	const clean = input.trim();
	let repositoryPath: string;
	if (clean.includes("://")) {
		let url: URL;
		try {
			url = new URL(clean);
		} catch {
			throw new Error("Enter a valid GitHub repository URL.");
		}
		if (
			url.protocol !== "https:" ||
			url.host !== "github.com" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new Error("Enter a canonical github.com repository URL.");
		}
		try {
			repositoryPath = decodeURIComponent(url.pathname).replace(/\/$/, "").replace(/^\//, "");
		} catch {
			throw new Error("Enter a valid GitHub repository URL.");
		}
	} else {
		repositoryPath = clean.replace(/\/$/, "");
	}
	const parts = repositoryPath.split("/");
	const [owner, repo, ...pathParts] = parts;
	if (
		parts.length < 2 ||
		!owner ||
		!repo ||
		!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
		!/^[A-Za-z0-9._-]{1,100}$/.test(repo) ||
		pathParts.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				segment.includes("\\") ||
				hasAsciiControlCharacter(segment),
		)
	) {
		throw new Error("Enter as `owner/repo` or `owner/repo/path-to-skill`.");
	}
	return {
		repo: `${owner}/${repo}`,
		path: pathParts.length > 0 ? pathParts.join("/") : undefined,
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
