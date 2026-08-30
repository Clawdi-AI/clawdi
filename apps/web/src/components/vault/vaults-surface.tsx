"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Lock, Plus } from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS, HeroCard, HeroCardSkeleton } from "@/components/entity-card";
import { FilterChip } from "@/components/filter-chip";
import { IconChip } from "@/components/icon-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { displayProjectName } from "@/components/projects/project-metadata";
import { SearchHighlightedText } from "@/components/search-highlighted-text";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AddKeysDialog } from "@/components/vault/add-keys-dialog";
import { useAgentProjectVaults } from "@/components/vault/agent-vaults-query";
import { vaultsForSelectedProject } from "@/components/vault/vault-scope";
import { vaultSearchRank, vaultSearchSupportingText } from "@/components/vault/vault-search";
import { slugFromVaultName } from "@/components/vault/vault-slug";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { formatResourceCount, getProjectResourceDefinition } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import {
	LIBRARY_RESOURCE_SCOPE,
	type ResourceNavigationScope,
	vaultDetailHrefForScope,
	vaultDetailLink,
} from "@/lib/resource-navigation";
import { cn } from "@/lib/utils";

type VaultSummary = components["schemas"]["VaultResponse"];

const VAULTS_RESOURCE = getProjectResourceDefinition("vaults");

/* Vaults as cards (journey J6): one card per secret bundle, click through to
 * /vault/[slug] for keys and sharing. The old split-pane admin view is gone. */

