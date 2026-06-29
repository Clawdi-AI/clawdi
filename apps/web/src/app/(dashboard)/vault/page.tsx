"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ProjectTab } from "@/components/projects/project-tab";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { AddKeysDialog } from "@/components/vault/add-keys-dialog";
import { slugFromVaultName } from "@/components/vault/vault-slug";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { getProjectResourceDefinition } from "@/lib/project-resource-model";
import Link from "@/lib/router-link";
import { useRouter } from "@/lib/router-navigation";
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
			unwrap(await api.GET("/api/vault", { params: { query: { page_size: 200 } } })),
	});

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => unwrap(await api.GET("/api/projects")),
	});
	const projectNameById = useMemo(
		() => new Map((projects.data ?? []).map((p) => [p.id, p.name])),
		[projects.data],
	);

	const items = vaults.data?.items ?? [];
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
		<div className="space-y-6 px-4 lg:px-6">
			<PageHeader
				title="Vaults"
				description={VAULTS_RESOURCE.managementDescription}
				actions={
					<>
						<SearchInput
							value={search}
							onChange={setSearch}
							placeholder="Search vaults…"
							className="w-full sm:w-56"
						/>
						<AddKeysDialog />
						<NewVaultDialog />
					</>
				}
			/>

			{/* Project tabs, not a dropdown — a visible row teaches that vaults
			    are scoped through Projects (Marvin: dropdowns get ignored). */}
			{filterableProjects.length > 1 ? (
				<div
					className="flex flex-wrap items-center gap-1.5"
					role="tablist"
					aria-label="Filter vaults by Project"
				>
					<ProjectTab
						active={projectFilter === "all"}
						onClick={() => setProjectFilter("all")}
						label="All projects"
						count={items.length}
					/>
					{filterableProjects.map((p) => (
						<ProjectTab
							key={p.id}
							active={projectFilter === p.id}
							onClick={() => setProjectFilter(p.id)}
							label={p.name}
							emoji={identityFor(p.name).emoji}
							count={vaultCountByProject.get(p.id) ?? 0}
						/>
					))}
				</div>
			) : null}

			{vaults.error ? (
				<Alert variant="destructive">
					<AlertTitle>Couldn&apos;t load vaults</AlertTitle>
					<AlertDescription>{errorMessage(vaults.error)}</AlertDescription>
				</Alert>
			) : vaults.isLoading ? (
				<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
					{Array.from({ length: 3 }).map((_, i) => (
						<Skeleton key={i} className="h-36 w-full rounded-xl" />
					))}
				</div>
			) : (
				<>
					<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
						{mine.map((vault) => (
							<VaultCard key={vault.id} vault={vault} projectNameById={projectNameById} />
						))}
						{!search.trim() ? <NewVaultCard /> : null}
					</div>
					{shared.length > 0 ? (
						<section className="space-y-2">
							<h2 className="text-sm font-semibold">Shared with you</h2>
							<p className="text-xs text-muted-foreground">
								Read-only — your agents can use these keys; only the owner can edit them.
							</p>
							<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
								{shared.map((vault) => (
									<VaultCard
										key={vault.id}
										vault={vault}
										projectNameById={projectNameById}
										shared
									/>
								))}
							</div>
						</section>
					) : null}
					{filtered.length === 0 && search.trim() ? (
						<p className="py-12 text-center text-sm text-muted-foreground">
							No vaults match “{search.trim()}”.
						</p>
					) : null}
				</>
			)}
		</div>
	);
}

function VaultCard({
	vault,
	projectNameById,
	shared = false,
}: {
	vault: VaultSummary;
	projectNameById: ReadonlyMap<string, string>;
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
				await api.GET("/api/vault/{slug}/items", {
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
		<div className="group relative z-0 flex min-h-36 flex-col gap-3 rounded-xl border bg-card p-5 transition-all duration-150 hover:-translate-y-px hover:border-foreground/20">
			<span
				className={cn(
					"relative flex size-10 shrink-0 select-none items-center justify-center rounded-lg text-xl leading-none",
					identityFor(vault.name).colorClasses,
				)}
			>
				{identityFor(vault.name).emoji}
				{shared ? (
					<span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border bg-card">
						<Lock className="size-2.5 text-muted-foreground" />
					</span>
				) : null}
			</span>
			<div className="min-w-0">
				<h3 className="truncate text-base font-semibold tracking-tight">{vault.name}</h3>
				<p className="truncate font-mono text-xs text-muted-foreground">{vault.slug}</p>
			</div>
			<div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
				<span>{keyCount === null ? "…" : `${keyCount} ${keyCount === 1 ? "key" : "keys"}`}</span>
				{usedBy.length > 0 ? (
					<span className="truncate" title={usedBy.join(", ")}>
						used by {usedBy.slice(0, 2).join(", ")}
						{usedBy.length > 2 ? ` +${usedBy.length - 2}` : ""}
					</span>
				) : (
					<span>not in any Project yet</span>
				)}
			</div>
			<Link
				href={`/vault/${encodeURIComponent(vault.slug)}`}
				className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span className="sr-only">Open vault {vault.name}</span>
			</Link>
		</div>
	);
}

function NewVaultCard() {
	return (
		<NewVaultDialog
			trigger={
				<button
					type="button"
					className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-muted-foreground transition-colors duration-150 hover:border-foreground/25 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus:outline-none"
				>
					<span className="flex size-9 items-center justify-center rounded-lg bg-muted">
						<Plus className="size-4" />
					</span>
					<span className="text-sm font-medium">New vault</span>
				</button>
			}
		/>
	);
}

function NewVaultDialog({ trigger }: { trigger?: React.ReactNode }) {
	const api = useApi();
	const qc = useQueryClient();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => unwrap(await api.GET("/api/projects")),
		enabled: open,
	});
	const vaultsQuery = useQuery({
		queryKey: ["vaults", "all"],
		queryFn: async () =>
			unwrap(await api.GET("/api/vault", { params: { query: { page_size: 200 } } })),
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
				await api.POST("/api/vault", {
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
			router.push(`/vault/${encodeURIComponent(slug)}`);
		},
		onError: (e) => toast.error("Couldn't create vault", { description: errorMessage(e) }),
	});

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setName("");
			}}
		>
			<DialogTrigger asChild>
				{trigger ?? (
					<Button size="sm">
						<Plus className="size-3.5" />
						New vault
					</Button>
				)}
			</DialogTrigger>
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
