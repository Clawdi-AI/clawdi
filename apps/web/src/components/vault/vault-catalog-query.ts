"use client";

import { useQuery } from "@tanstack/react-query";
import { unwrap, useApi } from "@/lib/api";
import { fetchAllPages } from "@/lib/api-pagination";

/** Account-readable metadata, fully paginated; attachments remain Project-scoped. */
export function useVaultCatalog({ enabled = true }: { enabled?: boolean } = {}) {
	const api = useApi();
	return useQuery({
		queryKey: ["get", "/v1/vault", "catalog"],
		enabled,
		queryFn: ({ signal }) =>
			fetchAllPages(
				async (page, pageSize) =>
					unwrap(
						await api.GET("/v1/vault", {
							signal,
							params: { query: { page, page_size: pageSize } },
						}),
					),
				{ pageSize: 200, resourceName: "Vault catalog" },
			),
	});
}