export function VaultsSurface({
	embedded = false,
	agentProjectIds,
	navigationScope = LIBRARY_RESOURCE_SCOPE,
}: {
	embedded?: boolean;
	agentProjectIds?: readonly string[];
	navigationScope?: ResourceNavigationScope;
}) {
	const $api = useOpenApi();
	// URL-backed like the other lists: open a vault and come back with the
	// filter text intact.
	const [search, setSearch] = useQueryState(
		"q",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true, history: "replace" }),
	);
	const [projectParam, setProjectParam] = useQueryState(
		"project",
		parseAsString.withDefault("all").withOptions({ clearOnDefault: true, history: "replace" }),
	);
	const [embeddedProjectFilter, setEmbeddedProjectFilter] = useState("all");
	const projectFilter = embedded ? embeddedProjectFilter : projectParam;
	const setProjectFilter = (projectId: string) => {
		if (embedded) {
			setEmbeddedProjectFilter(projectId);
			return;
		}
		void setProjectParam(projectId);
	};

	const accountVaults = $api.useQuery(
		"get",
		"/v1/vault",
		{
			params: { query: { page_size: 200 } },
		},
		{
			placeholderData: keepPreviousData,
			enabled: agentProjectIds === undefined,
		},
	);
	const agentVaults = useAgentProjectVaults(agentProjectIds ?? [], {
		enabled: agentProjectIds !== undefined,
	});
	const vaultsQuery = agentProjectIds === undefined ? accountVaults : agentVaults;

	const projects = $api.useQuery(
		"get",
		"/v1/projects",
		{},
		{
			placeholderData: keepPreviousData,
		},
	);
	const projectNameById = useMemo(
		() =>
			new Map((projects.data ?? []).map((project) => [project.id, displayProjectName(project)])),
		[projects.data],
	);
	const projectNamesUnavailable = shouldBlockQueryError(projects.error, projects.data);

	const items =
		agentProjectIds === undefined ? (accountVaults.data?.items ?? []) : (agentVaults.data ?? []);
	const visibleProjectIds = useMemo(
		() => (agentProjectIds ? new Set(agentProjectIds) : null),
		[agentProjectIds],
	);
	const hasActiveFilter = search.trim().length > 0 || projectFilter !== "all";
	const filtered = useMemo(() => {
		const q = search.trim();
		const rows = vaultsForSelectedProject(items, projectFilter);
		if (!q) return rows;
		return rows.filter((vault) => vaultSearchRank(vault, q) !== null);
	}, [items, search, projectFilter]);
	// Only projects that actually hold a vault — an empty filter option is
	// noise. Ranked by how many vaults they hold, busiest first.
	const vaultCountByProject = useMemo(() => {
		const m = new Map<string, number>();
		for (const v of items) {
			for (const pid of v.project_ids ?? []) {
				if (!visibleProjectIds || visibleProjectIds.has(pid)) {
					m.set(pid, (m.get(pid) ?? 0) + 1);
				}
			}
		}
		return m;
	}, [items, visibleProjectIds]);
	const filterableProjects = useMemo(() => {
		return (projects.data ?? [])
			.filter((p) => (vaultCountByProject.get(p.id) ?? 0) > 0 || p.id === projectFilter)
			.sort(
				(a, b) =>
					(vaultCountByProject.get(b.id) ?? 0) - (vaultCountByProject.get(a.id) ?? 0) ||
					a.name.localeCompare(b.name),
			);
	}, [projectFilter, projects.data, vaultCountByProject]);
	// Busiest vaults first — same ranking rule as the project tabs.
	// The grab-bag default vault usually tops the list, which is exactly
	// where the curation work starts.
	const byKeysDesc = (a: VaultSummary, b: VaultSummary) =>
		(b.item_count ?? 0) - (a.item_count ?? 0) || a.name.localeCompare(b.name);
	const bySearchRank = (a: VaultSummary, b: VaultSummary) =>
		(vaultSearchRank(a, search) ?? Number.MAX_SAFE_INTEGER) -
			(vaultSearchRank(b, search) ?? Number.MAX_SAFE_INTEGER) ||
		a.name.localeCompare(b.name) ||
		a.id.localeCompare(b.id);
	const sortVaults = search.trim() ? bySearchRank : byKeysDesc;
	const mine = filtered.filter((v) => v.is_owner !== false).sort(sortVaults);
	const shared = filtered.filter((v) => v.is_owner === false).sort(sortVaults);

	return (
		<div
			className={cn(
				embedded ? "space-y-6" : CENTERED_PAGE_WIDTH_CLASS.page,
				!embedded && "space-y-6 px-4 lg:px-6",
			)}
			data-testid="vaults-surface"
		>
			{embedded ? null : (
				<PageHeader
					title="Vaults"
					description={VAULTS_RESOURCE.managementDescription}
					actions={
						<>
							<AddKeysDialog>
								<Button size="sm" variant="outline">
									<Plus className="size-3.5" />
									Add keys
								</Button>
							</AddKeysDialog>
							<NewVaultDialog navigationScope={navigationScope} />
						</>
					}
				/>
			)}

			<ListToolbar
				search={<SearchInput value={search} onChange={setSearch} placeholder="Search vaults…" />}
				filters={
					filterableProjects.length > 1 ? (
						<>
							<FilterChip active={projectFilter === "all"} onClick={() => setProjectFilter("all")}>
								All projects
								<span className="text-muted-foreground tabular-nums">{items.length}</span>
							</FilterChip>
							{filterableProjects.map((p) => (
								<FilterChip
									key={p.id}
									active={projectFilter === p.id}
									onClick={() => setProjectFilter(p.id)}
								>
									<span aria-hidden className="select-none">
										{identityFor(p.name).emoji}
									</span>
									{p.name}
									<span className="text-muted-foreground tabular-nums">
										{vaultCountByProject.get(p.id) ?? 0}
									</span>
								</FilterChip>
							))}
						</>
					) : null
				}
			/>

			{shouldBlockQueryError(vaultsQuery.error, vaultsQuery.data) ? (
				<ApiErrorPanel
					error={vaultsQuery.error}
					onRetry={() => {
						void vaultsQuery.refetch();
					}}
					title="Couldn't load vaults"
				/>
			) : vaultsQuery.isLoading ? (
				<div className={HERO_GRID_CLASS}>
					{Array.from({ length: 3 }).map((_, i) => (
						<VaultCardSkeleton key={i} />
					))}
				</div>
			) : filtered.length === 0 ? (
				<EmptyState
					title={hasActiveFilter ? "No vaults match these filters" : "No vaults yet"}
					description={
						hasActiveFilter
							? "Try a different search or Project filter."
							: embedded
								? "This agent does not have any Vaults through its Projects yet."
								: "Create a vault to group API keys for your agents."
					}
				/>
			) : (
				<>
					{projectNamesUnavailable ? (
						<ApiErrorPanel
							error={projects.error}
							onRetry={() => {
								void projects.refetch();
							}}
							title="Couldn't load Project names"
						/>
					) : null}
					<div className={HERO_GRID_CLASS}>
						{mine.map((vault) => (
							<VaultCard
								key={vault.id}
								vault={vault}
								projectNameById={projectNameById}
								projectNamesUnavailable={projectNamesUnavailable}
								visibleProjectIds={visibleProjectIds}
								navigationScope={navigationScope}
								searchQuery={search.trim() || undefined}
							/>
						))}
					</div>
					{shared.length > 0 ? (
						<section className="space-y-2">
							<SectionLabel count={shared.length}>Shared with you</SectionLabel>
							<p className="text-xs text-muted-foreground">
								Read-only — your agents can use these keys; only the owner can edit them.
							</p>
							<div className={HERO_GRID_CLASS}>
								{shared.map((vault) => (
									<VaultCard
										key={vault.id}
										vault={vault}
										projectNameById={projectNameById}
										projectNamesUnavailable={projectNamesUnavailable}
										visibleProjectIds={visibleProjectIds}
										navigationScope={navigationScope}
										shared
										searchQuery={search.trim() || undefined}
									/>
								))}
							</div>
						</section>
					) : null}
				</>
			)}
		</div>
	);
}

