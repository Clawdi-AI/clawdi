import { vaultRequestsRefetchInterval } from "@clawdi/shared/api";
import { VAULT_SECRET_REQUESTS_COPY as copy, vaultSecretRequestMeta } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { unwrap, useApi } from "@/lib/api";

export function VaultSecretRequests({
	slug,
	vaultId,
	projectId,
}: {
	slug: string;
	vaultId: string;
	projectId?: string;
}) {
	const api = useApi();
	const qc = useQueryClient();
	const requests = useQuery({
		queryKey: ["vault-requests", vaultId, projectId],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/vault/requests", {
					params: { query: { slug, vault_id: vaultId, project_id: projectId } },
				}),
			),
		refetchInterval: (query) => vaultRequestsRefetchInterval(query.state.data),
	});
	useEffect(() => {
		if (requests.data?.some((row) => row.status === "supplied")) {
			void qc.invalidateQueries({ queryKey: ["vault-items", vaultId] });
		}
	}, [requests.data, qc, vaultId]);
	if (requests.isError)
		return (
			<p role="alert" className="text-sm">
				{copy.loadFailed}{" "}
				<Button variant="link" onClick={() => void requests.refetch()}>
					{copy.retry}
				</Button>
			</p>
		);
	if (!requests.data?.length) return null;
	return (
		<section className="space-y-3 rounded-xl border p-4" aria-label={copy.label}>
			<h2 className="font-medium">{copy.title}</h2>
			{requests.data.map((row) => (
				<div key={row.id} className="flex flex-wrap items-start justify-between gap-2 text-sm">
					<div>
						<p className="font-mono">{row.fields.join(", ")}</p>
						<p className="text-xs text-muted-foreground">{vaultSecretRequestMeta(row)}</p>
					</div>
					<Badge variant="secondary">{copy.status[row.status]}</Badge>
				</div>
			))}
		</section>
	);
}
