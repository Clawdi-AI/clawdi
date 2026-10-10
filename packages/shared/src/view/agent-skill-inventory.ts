import type { components, DeployComponents } from "../api";
import { type FetchAllPagesOptions, fetchAllPages, type PaginatedPage } from "./api-pagination";

export type AgentSkillSummary = components["schemas"]["SkillSummaryResponse"];

export const agentSkillInstallCopy = {
	guardBlockedTitle: "Blocked by Hermes Skills Guard",
	guardBlocked:
		"Hermes's Skills Guard blocked this skill (it flagged risky code). Install it from its GitHub source to review it, or choose another skill.",
	guardBlockedGitHub:
		"Hermes's Skills Guard flagged this skill's code as risky and blocked installation. Choose another skill.",
	guardConfirmationRequiredTitle: "Hermes Skills Guard needs confirmation",
	guardConfirmationRequired:
		"Hermes's Skills Guard needs explicit confirmation for this skill. Retrying won't help.",
} as const;

type AgentSkillInstallStatus = Pick<
	components["schemas"]["AgentSkillDesiredResponse"],
	"source" | "convergence" | "observation_error_code"
>;
type AgentSkillInstallItem = AgentSkillInstallStatus &
	Pick<components["schemas"]["AgentSkillDesiredResponse"], "skill_key">;

export function agentSkillGuardPresentation(skill: AgentSkillInstallStatus | null | undefined) {
	if (skill?.convergence !== "failed") return null;
	if (skill.observation_error_code === "guard_confirmation_required") {
		return {
			title: "guardConfirmationRequiredTitle",
			message: "guardConfirmationRequired",
		} as const;
	}
	if (skill.observation_error_code === "guard_blocked") {
		return {
			title: "guardBlockedTitle",
			message: skill.source === "github" ? "guardBlockedGitHub" : "guardBlocked",
		} as const;
	}
	return null;
}

export function agentSkillsHaveRetryableInstallFailure(
	managed: readonly AgentSkillInstallItem[],
	hosted: readonly Pick<
		DeployComponents["schemas"]["V2WorkspaceSkillDesiredItem"],
		"skill_key" | "status"
	>[] = [],
): boolean {
	const guardKeys = new Set(
		managed.filter((skill) => agentSkillGuardPresentation(skill)).map((skill) => skill.skill_key),
	);
	return (
		managed.some((skill) => skill.convergence === "failed" && !guardKeys.has(skill.skill_key)) ||
		hosted.some((skill) => skill.status === "failed" && !guardKeys.has(skill.skill_key))
	);
}

type FetchSkillPage = (
	projectId: string,
	page: number,
	pageSize: number,
) => Promise<PaginatedPage<AgentSkillSummary>>;

/**
 * Fetch every user-visible Skill from the Agent's effective Projects. Each
 * Project is filtered by the API before pagination. Rows retain their
 * `(project_id, skill_key)` identity, so equal keys in different Projects are
 * distinct resources and stay in effective Project read order.
 */
export async function fetchAgentProjectSkills(
	projectIds: readonly string[],
	fetchPage: FetchSkillPage,
	options: Pick<FetchAllPagesOptions, "pageSize" | "maxPages"> = {},
): Promise<AgentSkillSummary[]> {
	const orderedProjectIds = Array.from(new Set(projectIds));
	const skills: AgentSkillSummary[] = [];

	for (const projectId of orderedProjectIds) {
		let loadedForProject = 0;
		const result = await fetchAllPages<AgentSkillSummary>(
			async (page, pageSize) => {
				const response = await fetchPage(projectId, page, pageSize);
				if (!Number.isSafeInteger(response.total) || (response.total ?? -1) < 0) {
					throw new Error("A skill response did not include valid pagination metadata.");
				}
				if (response.items.length === 0 && loadedForProject < (response.total ?? 0)) {
					throw new Error("A skill inventory ended before every project row was loaded.");
				}
				loadedForProject += response.items.length;
				return response;
			},
			{
				pageSize: options.pageSize ?? 200,
				maxPages: options.maxPages ?? 50,
				resourceName: "agent skill",
			},
		);

		for (const skill of result.items) {
			if (skill.project_id !== projectId) {
				throw new Error("A skill response did not match the requested project.");
			}
			skills.push(skill);
		}
	}

	return skills;
}