export function VaultCard({
	vault,
	projectNameById,
	projectNamesUnavailable,
	visibleProjectIds,
	navigationScope,
	shared = false,
	actions,
	searchQuery,
}: {
	vault: VaultSummary;
	projectNameById: ReadonlyMap<string, string>;
	projectNamesUnavailable: boolean;
	visibleProjectIds: ReadonlySet<string> | null;
	navigationScope: ResourceNavigationScope;
	shared?: boolean;
	actions?: ReactNode;
	searchQuery?: string;
}) {
	const api = useApi();
	const itemProjectId =
		vault.project_ids?.find((projectId) => visibleProjectIds?.has(projectId)) ??
		vault.project_ids?.[0];
	const canManageVault = vault.is_owner !== false;
	// Key count ships on the list response (names only, never values) —
	// no per-card items fetch. EXCEPT under deploy skew: a web build that
	// knows item_count can face an API that doesn't send it yet (web and
	// api don't deploy atomically), and treating missing as 0 told prod
	// users every vault was empty. Fall back to the per-card fetch then.
	const listCount: number | undefined = vault.item_count;
	const keys = useQuery({
		queryKey: ["vault-items", vault.id, vault.slug, itemProjectId],
		enabled: listCount === undefined,
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/vault/{slug}/items", {
					params: {
						path: { slug: vault.slug },
						query: {
							project_id: itemProjectId,
							vault_id: vault.id,
						},
					},
				}),
			),
	});
	const keyCount =
		listCount ??
		(keys.data ? Object.values(keys.data).reduce((n, arr) => n + arr.length, 0) : null);
	const usedBy = (vault.project_ids ?? [])
		.filter((id) => !visibleProjectIds || visibleProjectIds.has(id))
		.map((id) => projectNameById.get(id))
		.filter((n): n is string => !!n);
	const identity = identityFor(vault.name);
	const keyCountLabel = keys.isError ? (
		"Key count unavailable"
	) : keyCount === null ? (
		<Skeleton key="key-count" className="h-3 w-12" aria-label="Loading key count" />
	) : (
		formatResourceCount(keyCount, "key")
	);
	const searchSupportingText = searchQuery ? vaultSearchSupportingText(vault, searchQuery) : null;

	return (
		<HeroCard
			icon={
				<IconChip tint={identity.colorClasses} className="relative text-xl">
					{identity.emoji}
					{shared ? (
						<span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border bg-card">
							<Lock className="size-2.5 text-muted-foreground" />
						</span>
					) : null}
				</IconChip>
			}
			title={
				searchQuery ? <SearchHighlightedText text={vault.name} query={searchQuery} /> : vault.name
			}
			description={
				searchSupportingText ? (
					<SearchHighlightedText text={searchSupportingText} query={searchQuery ?? ""} />
				) : undefined
			}
			footer={[
				keyCountLabel,
				usedBy.length > 0 ? (
					<Tooltip>
						<TooltipTrigger render={<span className="truncate" />}>
							used by {usedBy.slice(0, 2).join(", ")}
							{usedBy.length > 2 ? ` +${usedBy.length - 2}` : ""}
						</TooltipTrigger>
						<TooltipContent>{usedBy.join(", ")}</TooltipContent>
					</Tooltip>
				) : projectNamesUnavailable && (vault.project_ids?.length ?? 0) > 0 ? (
					"Project details unavailable"
				) : (
					"not in any Project yet"
				),
			]}
			actions={
				canManageVault || actions ? (
					<>
						{canManageVault ? (
							<AddKeysDialog
								vaultSlug={vault.slug}
								vaultId={vault.id}
								vaultProjectId={itemProjectId}
							>
								<Button variant="ghost" size="sm" aria-label={`Add keys to ${vault.name}`}>
									<Plus className="size-3.5" />
									Add keys
								</Button>
							</AddKeysDialog>
						) : null}
						{actions}
					</>
				) : undefined
			}
			link={vaultDetailLink(navigationScope, vault.slug, vault.id)}
			ariaLabel={`Open vault ${vault.name}`}
		/>
	);
}

