import { type FetchAllPagesOptions, fetchAllPages, type PaginatedPage } from "@/lib/api-pagination";
import type { components } from "@/lib/api-schemas";

export { effectiveAgentProjectIds } from "@/components/dashboard/agent-project-scope";

type VaultSummary = components["schemas"]["VaultResponse"];

type FetchVaultPage = (
	projectId: string,
	page: number,
	pageSize: number,
) => Promise<PaginatedPage<VaultSummary>>;

/** Never return a Vault unless it is attached to at least one effective Agent Project. */
export function vaultsForProjectIds(
	vaults: readonly VaultSummary[],
	projectIds: readonly string[],
): VaultSummary[] {
	const allowed = new Set(projectIds);
	return vaults.filter((vault) =>
		(vault.project_ids ?? []).some((projectId) => allowed.has(projectId)),
	);
}

/**
 * Fetch every Vault attached to the Agent's effective Projects. Each Project is
 * filtered by the API before pagination, then shared Vaults are merged by their
 * stable id so no account-wide page boundary can hide an Agent Vault.
 */
export async function fetchAgentProjectVaults(
	projectIds: readonly string[],
	fetchPage: FetchVaultPage,
	options: Pick<FetchAllPagesOptions, "pageSize" | "maxPages"> = {},
): Promise<VaultSummary[]> {
	const orderedProjectIds = Array.from(new Set(projectIds));
	const allowedProjectIds = new Set(orderedProjectIds);
	const vaultsById = new Map<string, VaultSummary>();

	for (const projectId of orderedProjectIds) {
		const result = await fetchAllPages<VaultSummary>(
			(page, pageSize) => fetchPage(projectId, page, pageSize),
			{
				pageSize: options.pageSize ?? 200,
				maxPages: options.maxPages ?? 50,
				resourceName: "agent Vault",
			},
		);

		for (const vault of vaultsForProjectIds(result.items, orderedProjectIds)) {
			const visibleProjectIds = vault.project_ids.filter((id) => allowedProjectIds.has(id));
			const existing = vaultsById.get(vault.id);
			vaultsById.set(
				vault.id,
				existing
					? {
							...existing,
							project_ids: Array.from(new Set([...existing.project_ids, ...visibleProjectIds])),
						}
					: { ...vault, project_ids: visibleProjectIds },
			);
		}
	}

	return Array.from(vaultsById.values());
}
