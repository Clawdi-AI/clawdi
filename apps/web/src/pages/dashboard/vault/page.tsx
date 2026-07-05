"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Lock, Plus } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { HERO_CARD_BASE, HERO_GRID_CLASS, HeroCard } from "@/components/entity-card";
import { FilterChip } from "@/components/filter-chip";
import { IconChip } from "@/components/icon-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
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
import { slugFromVaultName } from "@/components/vault/vault-slug";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { getProjectResourceDefinition } from "@/lib/project-resource-model";
import { cn, errorMessage } from "@/lib/utils";

type VaultSummary = components["schemas"]["VaultResponse"];
type ProjectRow = components["schemas"]["ProjectResponse"];

const VAULTS_RESOURCE = getProjectResourceDefinition("vaults");

/* Vaults as cards (journey J6): one card per secret bundle, click through to
 * /vault/[slug] for keys and sharing. The old split-pane admin view is gone. */

export default function VaultPage() {
	const api = useApi();
	const [search, setSearch] = useState("");
	const [projectFilter, setProjectFilter] = useState<string>("all");

	const vaults = useQuery({
		queryKey: ["vaults", "all"],
		queryFn: async () =>
			unwrap(await api.GET("/v1/vault", { params: { query: { page_size: 200 } } })),
		placeholderData: keepPreviousData,
	});

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => unwrap(await api.GET("/v1/projects")),
		placeholderData: keepPreviousData,
	});
	const projectNameById = useMemo(
		() => new Map((projects.data ?? []).map((p) => [p.id, p.name])),
		[projects.data],
	);

	const items = vaults.data?.items ?? [];
	const hasActiveFilter = search.trim().length > 0 || projectFilter !== "all";
	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		let rows = items;
		if (projectFilter !== "all") {
			rows = rows.filter((v) => (v.project_ids ?? []).includes(projectFilter));
		}
		if (!q) return rows;
		return rows.filter((v) => [v.name, v.slug].join(" ").toLowerCase().includes(q));
	}, [items, search, projectFilter]);
	// Only projects that actually hold a vault — an empty filter option is
	// noise. Ranked by how many vaults they hold, busiest first.
	const vaultCountByProject = useMemo(() => {
		const m = new Map<string, number>();
		for (const v of items) {
			for (const pid of v.project_ids ?? []) m.set(pid, (m.get(pid) ?? 0) + 1);
		}
		return m;
	}, [items]);
	const filterableProjects = useMemo(() => {
		return (projects.data ?? [])
			.filter((p) => (vaultCountByProject.get(p.id) ?? 0) > 0)
			.sort(
				(a, b) =>
					(vaultCountByProject.get(b.id) ?? 0) - (vaultCountByProject.get(a.id) ?? 0) ||
					a.name.localeCompare(b.name),
			);
	}, [projects.data, vaultCountByProject]);
	// Busiest vaults first — same ranking rule as the project tabs.
	// The grab-bag default vault usually tops the list, which is exactly
	// where the curation work starts.
	const byKeysDesc = (a: VaultSummary, b: VaultSummary) =>
		(b.item_count ?? 0) - (a.item_count ?? 0) || a.name.localeCompare(b.name);
	const mine = filtered.filter((v) => v.is_owner !== false).sort(byKeysDesc);
	const shared = filtered.filter((v) => v.is_owner === false).sort(byKeysDesc);

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6")}>
			<PageHeader title="Vaults" description={VAULTS_RESOURCE.managementDescription} />

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
				actions={
					<>
						<AddKeysDialog />
						<NewVaultDialog />
					</>
				}
			/>

			{vaults.error ? (
				<ApiErrorPanel
					error={vaults.error}
					onRetry={() => {
						void vaults.refetch();
					}}
					title="Couldn't load vaults"
				/>
			) : vaults.isLoading ? (
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
							: "Create a vault to group API keys for your agents."
					}
					action={
						hasActiveFilter ? null : (
							<NewVaultDialog
								trigger={
									<Button size="sm">
										<Plus className="size-3.5" />
										New vault
									</Button>
								}
							/>
						)
					}
				/>
			) : (
				<>
					{projects.error ? (
						<ApiErrorPanel
							error={projects.error}
							onRetry={() => {
								void projects.refetch();
							}}
							title="Couldn't load Project names"
						/>
					) : null}
					<div
						className={cn(
							HERO_GRID_CLASS,
							"transition-opacity",
							vaults.isFetching && !vaults.isLoading ? "opacity-60" : "opacity-100",
						)}
					>
						{mine.map((vault) => (
							<VaultCard
								key={vault.id}
								vault={vault}
								projectNameById={projectNameById}
								projectNamesUnavailable={!!projects.error}
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
										projectNamesUnavailable={!!projects.error}
										shared
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

function VaultCard({
	vault,
	projectNameById,
	projectNamesUnavailable,
	shared = false,
}: {
	vault: VaultSummary;
	projectNameById: ReadonlyMap<string, string>;
	projectNamesUnavailable: boolean;
	shared?: boolean;
}) {
	const api = useApi();
	// Key count ships on the list response (names only, never values) —
	// no per-card items fetch. EXCEPT under deploy skew: a web build that
	// knows item_count can face an API that doesn't send it yet (web and
	// api don't deploy atomically), and treating missing as 0 told prod
	// users every vault was empty. Fall back to the per-card fetch then.
	const listCount: number | undefined = vault.item_count;
	const keys = useQuery({
		queryKey: ["vault-items", vault.slug, vault.project_ids?.[0]],
		enabled: listCount === undefined,
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/vault/{slug}/items", {
					params: {
						path: { slug: vault.slug },
						query: { project_id: vault.project_ids?.[0] ?? undefined },
					},
				}),
			),
	});
	const keyCount =
		listCount ??
		(keys.data ? Object.values(keys.data).reduce((n, arr) => n + arr.length, 0) : null);
	const usedBy = (vault.project_ids ?? [])
		.map((id) => projectNameById.get(id))
		.filter((n): n is string => !!n);

	return (
		<HeroCard
			icon={
				<IconChip tint={identityFor(vault.name).colorClasses} className="relative text-xl">
					{identityFor(vault.name).emoji}
					{shared ? (
						<span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border bg-card">
							<Lock className="size-2.5 text-muted-foreground" />
						</span>
					) : null}
				</IconChip>
			}
			title={vault.name}
			description={<span className="font-mono">{vault.slug}</span>}
			footer={[
				keyCount === null ? "…" : `${keyCount} ${keyCount === 1 ? "key" : "keys"}`,
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
			link={{ to: "/vault/$slug", params: { slug: vault.slug } }}
			ariaLabel={`Open vault ${vault.name}`}
		/>
	);
}

function VaultCardSkeleton() {
	return (
		<div className={cn(HERO_CARD_BASE, "flex min-h-36 flex-col gap-3")}>
			<Skeleton className="size-10 rounded-lg" />
			<div className="min-w-0 space-y-2">
				<Skeleton className="h-5 w-40 max-w-full" />
				<Skeleton className="h-3 w-28" />
			</div>
			<div className="mt-auto flex items-center gap-3">
				<Skeleton className="h-3 w-12" />
				<Skeleton className="h-3 w-32" />
			</div>
		</div>
	);
}

function NewVaultDialog({ trigger }: { trigger?: ReactElement }) {
	const api = useApi();
	const qc = useQueryClient();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => unwrap(await api.GET("/v1/projects")),
		enabled: open,
	});
	const vaultsQuery = useQuery({
		queryKey: ["vaults", "all"],
		queryFn: async () =>
			unwrap(await api.GET("/v1/vault", { params: { query: { page_size: 200 } } })),
		enabled: open,
	});
	// A vault is created through a project the user can write to; the
	// personal (Global) project always exists and is the least surprising
	// default — attachments can be changed afterwards on the vault page.
	const defaultProject = useMemo(() => {
		const rows = projects.data ?? [];
		return rows.find((p) => p.kind === "personal") ?? rows.find((p) => p.is_owner !== false);
	}, [projects.data]);

	const slug = slugFromVaultName(name);
	const slugTaken =
		slug.length > 0 &&
		(vaultsQuery.data?.items ?? []).some((v) => v.is_owner !== false && v.slug === slug);
	const canCreate =
		name.trim().length > 0 &&
		slug.length > 0 &&
		!slugTaken &&
		!projects.isLoading &&
		!vaultsQuery.isLoading &&
		defaultProject !== undefined;

	const create = useMutation({
		mutationFn: async () => {
			if (!defaultProject) throw new Error("No writable Project available yet");
			if (!slug) throw new Error("Use letters or numbers in the vault name");
			if ((vaultsQuery.data?.items ?? []).some((v) => v.is_owner !== false && v.slug === slug)) {
				throw new Error("A vault with that name already exists");
			}
			return unwrap(
				await api.POST("/v1/vault", {
					params: { query: { project_id: defaultProject.id, create_only: true } },
					body: { slug, name: name.trim() },
				}),
			);
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["vaults"] });
			setOpen(false);
			setName("");
			toast.success("Vault created", { description: "Add keys, then share it through a Project." });
			void router.navigate({ href: `/vault/${encodeURIComponent(slug)}` });
		},
		onError: (e) => toast.error("Couldn't create vault", { description: errorMessage(e) }),
	});
	const triggerElement = trigger ?? (
		<Button size="sm">
			<Plus className="size-3.5" />
			New vault
		</Button>
	);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setName("");
			}}
		>
			<DialogTrigger render={triggerElement} />
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>New vault</DialogTitle>
					<DialogDescription>
						A bundle of API keys your agents can use. Add it to Projects to control who can use it.
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
						{slug ? (
							<p className="font-mono text-xs text-muted-foreground">vault://{slug}</p>
						) : null}
						{slugTaken ? (
							<p className="text-xs text-destructive">
								That vault already exists. Open it from the vault list or use a different name.
							</p>
						) : null}
					</div>
					<div className="flex justify-end">
						<Button type="submit" disabled={!canCreate || create.isPending}>
							{create.isPending ? <Spinner /> : <Plus className="size-3.5" />}
							Create vault
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
