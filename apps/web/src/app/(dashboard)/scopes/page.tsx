"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus, Share2, UserCheck } from "lucide-react";
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
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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

export default function ScopesPage() {
	const authedFetch = useAuthedFetch();
	const qc = useQueryClient();
	const router = useRouter();
	const [newScopeName, setNewScopeName] = useState("");
	const [newScopeSlug, setNewScopeSlug] = useState("");
	const [createOpen, setCreateOpen] = useState(false);

	const scopes = useQuery({
		queryKey: ["scopes"],
		queryFn: async (): Promise<ScopeRow[]> => {
			const r = await authedFetch("/api/projects");
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

	const createScope = useMutation({
		mutationFn: async (): Promise<ScopeRow> => {
			const payload: { name: string; slug?: string } = { name: newScopeName.trim() };
			const slug = normalizeSlugInput(newScopeSlug);
			if (slug) payload.slug = slug;
			const r = await authedFetch("/api/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			return r.json();
		},
		onSuccess: (scope) => {
			setNewScopeName("");
			setNewScopeSlug("");
			setCreateOpen(false);
			qc.invalidateQueries({ queryKey: ["scopes"] });
			toast.success("Project created", {
				description: `${scope.name} is ready for skills, vault references, and sharing.`,
			});
			router.push(`/scopes/${scope.id}`);
		},
		onError: (e) => {
			toast.error("Failed to create project", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	if (scopes.isLoading) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<PageHeader
					title="Projects"
					description="Manage the context boundaries your people and agents can share."
				/>
				<Skeleton className="h-36 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Projects"
				description="Control which skills and vault references each collaboration can access."
				actions={
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							setNewScopeName("");
							setNewScopeSlug("");
							setCreateOpen(true);
						}}
					>
						<Plus className="size-3.5" />
						New project
					</Button>
				}
			/>

			{scopes.error ? (
				<Alert variant="destructive">
					<AlertTitle>Couldn&apos;t load projects</AlertTitle>
					<AlertDescription>{errorMessage(scopes.error)}</AlertDescription>
				</Alert>
			) : null}

			<Dialog
				open={createOpen}
				onOpenChange={(open) => {
					setCreateOpen(open);
					if (!open) {
						setNewScopeName("");
						setNewScopeSlug("");
					}
				}}
			>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>New project</DialogTitle>
						<DialogDescription>
							Create a reusable context for a project, team, or workflow. Add skills, vault
							references, and sharing settings after creation.
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (!newScopeName.trim() || createScope.isPending) return;
							createScope.mutate();
						}}
					>
						<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
							<div className="space-y-1.5">
								<Label htmlFor="scope-name">Name</Label>
								<Input
									id="scope-name"
									value={newScopeName}
									maxLength={200}
									placeholder="Project name"
									onChange={(event) => setNewScopeName(event.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="scope-slug">Slug</Label>
								<Input
									id="scope-slug"
									value={newScopeSlug}
									maxLength={80}
									placeholder="auto-generated"
									onChange={(event) => setNewScopeSlug(normalizeSlugDraft(event.target.value))}
								/>
							</div>
						</div>
						<div className="flex justify-end gap-2">
							<Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!newScopeName.trim() || createScope.isPending}>
								<Plus className="size-3.5" />
								{createScope.isPending ? "Creating..." : "Create project"}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			<section className="space-y-3">
				<SectionHeader
					title="Owned projects"
					count={ownedScopes.length}
					description="Projects you control directly."
				/>
				{ownedScopes.length === 0 ? (
					<EmptyLine message="No owned projects yet. Connect an agent or create a shareable project." />
				) : (
					<div className="divide-y rounded-lg border">
						{ownedScopes.map((scope) => (
							<OwnedProjectRow key={scope.id} scope={scope} />
						))}
					</div>
				)}
			</section>

			<section className="space-y-3">
				<SectionHeader
					title="Shared projects"
					count={sharedScopes.length}
					description="Projects shared with you by other people."
				/>
				{sharedScopes.length === 0 ? (
					<EmptyLine message="Accepted shares appear here." />
				) : (
					<div className="divide-y rounded-lg border">
						{sharedScopes.map((scope) => (
							<SharedProjectRow key={scope.id} scope={scope} />
						))}
					</div>
				)}
			</section>
		</div>
	);
}

function OwnedProjectRow({ scope }: { scope: ScopeRow }) {
	const scopeName = displayScopeName(scope);
	return (
		<div className="group relative px-3 py-3 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-muted/20">
			<Link
				href={`/scopes/${scope.id}`}
				aria-label={`Open ${scopeName}`}
				className="absolute inset-0 z-10 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
			/>
			<div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
				<ScopeIdentity scope={scope} />
				<div className="relative z-20 flex shrink-0 items-center justify-between gap-1 md:justify-end">
					<ShareScopeDialog scopeId={scope.id} scopeName={scopeName} scopeKind={scope.kind}>
						<Button variant="outline" size="sm" aria-label={`Share ${scopeName}`}>
							<Share2 className="mr-1.5 size-3.5" />
							Share
						</Button>
					</ShareScopeDialog>
					<ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
				</div>
			</div>
		</div>
	);
}

function SharedProjectRow({ scope }: { scope: ScopeRow }) {
	const scopeName = displayScopeName(scope);
	return (
		<div className="group relative px-3 py-3 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-muted/20">
			<Link
				href={`/scopes/${scope.id}`}
				aria-label={`Open ${scopeName}`}
				className="absolute inset-0 z-10 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
			/>
			<div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
				<div className="relative z-20 min-w-0 pointer-events-none">
					<ScopeIdentity scope={scope} tone="shared" />
					<p className="mt-1 text-xs text-muted-foreground">
						Access granted via sharing. Bind this project to agents explicitly when needed.
					</p>
				</div>
				<ArrowRight className="relative z-20 size-4 justify-self-end text-muted-foreground transition-transform group-hover:translate-x-0.5" />
			</div>
		</div>
	);
}

function ScopeIdentity({ scope, tone = "owned" }: { scope: ScopeRow; tone?: "owned" | "shared" }) {
	return (
		<div className="relative z-20 min-w-0 pointer-events-none">
			<div className="flex flex-wrap items-center gap-2">
				<h3 className="truncate text-sm font-semibold">{displayScopeName(scope)}</h3>
				{tone === "shared" ? (
					<Badge variant="secondary">
						<UserCheck className="size-3.5" />
						viewer
					</Badge>
				) : null}
				<ScopeKindBadge kind={scope.kind} />
			</div>
			<div className="mt-1 font-mono text-xs text-muted-foreground">{scope.slug}</div>
		</div>
	);
}

function ScopeKindBadge({ kind }: { kind: string }) {
	const meta = scopeKindMeta(kind);
	return (
		<Badge
			variant={kind === "personal" ? "outline" : "secondary"}
			className="text-xs"
			title={meta.description}
		>
			{meta.label}
		</Badge>
	);
}

function scopeKindMeta(kind: string) {
	if (kind === "workspace") {
		return {
			label: "Project",
			description: "Reusable context for a project, team, or workflow.",
		};
	}
	if (kind === "environment") {
		return {
			label: "Environment",
			description: "Project created by an agent environment.",
		};
	}
	if (kind === "personal") {
		return {
			label: "Personal",
			description: "Personal default project.",
		};
	}
	return { label: kind, description: `Project type: ${kind}` };
}

function SectionHeader({
	title,
	count,
	description,
}: {
	title: string;
	count: number;
	description: string;
}) {
	return (
		<div className="space-y-1 px-1">
			<div className="flex items-center gap-2">
				<h2 className="text-base font-semibold">{title}</h2>
				<Badge variant="secondary" className="text-xs">
					{count}
				</Badge>
			</div>
			<p className="text-xs text-muted-foreground">{description}</p>
		</div>
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

function displayScopeName(scope: ScopeRow) {
	if (
		scope.kind === "personal" &&
		(scope.slug === "personal" || ["default", "personal"].includes(scope.name.toLowerCase()))
	) {
		return "Personal";
	}
	return scope.name;
}

function EmptyLine({ message }: { message: string }) {
	return (
		<div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
			{message}
		</div>
	);
}
