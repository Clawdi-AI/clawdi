"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import {
	formatApiError,
	isVaultConflictDetail,
	parseApiDetail,
	type VaultConflictDetail,
	VaultConflictsAlert,
} from "./vault-conflicts";

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

export function ScopeMountsPanel({
	scopeId,
	showEmpty = false,
}: {
	scopeId: string;
	showEmpty?: boolean;
}) {
	const authedFetch = useAuthedFetch();
	const qc = useQueryClient();
	const [sourceScopeId, setSourceScopeId] = useState("");
	const [blockedMount, setBlockedMount] = useState<{
		sourceScopeId: string;
		detail: VaultConflictDetail;
	} | null>(null);

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
			(scopes.data ?? [])
				.filter((s) => s.id !== scopeId && !mountedSourceIds.has(s.id))
				.sort(compareScopesForProductUse),
		[scopes.data, scopeId, mountedSourceIds],
	);

	useEffect(() => {
		if (sourceScopeId && !mountCandidates.some((s) => s.id === sourceScopeId)) {
			setSourceScopeId("");
		}
	}, [mountCandidates, sourceScopeId]);

	const mount = useMutation({
		mutationFn: async ({
			sourceId,
			allowVaultConflicts = false,
		}: {
			sourceId: string;
			allowVaultConflicts?: boolean;
		}) => {
			await authedFetch(`/api/scopes/${scopeId}/mounts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					source_scope_id: sourceId,
					allow_vault_conflicts: allowVaultConflicts,
				}),
			});
		},
		onSuccess: () => {
			setSourceScopeId("");
			setBlockedMount(null);
			qc.invalidateQueries({ queryKey: ["scope-mounts", scopeId] });
			qc.invalidateQueries({ queryKey: ["skills"] });
			qc.invalidateQueries({ queryKey: ["scopes"] });
			toast.success("Scope mounted — shared skills now appear in this target scope.");
		},
		onError: (e, variables) => {
			if (e instanceof ApiError && e.status === 409) {
				const detail = parseApiDetail(e.detail);
				if (isVaultConflictDetail(detail)) {
					setBlockedMount({ sourceScopeId: variables.sourceId, detail });
					return;
				}
			}
			toast.error("Failed to mount scope", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
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
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	if (mounts.isLoading || scopes.isLoading) {
		return <Skeleton className="h-20 w-full" />;
	}
	if (mounts.error || scopes.error) {
		const error = mounts.error ?? scopes.error;
		return (
			<Alert variant="destructive">
				<Workflow className="size-4" />
				<AlertDescription>
					{error instanceof ApiError ? formatApiError(error.detail) : errorMessage(error)}
				</AlertDescription>
			</Alert>
		);
	}
	const rows = mounts.data ?? [];
	if (rows.length === 0 && mountCandidates.length === 0) {
		if (!showEmpty) return null;
		return (
			<section className="space-y-3">
				<div className="flex items-center gap-2 px-1">
					<Workflow className="size-4 text-muted-foreground" />
					<h3 className="font-semibold text-sm">Source scopes</h3>
					<Badge variant="secondary" className="text-xs">
						0
					</Badge>
				</div>
				<div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
					No source scopes are mounted into this scope yet.
				</div>
			</section>
		);
	}

	return (
		<section className="space-y-3">
			<div className="flex items-center gap-2 px-1">
				<Workflow className="size-4 text-muted-foreground" />
				<h3 className="font-semibold text-sm">Source scopes</h3>
				<Badge variant="secondary" className="text-xs">
					{rows.length}
				</Badge>
			</div>
			{mountCandidates.length > 0 ? (
				<div className="flex max-w-3xl flex-col gap-2 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center">
					<Select
						value={sourceScopeId}
						onValueChange={(next) => {
							setSourceScopeId(next);
							setBlockedMount(null);
						}}
					>
						<SelectTrigger
							className="min-w-0 flex-1 sm:min-w-[220px]"
							aria-label="Select source scope to mount"
						>
							<SelectValue placeholder="Add source scope" />
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
						className="w-full sm:w-auto"
						onClick={() => mount.mutate({ sourceId: sourceScopeId })}
						disabled={!sourceScopeId || mount.isPending}
						aria-label="Mount selected source scope"
					>
						<Plus className="mr-1.5 size-3.5" />
						{mount.isPending ? "Mounting…" : "Mount source"}
					</Button>
				</div>
			) : null}
			{blockedMount ? (
				<VaultConflictsAlert
					detail={blockedMount.detail}
					actionLabel="Mount anyway"
					actionPending={mount.isPending}
					onAction={() =>
						mount.mutate({
							sourceId: blockedMount.sourceScopeId,
							allowVaultConflicts: true,
						})
					}
				/>
			) : null}
			{rows.length > 0 ? (
				<ul className="divide-y rounded-lg border">
					{rows.map((m) => (
						<li key={m.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 p-3">
							<div className="min-w-0 space-y-1">
								<div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
									<Badge variant="outline" className="w-fit max-w-full font-mono font-normal">
										<span className="truncate">{m.alias}</span>
									</Badge>
									<span className="min-w-0 truncate text-sm font-medium">
										{m.source_scope_name}
									</span>
								</div>
								<div className="truncate font-mono text-xs text-muted-foreground">
									{m.source_scope_slug}
								</div>
								<div className="truncate text-xs text-muted-foreground">
									from {m.source_owner_display}{" "}
									<span className="font-mono">@{m.source_owner_handle}</span>
								</div>
							</div>
							<AlertDialog>
								<AlertDialogTrigger asChild>
									<Button
										variant="ghost"
										size="icon-sm"
										disabled={unmount.isPending}
										className="text-muted-foreground hover:text-destructive"
										aria-label={`Unmount source ${m.alias}`}
									>
										<Trash2 className="size-3.5" />
									</Button>
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>Unmount "{m.alias}"?</AlertDialogTitle>
										<AlertDialogDescription>
											This removes only the composition edge. Your read access to the source scope
											stays intact, so you can mount it again later.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>Cancel</AlertDialogCancel>
										<AlertDialogAction
											onClick={() => unmount.mutate(m.id)}
											className="bg-destructive text-white hover:bg-destructive/90"
										>
											Unmount
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						</li>
					))}
				</ul>
			) : null}
		</section>
	);
}

function compareScopesForProductUse(a: ScopeRow, b: ScopeRow) {
	const rank = (kind: string) => (kind === "workspace" ? 0 : kind === "personal" ? 1 : 2);
	const byRank = rank(a.kind) - rank(b.kind);
	if (byRank !== 0) return byRank;
	return a.name.localeCompare(b.name);
}
