import type { components } from "@/lib/api-schemas";

type AgentProjectBinding = components["schemas"]["AgentProjectBindingResponse"];
type VaultSummary = components["schemas"]["VaultResponse"];

/** Primary first, followed by context Projects in the agent's effective read order. */
export function effectiveAgentProjectIds(bindings: readonly AgentProjectBinding[]): string[] {
	const ordered = [
		...bindings.filter((binding) => binding.binding_type === "primary"),
		...bindings
			.filter((binding) => binding.binding_type === "context")
			.sort((left, right) => left.priority - right.priority),
	];
	return Array.from(new Set(ordered.map((binding) => binding.project_id)));
}

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
