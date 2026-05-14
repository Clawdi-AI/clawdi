"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	Box,
	ExternalLink,
	KeyRound,
	LogOut,
	type LucideIcon,
	Plus,
	Share2,
	Sparkles,
	Trash2,
	UserCheck,
	Workflow,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ScopeMountsPanel } from "@/components/sharing/scope-mounts-panel";
import { ShareScopeDialog } from "@/components/sharing/share-scope-dialog";
import {
	formatApiError,
	isVaultConflictDetail,
	parseApiDetail,
	type VaultConflictDetail,
	VaultConflictsAlert,
} from "@/components/sharing/vault-conflicts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, unwrap, useApi, useAuthedFetch } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type VaultSummary = components["schemas"]["VaultResponse"];

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

export default function ScopeDetailPage() {
	const params = useParams<{ id: string }>();
	const scopeId = params.id;
	const api = useApi();
	const authedFetch = useAuthedFetch();
	const qc = useQueryClient();
	const router = useRouter();
	const [selectedParentId, setSelectedParentId] = useState("");
	const [blockedMount, setBlockedMount] = useState<{
		sourceScopeId: string;
		parentScopeId: string;
		detail: VaultConflictDetail;
	} | null>(null);

	const scopes = useQuery({
		queryKey: ["scopes"],
		queryFn: async (): Promise<ScopeRow[]> => {
			const r = await authedFetch("/api/scopes");
			return r.json();
		},
	});

	const rows = scopes.data ?? [];
	const scope = rows.find((s) => s.id === scopeId) ?? null;
	const ownedScopes = useMemo(
		() => rows.filter((s) => s.is_owner !== false).sort(compareScopesForProductUse),
		[rows],
	);
	const isOwner = scope?.is_owner !== false;

	const allOwnedMounts = useQuery({
		queryKey: ["scope-mounts", "all-owned", ownedScopes.map((s) => s.id).join(",")],
		queryFn: async (): Promise<Record<string, MountRow[]>> => {
			const pairs = await Promise.all(
				ownedScopes.map(async (owned): Promise<[string, MountRow[]]> => {
					const r = await authedFetch(`/api/scopes/${owned.id}/mounts`);
					return [owned.id, (await r.json()) as MountRow[]];
				}),
			);
			return Object.fromEntries(pairs);
		},
		enabled: ownedScopes.length > 0,
	});

	const mountRows = Object.values(allOwnedMounts.data ?? {}).flat();
	const placements = mountRows.filter((m) => m.source_scope_id === scopeId);
	const parentSourceMounts = allOwnedMounts.data?.[scopeId] ?? [];
	const alreadyMountedParentIds = new Set(placements.map((p) => p.parent_scope_id));
	const mountTargets = ownedScopes.filter(
		(s) => s.id !== scopeId && !alreadyMountedParentIds.has(s.id),
	);
	const ownedScopeById = new Map(ownedScopes.map((s) => [s.id, s]));

	const skills = useQuery({
		queryKey: ["skills", "scope-detail", scopeId],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/skills", {
					params: { query: { scope_id: scopeId, page_size: 100 } },
				}),
			),
		enabled: !!scope,
	});

	const vaults = useQuery({
		queryKey: ["vaults", "scope-detail", scopeId],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/vault", {
					params: { query: { scope_id: scopeId, page_size: 100 } },
				}),
			),
		enabled: !!scope,
	});

	const directSkills = (skills.data?.items ?? []).filter((item) => item.scope_id === scopeId);
	const composedSkills = (skills.data?.items ?? []).filter((item) => item.scope_id !== scopeId);
	const directVaults = (vaults.data?.items ?? []).filter((item) => item.scope_id === scopeId);
	const composedVaults = (vaults.data?.items ?? []).filter((item) => item.scope_id !== scopeId);

	const refresh = () => {
		qc.invalidateQueries({ queryKey: ["scopes"] });
		qc.invalidateQueries({ queryKey: ["scope-mounts"] });
		qc.invalidateQueries({ queryKey: ["skills"] });
		qc.invalidateQueries({ queryKey: ["vaults"] });
	};

	const mountSharedScope = useMutation({
		mutationFn: async ({
			parentScopeId,
			allowVaultConflicts = false,
		}: {
			parentScopeId: string;
			allowVaultConflicts?: boolean;
		}) => {
			await authedFetch(`/api/scopes/${parentScopeId}/mounts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					source_scope_id: scopeId,
					allow_vault_conflicts: allowVaultConflicts,
				}),
			});
		},
		onSuccess: () => {
			setSelectedParentId("");
			setBlockedMount(null);
			refresh();
			toast.success("Scope is now used there");
		},
		onError: (e, vars) => {
			if (e instanceof ApiError && e.status === 409) {
				const detail = parseApiDetail(e.detail);
				if (isVaultConflictDetail(detail)) {
					setBlockedMount({
						sourceScopeId: scopeId,
						parentScopeId: vars.parentScopeId,
						detail,
					});
					return;
				}
			}
			toast.error("Failed to add scope", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	const removePlacement = useMutation({
		mutationFn: async (placement: MountRow) => {
			await authedFetch(`/api/scopes/${placement.parent_scope_id}/mounts/${placement.id}`, {
				method: "DELETE",
			});
		},
		onSuccess: (_data, placement) => {
			refresh();
			toast.success(
				`Stopped using this scope in ${formatOptionalScopeName(ownedScopeById.get(placement.parent_scope_id))}.`,
			);
		},
		onError: (e) => {
			toast.error("Failed to stop using scope", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	const leaveSharedScope = useMutation({
		mutationFn: async (): Promise<{ status: string; mounts_removed: number }> => {
			const r = await authedFetch(`/api/scopes/${scopeId}/leave`, { method: "POST" });
			return r.json();
		},
		onSuccess: (body) => {
			refresh();
			toast.success("Left shared scope", {
				description:
					body.mounts_removed > 0
						? `Stopped using this scope in ${body.mounts_removed} owned scope${body.mounts_removed === 1 ? "" : "s"}.`
						: "Membership removed.",
			});
			router.push("/scopes");
		},
		onError: (e) => {
			toast.error("Failed to leave shared scope", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	if (scopes.isLoading) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Skeleton className="h-10 w-52" />
				<Skeleton className="h-28 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	if (scopes.error) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Button asChild variant="ghost" size="sm" className="w-fit">
					<Link href="/scopes">
						<ArrowLeft className="mr-1.5 size-4" />
						Scopes
					</Link>
				</Button>
				<Alert variant="destructive">
					<AlertTitle>Couldn&apos;t load scope</AlertTitle>
					<AlertDescription>{errorMessage(scopes.error)}</AlertDescription>
				</Alert>
			</div>
		);
	}

	if (!scope) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Button asChild variant="ghost" size="sm" className="w-fit">
					<Link href="/scopes">
						<ArrowLeft className="mr-1.5 size-4" />
						Scopes
					</Link>
				</Button>
				<Alert>
					<AlertTitle>Scope not found</AlertTitle>
					<AlertDescription>
						This scope may have been removed, or your account no longer has access.
					</AlertDescription>
				</Alert>
			</div>
		);
	}

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<Button asChild variant="ghost" size="sm" className="w-fit">
				<Link href="/scopes">
					<ArrowLeft className="mr-1.5 size-4" />
					Scopes
				</Link>
			</Button>

			<PageHeader
				title={displayScopeName(scope)}
				description={`${isOwner ? "Owned" : "Shared viewer"} · ${scopeKindMeta(scope.kind).label} · ${scope.slug}`}
				actions={
					<div className="flex items-center gap-2">
						<ScopeKindBadge kind={scope.kind} />
						{isOwner ? (
							<ShareScopeDialog
								scopeId={scope.id}
								scopeName={displayScopeName(scope)}
								scopeKind={scope.kind}
							>
								<Button variant="outline" size="sm">
									<Share2 className="mr-1.5 size-3.5" />
									Share
								</Button>
							</ShareScopeDialog>
						) : null}
					</div>
				}
			/>

			<ScopeStatsStrip
				isOwner={isOwner}
				sourceCount={parentSourceMounts.length}
				placementCount={placements.length}
				skillCount={skills.data?.items.length ?? 0}
				vaultCount={vaults.data?.items.length ?? 0}
			/>

			<div className={isOwner ? "space-y-6" : "grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]"}>
				<div className="space-y-6">
					<section className="space-y-3">
						<h2 className="text-base font-semibold">Scope composition</h2>
						{isOwner ? (
							<ScopeMountsPanel scopeId={scope.id} showEmpty />
						) : (
							<div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
								<UserCheck className="size-4" />
								<span>The owner controls which other scopes this shared scope uses.</span>
							</div>
						)}
						<UsedInList
							placements={placements}
							ownedScopeById={ownedScopeById}
							onRemove={(placement) => removePlacement.mutate(placement)}
							removingId={removePlacement.variables?.id ?? null}
							isRemoving={removePlacement.isPending}
						/>
					</section>

					<section className="space-y-3">
						<ContentHeader
							title="Skills"
							direct={directSkills.length}
							composed={composedSkills.length}
						/>
						{isOwner ? <InstallSkillInScopeForm scopeId={scope.id} onChanged={refresh} /> : null}
						{skills.isLoading ? (
							<Skeleton className="h-24 w-full" />
						) : skills.error ? (
							<ErrorLine message={errorMessage(skills.error)} />
						) : skills.data?.items.length ? (
							<div className="divide-y rounded-lg border">
								{skills.data.items.map((skill) => (
									<SkillRow
										key={`${skill.scope_id}:${skill.skill_key}`}
										skill={skill}
										ownScopeId={scope.id}
									/>
								))}
							</div>
						) : (
							<EmptyLine message="No skills are visible through this scope yet." />
						)}
					</section>

					<section className="space-y-3">
						<ContentHeader
							title="Vaults"
							direct={directVaults.length}
							composed={composedVaults.length}
						/>
						{isOwner ? <CreateVaultInScopeForm scopeId={scope.id} onChanged={refresh} /> : null}
						{vaults.isLoading ? (
							<Skeleton className="h-24 w-full" />
						) : vaults.error ? (
							<ErrorLine message={errorMessage(vaults.error)} />
						) : vaults.data?.items.length ? (
							<div className="divide-y rounded-lg border">
								{vaults.data.items.map((vault) => (
									<VaultRow key={vault.id} vault={vault} ownScopeId={scope.id} />
								))}
							</div>
						) : (
							<EmptyLine message="No vault references are visible through this scope yet." />
						)}
					</section>
				</div>

				{!isOwner ? (
					<aside className="space-y-4">
						<section className="space-y-3 rounded-lg border p-3">
							<div className="space-y-1">
								<h2 className="text-sm font-semibold">Use this shared scope</h2>
								<p className="text-xs text-muted-foreground">
									Choose an owned scope where this shared content should be available.
								</p>
							</div>
							{mountTargets.length > 0 ? (
								<div className="flex flex-col gap-2">
									<Select value={selectedParentId} onValueChange={setSelectedParentId}>
										<SelectTrigger aria-label={`Select owned scope for ${displayScopeName(scope)}`}>
											<SelectValue placeholder="Choose where to use it" />
										</SelectTrigger>
										<SelectContent>
											{mountTargets.map((target) => (
												<SelectItem key={target.id} value={target.id}>
													{displayScopeName(target)} ({target.slug})
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Button
										size="sm"
										disabled={!selectedParentId || mountSharedScope.isPending}
										onClick={() => {
											if (selectedParentId) {
												mountSharedScope.mutate({ parentScopeId: selectedParentId });
											}
										}}
									>
										<Plus className="mr-1.5 size-3.5" />
										{mountSharedScope.isPending ? "Using..." : "Use in selected scope"}
									</Button>
								</div>
							) : ownedScopes.length > 0 ? (
								<Badge variant="outline" className="w-fit">
									Already used in every owned scope
								</Badge>
							) : (
								<Badge variant="outline" className="w-fit">
									No owned scope available
								</Badge>
							)}
							{blockedMount ? (
								<VaultConflictsAlert
									detail={blockedMount.detail}
									actionLabel="Use anyway"
									actionPending={mountSharedScope.isPending}
									onAction={() =>
										mountSharedScope.mutate({
											parentScopeId: blockedMount.parentScopeId,
											allowVaultConflicts: true,
										})
									}
								/>
							) : null}
							<AlertDialog>
								<AlertDialogTrigger asChild>
									<Button
										variant="ghost"
										size="sm"
										disabled={leaveSharedScope.isPending}
										className="w-fit text-muted-foreground hover:text-destructive"
									>
										<LogOut className="mr-1.5 size-3.5" />
										{leaveSharedScope.isPending ? "Leaving..." : "Leave scope"}
									</Button>
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>Leave "{displayScopeName(scope)}"?</AlertDialogTitle>
										<AlertDialogDescription>
											This removes your read membership and stops using this scope in every owned
											scope. The owner's scope is unchanged.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>Cancel</AlertDialogCancel>
										<AlertDialogAction
											onClick={() => leaveSharedScope.mutate()}
											className="bg-destructive text-white hover:bg-destructive/90"
										>
											Leave scope
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						</section>
					</aside>
				) : null}
			</div>
		</div>
	);
}

function ScopeStatsStrip({
	isOwner,
	sourceCount,
	placementCount,
	skillCount,
	vaultCount,
}: {
	isOwner: boolean;
	sourceCount: number;
	placementCount: number;
	skillCount: number;
	vaultCount: number;
}) {
	return (
		<div
			className={`grid divide-y rounded-lg border sm:divide-x sm:divide-y-0 ${
				isOwner ? "sm:grid-cols-4" : "sm:grid-cols-3"
			}`}
		>
			{isOwner ? <StatCell icon={Workflow} label="Uses" value={sourceCount} /> : null}
			<StatCell icon={Box} label="Used in" value={placementCount} />
			<StatCell icon={Sparkles} label="Skills" value={skillCount} />
			<StatCell icon={KeyRound} label="Vaults" value={vaultCount} />
		</div>
	);
}

function StatCell({
	icon: Icon,
	label,
	value,
}: {
	icon: LucideIcon;
	label: string;
	value: number;
}) {
	return (
		<div className="flex items-center justify-between gap-3 px-4 py-3">
			<div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
				<Icon className="size-4 shrink-0" />
				<span className="truncate">{label}</span>
			</div>
			<div className="text-xl font-semibold">{value}</div>
		</div>
	);
}

function UsedInList({
	placements,
	ownedScopeById,
	onRemove,
	removingId,
	isRemoving,
}: {
	placements: MountRow[];
	ownedScopeById: Map<string, ScopeRow>;
	onRemove: (placement: MountRow) => void;
	removingId: string | null;
	isRemoving: boolean;
}) {
	return (
		<section className="space-y-2">
			<div className="flex items-center gap-2 px-1">
				<Box className="size-4 text-muted-foreground" />
				<h3 className="font-semibold text-sm">Used in owned scopes</h3>
				<Badge variant="secondary" className="text-xs">
					{placements.length}
				</Badge>
			</div>
			{placements.length === 0 ? (
				<EmptyLine message="This scope is not used in any owned scope." />
			) : (
				<ul className="divide-y rounded-lg border">
					{placements.map((placement) => {
						const parent = ownedScopeById.get(placement.parent_scope_id);
						return (
							<li key={placement.id} className="flex items-center justify-between gap-3 p-3">
								<div className="min-w-0">
									<div className="truncate text-sm font-medium">
										{formatOptionalScopeName(parent)}
									</div>
									<div className="font-mono text-xs text-muted-foreground">{placement.alias}</div>
								</div>
								<div className="flex shrink-0 items-center gap-1">
									<Button asChild variant="ghost" size="icon-sm">
										<Link
											href={`/scopes/${placement.parent_scope_id}`}
											aria-label="Open owned scope"
										>
											<ExternalLink className="size-3.5" />
										</Link>
									</Button>
									<AlertDialog>
										<AlertDialogTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												disabled={isRemoving}
												className="text-muted-foreground hover:text-destructive"
												aria-label={`Stop using this scope in ${formatOptionalScopeName(parent)}`}
											>
												<Trash2 className="mr-1.5 size-3.5" />
												Stop using
											</Button>
										</AlertDialogTrigger>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>
													Stop using this scope in "{formatOptionalScopeName(parent)}"?
												</AlertDialogTitle>
												<AlertDialogDescription>
													This only removes it from that owned scope. Your read access to this
													shared scope stays intact.
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel>Cancel</AlertDialogCancel>
												<AlertDialogAction
													onClick={() => onRemove(placement)}
													disabled={removingId === placement.id}
													className="bg-destructive text-white hover:bg-destructive/90"
												>
													Stop using
												</AlertDialogAction>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

function ContentHeader({
	title,
	direct,
	composed,
}: {
	title: string;
	direct: number;
	composed: number;
}) {
	return (
		<div className="flex items-center justify-between gap-3">
			<div>
				<h2 className="text-base font-semibold">{title}</h2>
				<p className="text-sm text-muted-foreground">
					{direct} direct / {composed} from scopes used here
				</p>
			</div>
		</div>
	);
}

function InstallSkillInScopeForm({
	scopeId,
	onChanged,
}: {
	scopeId: string;
	onChanged: () => void;
}) {
	const api = useApi();
	const [repoInput, setRepoInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const install = useMutation({
		mutationFn: async ({ repo, path }: { repo: string; path?: string }) =>
			unwrap(
				await api.POST("/api/scopes/{scope_id}/skills/install", {
					params: { path: { scope_id: scopeId } },
					body: { repo, path },
				}),
			),
		onSuccess: () => {
			setRepoInput("");
			setError(null);
			onChanged();
			toast.success("Skill installed in this scope");
		},
		onError: (e) => {
			setError(errorMessage(e));
		},
	});

	const submit = () => {
		setError(null);
		const trimmed = repoInput.trim();
		if (!trimmed) return;
		const clean = trimmed.replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
		const parts = clean.split("/").filter(Boolean);
		if (parts.length < 2) {
			setError("Enter as `owner/repo` or `owner/repo/path-to-skill`.");
			return;
		}
		install.mutate({
			repo: `${parts[0]}/${parts[1]}`,
			path: parts.length > 2 ? parts.slice(2).join("/") : undefined,
		});
	};

	return (
		<div className="flex max-w-3xl flex-col gap-2 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:flex-wrap sm:items-center">
			<Input
				value={repoInput}
				onChange={(e) => {
					setRepoInput(e.target.value);
					setError(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") submit();
				}}
				placeholder="Install skill from GitHub: owner/repo or owner/repo/path"
				aria-invalid={!!error || undefined}
				className="min-w-0 flex-1"
			/>
			<Button
				size="sm"
				disabled={!repoInput.trim() || install.isPending}
				onClick={submit}
				className="w-full sm:w-auto"
			>
				{install.isPending ? <Spinner /> : <Plus className="mr-1.5 size-3.5" />}
				Install skill
			</Button>
			{error ? <p className="text-xs text-destructive sm:basis-full">{error}</p> : null}
		</div>
	);
}

function CreateVaultInScopeForm({
	scopeId,
	onChanged,
}: {
	scopeId: string;
	onChanged: () => void;
}) {
	const api = useApi();
	const [slug, setSlug] = useState("");
	const create = useMutation({
		mutationFn: async (nextSlug: string) =>
			unwrap(
				await api.POST("/api/vault", {
					params: { query: { scope_id: scopeId } },
					body: { slug: nextSlug, name: nextSlug },
				}),
			),
		onSuccess: () => {
			setSlug("");
			onChanged();
			toast.success("Vault created in this scope");
		},
		onError: (e) => toast.error("Failed to create vault", { description: errorMessage(e) }),
	});

	return (
		<div className="flex max-w-3xl flex-col gap-2 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center">
			<Input
				value={slug}
				onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
				onKeyDown={(e) => {
					if (e.key === "Enter" && slug) create.mutate(slug);
				}}
				placeholder="New vault name for this scope"
				className="min-w-0 flex-1"
			/>
			<Button
				size="sm"
				disabled={!slug || create.isPending}
				onClick={() => slug && create.mutate(slug)}
				className="w-full sm:w-auto"
			>
				{create.isPending ? <Spinner /> : <Plus className="mr-1.5 size-3.5" />}
				Create vault
			</Button>
		</div>
	);
}

function SkillRow({ skill, ownScopeId }: { skill: SkillSummary; ownScopeId: string }) {
	const direct = skill.scope_id === ownScopeId;
	return (
		<div className="flex items-center justify-between gap-3 p-3">
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm font-medium">{skill.name}</span>
					<Badge variant={direct ? "secondary" : "outline"}>{direct ? "direct" : "composed"}</Badge>
				</div>
				<div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
					{skill.skill_key}
					{skill.scope_name && !direct ? ` · from ${skill.scope_name}` : ""}
				</div>
			</div>
			<Button asChild variant="ghost" size="icon-sm">
				<Link
					href={`/skills/${encodeURIComponent(skill.skill_key)}?scope=${encodeURIComponent(skill.scope_id ?? ownScopeId)}`}
					aria-label={`Open ${skill.name}`}
				>
					<ExternalLink className="size-3.5" />
				</Link>
			</Button>
		</div>
	);
}

function VaultRow({ vault, ownScopeId }: { vault: VaultSummary; ownScopeId: string }) {
	const direct = vault.scope_id === ownScopeId;
	return (
		<div className="flex items-center justify-between gap-3 p-3">
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm font-medium">{vault.name}</span>
					<Badge variant={direct ? "secondary" : "outline"}>{direct ? "direct" : "composed"}</Badge>
				</div>
				<div className="mt-0.5 font-mono text-xs text-muted-foreground">{vault.slug}</div>
			</div>
			<KeyRound className="size-4 text-muted-foreground" />
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
			description: "Reusable scope for a project, team, or workflow.",
		};
	}
	if (kind === "environment") {
		return {
			label: "Agent",
			description: "Default scope owned by a connected agent.",
		};
	}
	if (kind === "personal") {
		return {
			label: "Account",
			description: "Account-wide fallback.",
		};
	}
	return { label: kind, description: `Scope type: ${kind}` };
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
		return "Account";
	}
	return scope.name;
}

function formatOptionalScopeName(scope: ScopeRow | undefined) {
	return scope ? displayScopeName(scope) : "Owned scope";
}

function EmptyLine({ message }: { message: string }) {
	return (
		<div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
			{message}
		</div>
	);
}

function ErrorLine({ message }: { message: string }) {
	return (
		<Alert variant="destructive">
			<AlertTitle>Couldn&apos;t load content</AlertTitle>
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}
