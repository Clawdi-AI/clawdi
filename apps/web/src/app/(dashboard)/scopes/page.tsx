"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Link2, Plus, Share2, UserCheck, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ShareScopeDialog } from "@/components/sharing/share-scope-dialog";
import { formatApiError } from "@/components/sharing/vault-conflicts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, useAuthedFetch } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

interface ScopeRow {
	id: string;
	name: string;
	slug: string;
	kind: string;
	origin_environment_id: string | null;
	archived_at: string | null;
	created_at: string;
	is_owner?: boolean;
}

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

export default function ScopesPage() {
	const authedFetch = useAuthedFetch();
	const qc = useQueryClient();
	const router = useRouter();
	const [newScopeName, setNewScopeName] = useState("");
	const [newScopeSlug, setNewScopeSlug] = useState("");

	const scopes = useQuery({
		queryKey: ["scopes"],
		queryFn: async (): Promise<ScopeRow[]> => {
			const r = await authedFetch("/api/scopes");
			return r.json();
		},
	});

	const rows = scopes.data ?? [];
	const ownedScopes = useMemo(
		() => rows.filter((s) => s.is_owner !== false).sort(compareScopesForProductUse),
		[rows],
	);
	const sharedScopes = useMemo(
		() => rows.filter((s) => s.is_owner === false).sort(compareScopesForProductUse),
		[rows],
	);

	const mounts = useQuery({
		queryKey: ["scope-mounts", "all-owned", ownedScopes.map((s) => s.id).join(",")],
		queryFn: async (): Promise<Record<string, MountRow[]>> => {
			const pairs = await Promise.all(
				ownedScopes.map(async (scope): Promise<[string, MountRow[]]> => {
					const r = await authedFetch(`/api/scopes/${scope.id}/mounts`);
					return [scope.id, (await r.json()) as MountRow[]];
				}),
			);
			return Object.fromEntries(pairs);
		},
		enabled: ownedScopes.length > 0,
	});

	const mountsByParent = mounts.data ?? {};
	const mountRows = Object.values(mountsByParent).flat();
	const mountedBySource = useMemo(() => {
		const map = new Map<string, MountRow[]>();
		for (const mount of mountRows) {
			const existing = map.get(mount.source_scope_id) ?? [];
			existing.push(mount);
			map.set(mount.source_scope_id, existing);
		}
		return map;
	}, [mountRows]);

	const createScope = useMutation({
		mutationFn: async (): Promise<ScopeRow> => {
			const payload: { name: string; slug?: string } = { name: newScopeName.trim() };
			const slug = normalizeSlugInput(newScopeSlug);
			if (slug) payload.slug = slug;
			const r = await authedFetch("/api/scopes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			return r.json();
		},
		onSuccess: (scope) => {
			setNewScopeName("");
			setNewScopeSlug("");
			qc.invalidateQueries({ queryKey: ["scopes"] });
			toast.success("Scope created", {
				description: `${scope.name} is ready for skills, vault references, sharing, and mounts.`,
			});
			router.push(`/scopes/${scope.id}`);
		},
		onError: (e) => {
			toast.error("Failed to create scope", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	if (scopes.isLoading) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<PageHeader
					title="Scopes"
					description="Manage the context boundaries your people and agents can compose."
				/>
				<Skeleton className="h-36 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Scopes"
				description="Manage scope access, sharing, and mounts."
				actions={
					<div className="flex items-center gap-2">
						<Badge variant="secondary">{ownedScopes.length} owned</Badge>
						{sharedScopes.length > 0 ? <Badge>{sharedScopes.length} shared</Badge> : null}
					</div>
				}
			/>

			{scopes.error ? (
				<Alert variant="destructive">
					<AlertTitle>Couldn&apos;t load scopes</AlertTitle>
					<AlertDescription>{errorMessage(scopes.error)}</AlertDescription>
				</Alert>
			) : null}

			<form
				className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-2 sm:flex-row sm:items-center"
				onSubmit={(event) => {
					event.preventDefault();
					if (!newScopeName.trim() || createScope.isPending) return;
					createScope.mutate();
				}}
			>
				<Label htmlFor="scope-name" className="sr-only">
					Scope name
				</Label>
				<Input
					id="scope-name"
					value={newScopeName}
					maxLength={200}
					placeholder="New scope name"
					className="sm:max-w-xl sm:flex-1"
					onChange={(event) => setNewScopeName(event.target.value)}
				/>
				<Label htmlFor="scope-slug" className="sr-only">
					Scope slug
				</Label>
				<Input
					id="scope-slug"
					value={newScopeSlug}
					maxLength={80}
					placeholder="auto-generated slug"
					className="sm:w-56"
					onChange={(event) => setNewScopeSlug(normalizeSlugDraft(event.target.value))}
				/>
				<Button
					type="submit"
					size="sm"
					disabled={!newScopeName.trim() || createScope.isPending}
					className="w-full sm:w-28"
				>
					<Plus className="size-3.5" />
					{createScope.isPending ? "Creating..." : "Create"}
				</Button>
			</form>

			<section className="space-y-3">
				<div className="flex items-center gap-2">
					<h2 className="text-base font-semibold">My scopes</h2>
					<Badge variant="secondary" className="text-xs">
						{ownedScopes.length}
					</Badge>
				</div>
				{ownedScopes.length === 0 ? (
					<EmptyLine message="No owned scopes yet. Connect an agent or create a shareable scope." />
				) : (
					<div className="grid gap-3 lg:grid-cols-2">
						{ownedScopes.map((scope) => (
							<OwnedScopeRow
								key={scope.id}
								scope={scope}
								mounts={mountsByParent[scope.id] ?? []}
								placements={mountedBySource.get(scope.id) ?? []}
							/>
						))}
					</div>
				)}
			</section>

			<section className="space-y-3">
				<div className="flex items-center gap-2">
					<h2 className="text-base font-semibold">Shared with me</h2>
					<Badge variant="secondary" className="text-xs">
						{sharedScopes.length}
					</Badge>
				</div>
				{sharedScopes.length === 0 ? (
					<EmptyLine message="Accepted shares will appear here before or after you mount them." />
				) : (
					<div className="space-y-3">
						{sharedScopes.map((scope) => (
							<SharedScopeRow
								key={scope.id}
								scope={scope}
								placements={mountedBySource.get(scope.id) ?? []}
								ownedScopes={ownedScopes}
							/>
						))}
					</div>
				)}
			</section>
		</div>
	);
}

function OwnedScopeRow({
	scope,
	mounts,
	placements,
}: {
	scope: ScopeRow;
	mounts: MountRow[];
	placements: MountRow[];
}) {
	return (
		<div className="group relative rounded-lg border px-3 py-3 transition-colors hover:bg-muted/20">
			<Link
				href={`/scopes/${scope.id}`}
				aria-label={`Open ${scope.name}`}
				className="absolute inset-0 z-10 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
			/>
			<div className="flex items-start justify-between gap-3">
				<ScopeIdentity scope={scope} />
				<div className="relative z-20 flex shrink-0 items-center gap-1">
					<ShareScopeDialog scopeId={scope.id} scopeName={scope.name} scopeKind={scope.kind}>
						<Button variant="outline" size="sm" aria-label={`Share ${scope.name}`}>
							<Share2 className="mr-1.5 size-3.5" />
							Share
						</Button>
					</ShareScopeDialog>
					<ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
				</div>
			</div>
			<div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
				<Badge variant="outline" className="font-normal">
					<Link2 className="size-3.5" />
					{mounts.length} source{mounts.length === 1 ? "" : "s"}
				</Badge>
				{placements.length > 0 ? (
					<Badge variant="outline" className="font-normal">
						<Workflow className="size-3.5" />
						{placements.length} placement{placements.length === 1 ? "" : "s"}
					</Badge>
				) : null}
			</div>
		</div>
	);
}

function SharedScopeRow({
	scope,
	placements,
	ownedScopes,
}: {
	scope: ScopeRow;
	placements: MountRow[];
	ownedScopes: ScopeRow[];
}) {
	const ownedScopeById = new Map(ownedScopes.map((s) => [s.id, s]));
	return (
		<div className="group relative rounded-lg border px-3 py-3 transition-colors hover:bg-muted/20">
			<Link
				href={`/scopes/${scope.id}`}
				aria-label={`Open ${scope.name}`}
				className="absolute inset-0 z-10 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
			/>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="truncate text-sm font-semibold">{scope.name}</h3>
						<Badge variant="secondary">
							<UserCheck className="size-3.5" />
							viewer
						</Badge>
						<ScopeKindBadge kind={scope.kind} />
					</div>
					<div className="mt-1 font-mono text-xs text-muted-foreground">{scope.slug}</div>
				</div>
				<ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
			</div>
			<div className="mt-2">
				{placements.length === 0 ? (
					<Badge variant="outline" className="font-normal">
						Not mounted
					</Badge>
				) : (
					<div className="space-y-1.5">
						{placements.map((placement) => (
							<div
								key={placement.id}
								className="flex max-w-full items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-xs"
							>
								<Workflow className="size-3.5 shrink-0 text-muted-foreground" />
								<span className="min-w-0 truncate">
									{ownedScopeById.get(placement.parent_scope_id)?.name ?? "Owned scope"}
								</span>
								<span className="shrink-0 text-muted-foreground">/</span>
								<span className="min-w-0 truncate font-mono text-muted-foreground">
									{placement.alias}
								</span>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function ScopeIdentity({ scope }: { scope: ScopeRow }) {
	return (
		<div className="relative z-20 min-w-0 pointer-events-none">
			<div className="flex flex-wrap items-center gap-2">
				<h3 className="truncate text-sm font-semibold">{scope.name}</h3>
				<ScopeKindBadge kind={scope.kind} />
			</div>
			<div className="mt-1 font-mono text-xs text-muted-foreground">{scope.slug}</div>
		</div>
	);
}

function ScopeKindBadge({ kind }: { kind: string }) {
	const label =
		kind === "workspace" ? "project scope" : kind === "environment" ? "agent env" : kind;
	return (
		<Badge
			variant={kind === "personal" ? "outline" : "secondary"}
			className="text-xs"
			title={`scope kind: ${kind}`}
		>
			{label}
		</Badge>
	);
}

function normalizeSlugInput(value: string) {
	return normalizeSlugDraft(value).replace(/-+$/, "");
}

function normalizeSlugDraft(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+/, "");
}

function compareScopesForProductUse(a: ScopeRow, b: ScopeRow) {
	const rank = (kind: string) => (kind === "workspace" ? 0 : kind === "personal" ? 1 : 2);
	const byRank = rank(a.kind) - rank(b.kind);
	if (byRank !== 0) return byRank;
	return a.name.localeCompare(b.name);
}

function EmptyLine({ message }: { message: string }) {
	return (
		<div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
			{message}
		</div>
	);
}
