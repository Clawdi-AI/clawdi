import { type FetchAllPagesOptions, fetchAllPages, type PaginatedPage } from "@/lib/api-pagination";
import type { components } from "@/lib/api-schemas";

export type AgentSkillSummary = components["schemas"]["SkillSummaryResponse"];

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
					throw new Error("A Skill response did not include valid pagination metadata.");
				}
				if (response.items.length === 0 && loadedForProject < (response.total ?? 0)) {
					throw new Error("A Skill inventory ended before every Project row was loaded.");
				}
				loadedForProject += response.items.length;
				return response;
			},
			{
				pageSize: options.pageSize ?? 200,
				maxPages: options.maxPages ?? 50,
				resourceName: "agent Skill",
			},
		);

		for (const skill of result.items) {
			if (skill.project_id !== projectId) {
				throw new Error("A Skill response did not match the requested Project.");
			}
			skills.push(skill);
		}
	}

	return skills;
}
