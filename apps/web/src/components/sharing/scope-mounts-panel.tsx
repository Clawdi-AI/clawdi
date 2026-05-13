"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
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

interface ScopeRow {
	id: string;
	name: string;
	slug: string;
	kind: string;
	is_owner?: boolean;
}

export function ScopeMountsPanel({ scopeId }: { scopeId: string }) {
	const authedFetch = useAuthedFetch();
	const qc = useQueryClient();
	const [sourceScopeId, setSourceScopeId] = useState("");

	const mounts = useQuery({
		queryKey: ["scope-mounts", scopeId],
		queryFn: async (): Promise<MountRow[]> => {
			const r = await authedFetch(`/api/scopes/${scopeId}/mounts`);
			return r.json();
		},
	});

	const scopes = useQuery({
		queryKey: ["scopes"],
		queryFn: async (): Promise<ScopeRow[]> => {
			const r = await authedFetch("/api/scopes");
			return r.json();
		},
	});

	const mountedSourceIds = useMemo(
		() => new Set((mounts.data ?? []).map((m) => m.source_scope_id)),
		[mounts.data],
	);
	const mountCandidates = useMemo(
		() =>
			(scopes.data ?? []).filter(
				(s) => s.is_owner === false && s.id !== scopeId && !mountedSourceIds.has(s.id),
			),
		[scopes.data, scopeId, mountedSourceIds],
	);

	useEffect(() => {
		if (sourceScopeId && !mountCandidates.some((s) => s.id === sourceScopeId)) {
			setSourceScopeId("");
		}
	}, [mountCandidates, sourceScopeId]);

	const mount = useMutation({
		mutationFn: async (sourceId: string) => {
			await authedFetch(`/api/scopes/${scopeId}/mounts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source_scope_id: sourceId }),
			});
		},
		onSuccess: () => {
			setSourceScopeId("");
			qc.invalidateQueries({ queryKey: ["scope-mounts", scopeId] });
			qc.invalidateQueries({ queryKey: ["skills"] });
			qc.invalidateQueries({ queryKey: ["scopes"] });
			toast.success("Scope mounted — shared skills now compose into this agent.");
		},
		onError: (e) => {
			toast.error("Failed to mount scope", {
				description: e instanceof ApiError ? `HTTP ${e.status}: ${e.detail}` : errorMessage(e),
			});
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

	if (mounts.isLoading || scopes.isLoading) {
		return <Skeleton className="h-20 w-full" />;
	}
	const rows = mounts.data ?? [];
	if (rows.length === 0 && mountCandidates.length === 0) return null;

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
			{mountCandidates.length > 0 ? (
				<div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
					<Select value={sourceScopeId} onValueChange={setSourceScopeId}>
						<SelectTrigger className="min-w-[220px] flex-1">
							<SelectValue placeholder="Add a shared scope" />
						</SelectTrigger>
						<SelectContent>
							{mountCandidates.map((scope) => (
								<SelectItem key={scope.id} value={scope.id}>
									{scope.name} ({scope.slug})
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						size="sm"
						onClick={() => mount.mutate(sourceScopeId)}
						disabled={!sourceScopeId || mount.isPending}
					>
						<Plus className="mr-1.5 size-3.5" />
						{mount.isPending ? "Mounting…" : "Mount"}
					</Button>
				</div>
			) : null}
			{rows.length > 0 ? (
				<ul className="space-y-2">
					{rows.map((m) => (
						<li
							key={m.id}
							className="flex items-center justify-between gap-2 rounded-lg border p-3"
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2 text-sm">
									<span className="font-mono font-medium">{m.alias}</span>
									<span className="text-xs text-muted-foreground">
										→ {m.source_scope_name}{" "}
										<span className="font-mono">({m.source_scope_slug})</span>
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
			) : null}
		</section>
	);
}
