"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchAgentProjectVaults } from "@/components/vault/vault-scope";
import { unwrap, useApi } from "@/lib/api";

export function useAgentProjectVaults(
	projectIds: readonly string[],
	{ enabled = true }: { enabled?: boolean } = {},
) {
	const api = useApi();
	return useQuery({
		queryKey: ["vaults", "agent-projects", ...projectIds],
		queryFn: async () =>
			fetchAgentProjectVaults(projectIds, async (projectId, page, pageSize) =>
				unwrap(
					await api.GET("/v1/vault", {
						params: { query: { project_id: projectId, page, page_size: pageSize } },
					}),
				),
			),
		enabled: enabled && projectIds.length > 0,
	});
}
