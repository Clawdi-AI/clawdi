import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { unwrap, useApi } from "@/lib/api";

const labels = {
	pending: "Awaiting input",
	supplied: "Supplied",
	expired: "Expired",
	conflict: "Field already exists",
};

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
		refetchInterval: (query) =>
			query.state.data?.some((row) => row.status === "pending") ? 10000 : false,
	});
	useEffect(() => {
		if (requests.data?.some((row) => row.status === "supplied")) {
			void qc.invalidateQueries({ queryKey: ["vault-items", vaultId] });
		}
	}, [requests.data, qc, vaultId]);
	if (requests.isError)
		return (
			<p role="alert" className="text-sm">
				Could not load secret requests.{" "}
				<Button variant="link" onClick={() => void requests.refetch()}>
					Retry
				</Button>
			</p>
		);
	if (!requests.data?.length) return null;
	return (
		<section className="space-y-3 rounded-xl border p-4" aria-label="Secret requests">
			<h2 className="font-medium">Recent secret requests</h2>
			{requests.data.map((row) => (
				<div key={row.id} className="flex flex-wrap items-start justify-between gap-2 text-sm">
					<div>
						<p className="font-mono">{row.fields.join(", ")}</p>
						<p className="text-xs text-muted-foreground">
							{row.section || "No section"} · {row.project_name} · Expires{" "}
							{new Date(row.expires_at).toLocaleString()}
						</p>
					</div>
					<Badge variant="secondary">{labels[row.status]}</Badge>
				</div>
			))}
		</section>
	);
}