export function VaultCardSkeleton() {
	return <HeroCardSkeleton />;
}

function NewVaultDialog({ navigationScope }: { navigationScope: ResourceNavigationScope }) {
	const api = useApi();
	const $api = useOpenApi();
	const qc = useQueryClient();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");

	const vaultsQuery = $api.useQuery(
		"get",
		"/v1/vault",
		{
			params: { query: { page_size: 200 } },
		},
		{
			enabled: open,
		},
	);
	const slug = slugFromVaultName(name);
	const slugTaken =
		slug.length > 0 &&
		(vaultsQuery.data?.items ?? []).some((v) => v.is_owner !== false && v.slug === slug);
	const canCreate =
		name.trim().length > 0 && slug.length > 0 && !slugTaken && !vaultsQuery.isLoading;

	const create = useMutation({
		mutationFn: async () => {
			if (!slug) throw new Error("Use letters or numbers in the vault name");
			if ((vaultsQuery.data?.items ?? []).some((v) => v.is_owner !== false && v.slug === slug)) {
				throw new Error("A vault with that name already exists");
			}
			return unwrap(
				await api.POST("/v1/vault", {
					params: { query: { create_only: true } },
					body: { slug, name: name.trim() },
				}),
			);
		},
		onSuccess: (vault) => {
			qc.invalidateQueries({ queryKey: ["get", "/v1/vault"] });
			setOpen(false);
			toast.success("Vault created", {
				description: "Use Add keys on its card, then attach it to a Project.",
				action: {
					label: "Open vault",
					onClick: () =>
						void router.navigate({
							href: vaultDetailHrefForScope(navigationScope, vault.slug, vault.id),
						}),
				},
			});
		},
		onError: (error) =>
			toast.error("Couldn't create vault", { description: normalizeApiError(error) }),
	});
	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
			onOpenChangeComplete={(next) => {
				if (!next) setName("");
			}}
		>
			<DialogTrigger render={<Button size="sm" />}>
				<Plus className="size-3.5" />
				Create vault
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Create vault</DialogTitle>
					<DialogDescription>
						A bundle of API keys your Agents can use. Attach it to Projects to control access.
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						if (canCreate && !create.isPending) create.mutate();
					}}
				>
					<div className="space-y-1.5">
						<Label htmlFor="vault-name">Name</Label>
						<Input
							id="vault-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="GitHub, OpenAI, Production…"
							maxLength={200}
							autoComplete="off"
							autoFocus
						/>
						{slugTaken ? (
							<p className="text-xs text-destructive">
								That vault already exists. Open it from the vault list or use a different name.
							</p>
						) : null}
					</div>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={!canCreate || create.isPending}>
							{create.isPending ? <Spinner /> : <Plus className="size-3.5" />}
							Create vault
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
