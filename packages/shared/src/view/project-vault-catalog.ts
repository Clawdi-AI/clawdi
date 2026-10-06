import type { components } from "../api/api.generated";

type Vault = components["schemas"]["VaultResponse"];

import { compareVaultsForCatalog, vaultSearchRank } from "./vault-search";

/** Project-scoped links win over an older account catalog snapshot. */
export function projectVaultCatalogRows({
	projectId,
	attachedVaults,
	attachedVaultsUpdatedAt,
	catalogVaults,
	catalogUpdatedAt,
	search,
}: {
	projectId: string;
	attachedVaults: Vault[] | undefined;
	attachedVaultsUpdatedAt: number;
	catalogVaults: Vault[];
	catalogUpdatedAt: number;
	search: string;
}) {
	const scopedSnapshotIsNewer = attachedVaultsUpdatedAt > catalogUpdatedAt;
	const vaultsById = new Map(attachedVaults?.map((vault) => [vault.id, vault]));
	for (const vault of catalogVaults) {
		const attached = vaultsById.get(vault.id);
		// Metadata follows the latest snapshot; only the catalog knows other Project links.
		const metadata = attached && scopedSnapshotIsNewer ? attached : vault;
		const projectIds = scopedSnapshotIsNewer
			? attached
				? Array.from(new Set([...vault.project_ids, projectId]))
				: vault.project_ids.filter((id) => id !== projectId)
			: vault.project_ids;
		vaultsById.set(vault.id, { ...metadata, project_ids: projectIds });
	}
	return Array.from(vaultsById.values())
		.filter((vault) => vaultSearchRank(vault, search) !== null)
		.sort(
			(a, b) =>
				Number(a.is_owner === false) - Number(b.is_owner === false) ||
				compareVaultsForCatalog(a, b, search),
		);
}

export const PROJECT_VAULT_COPY = {
	searchPlaceholder: "Search vaults…",
	searchLabel: "Search vaults",
	available: "Available",
	noMatches: "No vaults match that search.",
	empty: "No vaults available yet.",
	name: "Vault name",
	placeholder: "Production credentials…",
	invalidName: "Use a name containing letters or numbers.",
	removeDescription: "Removing a vault preserves its keys and other projects.",
};
export function projectVaultCatalogDescription(context: string) {
	return `Add vaults from your library to this ${context}. Removing a vault preserves its keys and other projects.`;
}
export function projectVaultCreateDescription(context: string) {
	return `Create an account-owned vault for this ${context}. It will also remain available in your vault library.`;
}
