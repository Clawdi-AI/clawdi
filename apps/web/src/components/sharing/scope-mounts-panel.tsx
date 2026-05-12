"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, useAuthedFetch } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

/**
 * Per-scope mount management panel (Plan §MF.2).
 *
 * Renders the list of ScopeMount edges composed INTO `scopeId`,
 * mirroring `clawdi scope mounts <parent>` on the CLI. Each row
 * carries an Unmount button that calls DELETE /api/scopes/{id}/mounts/{mount_id}.
 *
 * Self-hiding when empty so a default-Personal agent (no mounts)
 * doesn't show an empty section every time.
 */

interface MountRow {
	id: string;
	parent_scope_id: string;
	source_scope_id: string;
	source_scope_name: string;
	source_scope_slug: string;
	source_owner_display: string;
	source_owner_handle: string;
	alias: string;
	mode: string;
	created_at: string;
}

export function ScopeMountsPanel({ scopeId }: { scopeId: string }) {
	const authedFetch = useAuthedFetch();
	const qc = useQueryClient();

	const mounts = useQuery({
		queryKey: ["scope-mounts", scopeId],
		queryFn: async (): Promise<MountRow[]> => {
			const r = await authedFetch(`/api/scopes/${scopeId}/mounts`);
			return r.json();
		},
	});

	const unmount = useMutation({
		mutationFn: async (mountId: string) => {
			await authedFetch(`/api/scopes/${scopeId}/mounts/${mountId}`, {
				method: "DELETE",
			});
		},
		onSuccess: () => {
			// Membership in the source scope survives — invalidate skill /
			// scope caches so the composed content disappears from the
			// active view, but the source remains visible via membership.
			qc.invalidateQueries({ queryKey: ["scope-mounts", scopeId] });
			qc.invalidateQueries({ queryKey: ["skills"] });
			qc.invalidateQueries({ queryKey: ["scopes"] });
			toast.success("Mount removed — membership in the source scope is preserved.");
		},
		onError: (e) => {
			toast.error("Failed to unmount", {
				description: e instanceof ApiError ? `HTTP ${e.status}: ${e.detail}` : errorMessage(e),
			});
		},
	});

	if (mounts.isLoading) {
		return <Skeleton className="h-20 w-full" />;
	}
	const rows = mounts.data ?? [];
	if (rows.length === 0) return null;

	return (
		<section className="space-y-3">
			<div className="flex items-center gap-2 px-1">
				<Workflow className="size-4 text-muted-foreground" />
				<h3 className="font-semibold text-sm">Mounted scopes</h3>
				<Badge variant="secondary" className="text-xs">
					{rows.length}
				</Badge>
			</div>
			<p className="px-1 text-xs text-muted-foreground">
				Other people's scopes composed into this one. Their skills + vault read through here as
				read-only.
			</p>
			<ul className="space-y-2">
				{rows.map((m) => (
					<li key={m.id} className="flex items-center justify-between gap-2 rounded-lg border p-3">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2 text-sm">
								<span className="font-mono font-medium">{m.alias}</span>
								<span className="text-xs text-muted-foreground">
									→ {m.source_scope_name} <span className="font-mono">({m.source_scope_slug})</span>
								</span>
							</div>
							<div className="mt-0.5 text-xs text-muted-foreground">
								from {m.source_owner_display}{" "}
								<span className="font-mono">@{m.source_owner_handle}</span>
							</div>
						</div>
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={() => {
								const ok = window.confirm(
									`Unmount "${m.alias}"?\n\n` +
										"This drops the composition edge only. Your read access to the " +
										"source scope (via membership) stays intact — you can mount it " +
										"again later from the CLI or web.",
								);
								if (ok) unmount.mutate(m.id);
							}}
							disabled={unmount.isPending}
							className="text-muted-foreground hover:text-destructive"
							aria-label={`Unmount ${m.alias}`}
						>
							<Trash2 className="size-3.5" />
						</Button>
					</li>
				))}
			</ul>
		</section>
	);
}
