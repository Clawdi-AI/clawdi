"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertCircle, Key, Plus, Search, Trash2, X } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import {
	compareProjectsForUse,
	displayProjectName,
	isProjectOwner,
	type ProjectAgentMetadata,
	ProjectIdentity,
	ProjectScopePicker,
	projectAgentFor,
} from "@/components/projects/project-metadata";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi } from "@/lib/api";
import type { Vault } from "@/lib/api-schemas";
import { getProjectResourceDefinition } from "@/lib/project-resource-model";
import { cn, errorMessage } from "@/lib/utils";

interface VaultField {
	key: string;
	name: string;
	section: string;
}

interface VaultProjectMetadata {
	id?: string;
	name: string;
	slug: string;
	kind?: string;
	origin_environment_id?: string | null;
	is_owner?: boolean;
	owner_display?: string | null;
	owner_handle?: string | null;
}

interface VaultCatalogEntry {
	vault: Vault;
	project?: VaultProjectMetadata;
	agent: ProjectAgentMetadata | null;
	readOnly: boolean;
}

interface VaultCatalogGroup {
	slug: string;
	entries: VaultCatalogEntry[];
}

const VAULTS_RESOURCE = getProjectResourceDefinition("vaults");

export default function VaultPage() {
	return (
		<Suspense fallback={null}>
			<VaultPageInner />
		</Suspense>
	);
}

function VaultPageInner() {
	const api = useApi();
	const queryClient = useQueryClient();
	const [newVaultSlug, setNewVaultSlug] = useState("");
	const [createProjectId, setCreateProjectId] = useState("");
	const [selectedSlug, setSelectedSlug] = useState("");
	const [registrySearch, setRegistrySearch] = useState("");
	const [addProjectId, setAddProjectId] = useState("");

	const { data: projects, error: projectsError } = useQuery({
		queryKey: ["projects"],
		queryFn: async () => unwrap(await api.GET("/api/projects")),
	});
	const { data: envs } = useQuery({
		queryKey: ["environments"],
		queryFn: async () => unwrap(await api.GET("/api/environments")),
	});
	const { data, isLoading, error } = useQuery({
		queryKey: ["vaults", "registry"],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/vault", {
					params: { query: { page_size: 200 } },
				}),
			),
	});

	const vaults = data?.items;
	const orderedProjects = useMemo(
		() => [...(projects ?? [])].filter((project) => project.id).sort(compareProjectsForUse),
		[projects],
	);
	const ownedProjects = useMemo(
		() => orderedProjects.filter((project) => isProjectOwner(project)),
		[orderedProjects],
	);
	const ownedProjectIds = useMemo(
		() => new Set(ownedProjects.map((project) => project.id)),
		[ownedProjects],
	);
	const projectsById = useMemo(
		() => new Map(orderedProjects.map((project) => [project.id, project])),
		[orderedProjects],
	);
	const agentsById = useMemo(() => new Map((envs ?? []).map((agent) => [agent.id, agent])), [envs]);

	const vaultCatalog = useMemo<VaultCatalogGroup[]>(() => {
		const bySlug = new Map<string, VaultCatalogEntry[]>();
		const projectRank = new Map(orderedProjects.map((project, index) => [project.id, index]));

		for (const vault of vaults ?? []) {
			const project = projectsById.get(vault.project_id);
			const entries = bySlug.get(vault.slug) ?? [];
			entries.push({
				vault,
				project,
				agent: project ? projectAgentFor(project, agentsById) : null,
				readOnly: !ownedProjectIds.has(vault.project_id),
			});
			bySlug.set(vault.slug, entries);
		}

		return [...bySlug.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([slug, entries]) => ({
				slug,
				entries: entries.sort((a, b) => {
					const rankA = projectRank.get(a.vault.project_id) ?? Number.MAX_SAFE_INTEGER;
					const rankB = projectRank.get(b.vault.project_id) ?? Number.MAX_SAFE_INTEGER;
					if (rankA !== rankB) return rankA - rankB;
					const nameA = a.project ? displayProjectName(a.project) : a.vault.project_id;
					const nameB = b.project ? displayProjectName(b.project) : b.vault.project_id;
					return nameA.localeCompare(nameB);
				}),
			}));
	}, [agentsById, orderedProjects, ownedProjectIds, projectsById, vaults]);

	const filteredCatalog = useMemo(() => {
		const query = registrySearch.trim().toLowerCase();
		if (!query) return vaultCatalog;
		return vaultCatalog.filter((group) => {
			if (group.slug.toLowerCase().includes(query)) return true;
			return group.entries.some((entry) => {
				const project = entry.project;
				return project
					? `${displayProjectName(project)} ${project.slug}`.toLowerCase().includes(query)
					: entry.vault.project_id.toLowerCase().includes(query);
			});
		});
	}, [registrySearch, vaultCatalog]);

	const selectedGroup =
		vaultCatalog.find((group) => group.slug === selectedSlug) ?? vaultCatalog[0] ?? null;
	const projectsAvailableForSelectedVault = useMemo(() => {
		if (!selectedGroup) return [];
		const selectedProjectIds = new Set(
			selectedGroup.entries.map((entry) => entry.vault.project_id),
		);
		return ownedProjects.filter((project) => project.id && !selectedProjectIds.has(project.id));
	}, [ownedProjects, selectedGroup]);
	const createProjectAlreadyHasSlug =
		!!newVaultSlug &&
		!!createProjectId &&
		vaultCatalog.some(
			(group) =>
				group.slug === newVaultSlug &&
				group.entries.some((entry) => entry.vault.project_id === createProjectId),
		);

	useEffect(() => {
		if (ownedProjects.length === 0) {
			if (createProjectId) setCreateProjectId("");
			return;
		}
		if (!ownedProjects.some((project) => project.id === createProjectId)) {
			setCreateProjectId(ownedProjects[0]?.id ?? "");
		}
	}, [createProjectId, ownedProjects]);

	useEffect(() => {
		if (vaultCatalog.length === 0) {
			if (selectedSlug) setSelectedSlug("");
			return;
		}
		if (!selectedSlug || !vaultCatalog.some((group) => group.slug === selectedSlug)) {
			setSelectedSlug(vaultCatalog[0]?.slug ?? "");
		}
	}, [selectedSlug, vaultCatalog]);

	useEffect(() => {
		if (projectsAvailableForSelectedVault.length === 0) {
			if (addProjectId) setAddProjectId("");
			return;
		}
		if (!projectsAvailableForSelectedVault.some((project) => project.id === addProjectId)) {
			setAddProjectId(projectsAvailableForSelectedVault[0]?.id ?? "");
		}
	}, [addProjectId, projectsAvailableForSelectedVault]);

	const createVault = useMutation({
		mutationFn: async ({ slug, projectId }: { slug: string; projectId: string }) =>
			unwrap(
				await api.POST("/api/vault", {
					params: { query: { project_id: projectId } },
					body: { slug, name: slug },
				}),
			),
		onSuccess: (_created, variables) => {
			setNewVaultSlug("");
			setSelectedSlug(variables.slug);
			queryClient.invalidateQueries({ queryKey: ["vaults"] });
			const project = projectsById.get(variables.projectId);
			const projectName = project ? displayProjectName(project) : "the selected Project";
			toast.success("Vault Created", { description: `Available in ${projectName}.` });
		},
		onError: (e) => toast.error("Failed to Create Vault", { description: errorMessage(e) }),
	});

	const addVaultToProject = useMutation({
		mutationFn: async ({ slug, projectId }: { slug: string; projectId: string }) =>
			unwrap(
				await api.POST("/api/vault", {
					params: { query: { project_id: projectId } },
					body: { slug, name: slug },
				}),
			),
		onSuccess: (_created, variables) => {
			setSelectedSlug(variables.slug);
			queryClient.invalidateQueries({ queryKey: ["vaults"] });
			const project = projectsById.get(variables.projectId);
			const projectName = project ? displayProjectName(project) : "the selected Project";
			toast.success("Project Added", {
				description: `${variables.slug} is available in ${projectName}.`,
			});
		},
		onError: (e) => toast.error("Failed to Add Project", { description: errorMessage(e) }),
	});

	const deleteVault = useMutation({
		mutationFn: async (vault: { slug: string; project_id: string }) =>
			unwrap(
				await api.DELETE("/api/vault/{slug}", {
					params: { path: { slug: vault.slug }, query: { project_id: vault.project_id } },
				}),
			),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vaults"] }),
		onError: (e) => toast.error("Failed to Remove Vault", { description: errorMessage(e) }),
	});

	return (
		<div className="mx-auto max-w-7xl space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Vaults"
				description={VAULTS_RESOURCE.managementDescription}
				actions={
					vaults ? (
						<Badge variant="secondary">
							{vaultCatalog.length} vault{vaultCatalog.length === 1 ? "" : "s"}
						</Badge>
					) : null
				}
			/>

			{error ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Failed to Load Vaults</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : null}
			{projectsError ? (
				<Alert>
					<AlertCircle />
					<AlertTitle>Project Access Unavailable</AlertTitle>
					<AlertDescription>
						Vault write actions are hidden until Project access can be verified. Refresh to retry.
					</AlertDescription>
				</Alert>
			) : null}

			<div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
				<div className="space-y-4">
					<CreateVaultPanel
						ownedProjects={ownedProjects}
						agents={envs ?? []}
						agentsById={agentsById}
						projectId={createProjectId}
						onProjectChange={setCreateProjectId}
						slug={newVaultSlug}
						onSlugChange={setNewVaultSlug}
						onSubmit={() => {
							if (
								!newVaultSlug ||
								!createProjectId ||
								createProjectAlreadyHasSlug ||
								createVault.isPending
							)
								return;
							createVault.mutate({ slug: newVaultSlug, projectId: createProjectId });
						}}
						isPending={createVault.isPending}
						isDuplicate={createProjectAlreadyHasSlug}
						onOpenExisting={() => setSelectedSlug(newVaultSlug)}
					/>

					<VaultRegistry
						vaults={filteredCatalog}
						totalCount={vaultCatalog.length}
						search={registrySearch}
						onSearchChange={setRegistrySearch}
						selectedSlug={selectedGroup?.slug ?? ""}
						onSelect={setSelectedSlug}
						isLoading={isLoading}
					/>
				</div>

				{isLoading ? (
					<VaultDetailSkeleton />
				) : selectedGroup ? (
					<VaultDetailPanel
						group={selectedGroup}
						addProjectOptions={projectsAvailableForSelectedVault}
						agents={envs ?? []}
						addProjectId={addProjectId}
						onAddProjectIdChange={setAddProjectId}
						onAddProject={() => {
							if (!selectedGroup || !addProjectId || addVaultToProject.isPending) return;
							addVaultToProject.mutate({ slug: selectedGroup.slug, projectId: addProjectId });
						}}
						isAddingProject={addVaultToProject.isPending}
						onRemove={(vault) =>
							deleteVault.mutate({ slug: vault.slug, project_id: vault.project_id })
						}
						isRemoving={deleteVault.isPending}
					/>
				) : (
					<EmptyState
						icon={Key}
						title="No vaults yet"
						description="Create a vault to store key names, then choose which Projects should be able to use it."
					/>
				)}
			</div>
		</div>
	);
}

function CreateVaultPanel({
	ownedProjects,
	agents,
	agentsById,
	projectId,
	onProjectChange,
	slug,
	onSlugChange,
	onSubmit,
	isPending,
	isDuplicate,
	onOpenExisting,
}: {
	ownedProjects: VaultProjectMetadata[];
	agents: ProjectAgentMetadata[];
	agentsById: ReadonlyMap<string, ProjectAgentMetadata>;
	projectId: string;
	onProjectChange: (value: string) => void;
	slug: string;
	onSlugChange: (value: string) => void;
	onSubmit: () => void;
	isPending: boolean;
	isDuplicate: boolean;
	onOpenExisting: () => void;
}) {
	const selectedProject = ownedProjects.find((project) => project.id === projectId) ?? null;
	return (
		<section className="rounded-lg border bg-card/60 p-4">
			<div className="space-y-1">
				<h2 className="text-sm font-semibold">Create Vault</h2>
				<p className="text-xs text-muted-foreground">
					Start with one Project. After it exists, add it to more Projects from the detail view.
				</p>
			</div>
			{ownedProjects.length > 0 ? (
				<form
					className="mt-4 grid gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						onSubmit();
					}}
				>
					{ownedProjects.length > 1 ? (
						<ProjectScopePicker
							projects={ownedProjects}
							agents={agents}
							value={projectId}
							onValueChange={onProjectChange}
							label="Initial Project"
							layout="stacked"
							disabled={!ownedProjects.length}
						/>
					) : selectedProject ? (
						<div className="grid gap-1.5">
							<Label className="text-xs font-medium">Initial Project</Label>
							<SelectedProjectTile project={selectedProject} agentsById={agentsById} />
						</div>
					) : null}
					<div className="grid gap-1.5">
						<Label htmlFor="new-vault-slug" className="text-xs font-medium">
							Vault name
						</Label>
						<Input
							id="new-vault-slug"
							name="new-vault-slug"
							value={slug}
							onChange={(e) => onSlugChange(normalizeVaultSlug(e.target.value))}
							placeholder="github"
							autoComplete="off"
							spellCheck={false}
						/>
						{isDuplicate ? (
							<p className="text-xs text-muted-foreground">
								This vault is already in the selected Project.{" "}
								<button
									type="button"
									onClick={onOpenExisting}
									className="font-medium text-foreground underline-offset-4 hover:underline"
								>
									Open it
								</button>
								, or choose another Project.
							</p>
						) : (
							<p className="text-xs text-muted-foreground">
								Use lowercase letters, numbers, and hyphens.
							</p>
						)}
					</div>
					<Button
						type="submit"
						disabled={!slug || !projectId || isDuplicate || isPending}
						variant={slug && projectId && !isDuplicate ? "default" : "outline"}
						className="w-full"
					>
						{isPending ? <Spinner /> : <Plus />}
						{isPending ? "Creating..." : "Create Vault"}
					</Button>
				</form>
			) : (
				<Alert className="mt-4">
					<AlertCircle />
					<AlertTitle>No Writable Projects</AlertTitle>
					<AlertDescription>
						You need Owner access to a Project before you can create vaults.
					</AlertDescription>
				</Alert>
			)}
		</section>
	);
}

function VaultRegistry({
	vaults,
	totalCount,
	search,
	onSearchChange,
	selectedSlug,
	onSelect,
	isLoading,
}: {
	vaults: VaultCatalogGroup[];
	totalCount: number;
	search: string;
	onSearchChange: (value: string) => void;
	selectedSlug: string;
	onSelect: (slug: string) => void;
	isLoading: boolean;
}) {
	return (
		<section className="rounded-lg border bg-card/60">
			<div className="border-b p-4">
				<div className="flex items-center justify-between gap-3">
					<div>
						<h2 className="text-sm font-semibold">Vault Registry</h2>
						<p className="text-xs text-muted-foreground">
							Choose a vault, then manage its Project availability.
						</p>
					</div>
					<Badge variant="secondary">{totalCount}</Badge>
				</div>
				<div className="relative mt-3">
					<Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={search}
						onChange={(event) => onSearchChange(event.target.value)}
						placeholder="Search vault or Project"
						className="pl-9"
					/>
				</div>
			</div>
			<div className="max-h-[640px] overflow-y-auto p-2">
				{isLoading ? (
					<div className="space-y-2 p-2">
						{Array.from({ length: 4 }).map((_, index) => (
							<Skeleton key={index} className="h-16 rounded-md" />
						))}
					</div>
				) : vaults.length > 0 ? (
					<div className="space-y-1">
						{vaults.map((group) => (
							<button
								key={group.slug}
								type="button"
								onClick={() => onSelect(group.slug)}
								className={cn(
									"flex w-full items-start gap-3 rounded-md border border-transparent px-3 py-3 text-left transition-colors hover:bg-muted/40",
									selectedSlug === group.slug && "border-border bg-muted/60",
								)}
							>
								<span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background/70 text-muted-foreground">
									<Key className="size-3.5" />
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate font-mono text-sm font-semibold" translate="no">
										{group.slug}
									</span>
									<span className="mt-1 block truncate text-xs text-muted-foreground">
										{projectSummary(group.entries)}
									</span>
								</span>
								<Badge variant="secondary" className="shrink-0">
									{group.entries.length}
								</Badge>
							</button>
						))}
					</div>
				) : (
					<p className="p-4 text-sm text-muted-foreground">
						{totalCount === 0 ? "No vaults created yet." : "No vaults match this search."}
					</p>
				)}
			</div>
		</section>
	);
}

function VaultDetailPanel({
	group,
	addProjectOptions,
	agents,
	addProjectId,
	onAddProjectIdChange,
	onAddProject,
	isAddingProject,
	onRemove,
	isRemoving,
}: {
	group: VaultCatalogGroup;
	addProjectOptions: VaultProjectMetadata[];
	agents: ProjectAgentMetadata[];
	addProjectId: string;
	onAddProjectIdChange: (value: string) => void;
	onAddProject: () => void;
	isAddingProject: boolean;
	onRemove: (vault: Vault) => void;
	isRemoving: boolean;
}) {
	return (
		<section className="overflow-hidden rounded-lg border bg-card/60">
			<div className="border-b p-5">
				<div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
					<div className="flex min-w-0 items-start gap-3">
						<span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-md border bg-background/70 text-muted-foreground">
							<Key className="size-5" />
						</span>
						<div className="min-w-0">
							<h2 className="truncate font-mono text-xl font-semibold" translate="no">
								{group.slug}
							</h2>
							<p className="mt-1 text-sm text-muted-foreground">
								Available in {group.entries.length} Project
								{group.entries.length === 1 ? "" : "s"}. Manage Project access here.
							</p>
						</div>
					</div>
					<Badge variant="secondary">
						{group.entries.length} Project{group.entries.length === 1 ? "" : "s"}
					</Badge>
				</div>
			</div>

			<div className="border-b bg-muted/15 p-4">
				<div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(280px,380px)_auto] xl:items-end">
					<div>
						<h3 className="text-sm font-semibold">Project Availability</h3>
						<p className="text-xs text-muted-foreground">
							Add this vault to another Project you own when an agent or workflow needs it.
						</p>
					</div>
					{addProjectOptions.length > 0 ? (
						<>
							<ProjectScopePicker
								projects={addProjectOptions}
								agents={agents}
								value={addProjectId}
								onValueChange={onAddProjectIdChange}
								label="Add Project"
								layout="stacked"
							/>
							<Button
								type="button"
								onClick={onAddProject}
								disabled={!addProjectId || isAddingProject}
								className="w-full xl:w-auto"
							>
								{isAddingProject ? <Spinner /> : <Plus />}
								Add Project
							</Button>
						</>
					) : (
						<p className="text-sm text-muted-foreground xl:col-span-2">
							This vault is already available in every Project you can edit.
						</p>
					)}
				</div>
			</div>

			<div className="divide-y">
				{group.entries.map((entry) => (
					<VaultProjectKeyPanel
						key={entry.vault.id}
						entry={entry}
						totalProjects={group.entries.length}
						onRemove={() => onRemove(entry.vault)}
						isRemoving={isRemoving}
					/>
				))}
			</div>
		</section>
	);
}

function SelectedProjectTile({
	project,
	agentsById,
}: {
	project: VaultProjectMetadata;
	agentsById: ReadonlyMap<string, ProjectAgentMetadata>;
}) {
	return (
		<div className="rounded-[10px] border border-border/80 bg-background/70 px-3 py-2.5">
			<ProjectIdentity
				project={project}
				agent={projectAgentFor(project, agentsById)}
				showOwner={false}
				showAccess={false}
				titleClassName="text-sm"
			/>
		</div>
	);
}

function VaultProjectKeyPanel({
	entry,
	totalProjects,
	onRemove,
	isRemoving,
}: {
	entry: VaultCatalogEntry;
	totalProjects: number;
	onRemove: () => void;
	isRemoving: boolean;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [adding, setAdding] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");
	const { vault, project, agent, readOnly } = entry;
	const fieldDomId = `${vault.slug}-${vault.project_id}`;
	const itemsCacheKey = ["vault-items", vault.slug, vault.project_id] as const;

	const { data: items } = useQuery({
		queryKey: itemsCacheKey,
		queryFn: async () =>
			unwrap(
				await api.GET("/api/vault/{slug}/items", {
					params: { path: { slug: vault.slug }, query: { project_id: vault.project_id } },
				}),
			),
	});

	const upsertItem = useMutation({
		mutationFn: async ({ section, key, value }: { section: string; key: string; value: string }) =>
			unwrap(
				await api.PUT("/api/vault/{slug}/items", {
					params: { path: { slug: vault.slug }, query: { project_id: vault.project_id } },
					body: { section, fields: { [key]: value } },
				}),
			),
		onSuccess: () => {
			setNewKey("");
			setNewValue("");
			setAdding(false);
			queryClient.invalidateQueries({ queryKey: itemsCacheKey });
		},
		onError: (e) => toast.error("Failed to Save Key", { description: errorMessage(e) }),
	});

	const deleteItem = useMutation({
		mutationFn: async ({ section, name }: { section: string; name: string }) =>
			unwrap(
				await api.DELETE("/api/vault/{slug}/items", {
					params: { path: { slug: vault.slug }, query: { project_id: vault.project_id } },
					body: { section, fields: [name] },
				}),
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: itemsCacheKey });
		},
		onError: (e) => toast.error("Failed to Delete Key", { description: errorMessage(e) }),
	});

	const allFields: VaultField[] = items
		? Object.entries(items).flatMap(([section, fields]) =>
				fields.map((field) => ({
					key: section === "(default)" ? field : `${section}/${field}`,
					name: field,
					section: section === "(default)" ? "" : section,
				})),
			)
		: [];

	const columns = useMemo<ColumnDef<VaultField>[]>(
		() => [
			{
				accessorKey: "key",
				header: "Key",
				cell: ({ row }) => <span className="font-mono text-xs">{row.original.key}</span>,
			},
			{
				id: "value",
				header: "Value",
				cell: () => <span className="font-mono text-xs text-muted-foreground">••••••••</span>,
				size: 120,
			},
			...(readOnly
				? []
				: [
						{
							id: "actions",
							header: "",
							cell: ({ row }) => (
								<Button
									variant="ghost"
									size="icon-sm"
									onClick={(event) => {
										event.stopPropagation();
										const ok = window.confirm(
											`Delete "${row.original.key}"?\n\nAnything that resolves this key will start failing.`,
										);
										if (ok)
											deleteItem.mutate({ section: row.original.section, name: row.original.name });
									}}
									disabled={deleteItem.isPending}
									className="text-muted-foreground hover:text-destructive"
									aria-label={`Delete ${row.original.key}`}
								>
									<Trash2 className="size-3.5" />
								</Button>
							),
							size: 40,
						} satisfies ColumnDef<VaultField>,
					]),
		],
		[deleteItem, readOnly],
	);

	const keyCountLabel = items
		? `${allFields.length} ${allFields.length === 1 ? "key" : "keys"}`
		: "Loading keys";
	const removeLabel = totalProjects > 1 ? "Remove Project" : "Delete Vault";

	return (
		<section className="space-y-3 p-4">
			<div className="group/header flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					{project ? (
						<ProjectIdentity
							project={project}
							agent={agent}
							showOwner={false}
							showAccess={!isProjectOwner(project)}
							titleClassName="text-sm"
						/>
					) : (
						<div className="min-w-0">
							<h3 className="text-sm font-semibold">Unknown Project</h3>
							<p className="truncate font-mono text-xs text-muted-foreground" translate="no">
								{vault.project_id}
							</p>
						</div>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
					<Badge variant="secondary">{keyCountLabel}</Badge>
					{readOnly ? (
						<Badge variant="outline" title="Viewer access is read-only.">
							Read-only
						</Badge>
					) : (
						<>
							<Button
								variant="ghost"
								size="xs"
								onClick={() => setAdding(!adding)}
								className="text-muted-foreground"
							>
								<Plus className="size-3.5" />
								Add Key
							</Button>
							<Button
								variant="ghost"
								size="xs"
								onClick={() => {
									const projectName = project ? displayProjectName(project) : "this Project";
									const ok = window.confirm(
										`${removeLabel}?\n\n${vault.slug} will no longer be available in ${projectName}. Keys in this Project entry will be removed.`,
									);
									if (ok) onRemove();
								}}
								disabled={isRemoving}
								className="text-muted-foreground hover:text-destructive sm:opacity-0 sm:group-hover/header:opacity-100 sm:focus-visible:opacity-100"
							>
								<Trash2 className="size-3.5" />
								{removeLabel}
							</Button>
						</>
					)}
				</div>
			</div>

			{!readOnly && adding ? (
				<div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed bg-muted/20 px-3 py-2">
					<Label htmlFor={`key-${fieldDomId}`} className="sr-only">
						Key name
					</Label>
					<Input
						id={`key-${fieldDomId}`}
						name={`key-${fieldDomId}`}
						value={newKey}
						onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
						placeholder="KEY_NAME"
						autoComplete="off"
						spellCheck={false}
						className="max-w-[220px] flex-1 font-mono"
					/>
					<Label htmlFor={`value-${fieldDomId}`} className="sr-only">
						Secret value
					</Label>
					<Input
						id={`value-${fieldDomId}`}
						name={`value-${fieldDomId}`}
						type="password"
						value={newValue}
						onChange={(e) => setNewValue(e.target.value)}
						placeholder="Secret value"
						autoComplete="off"
						className="flex-1"
						onKeyDown={(e) => {
							if (e.key === "Enter" && newKey && newValue)
								upsertItem.mutate({ section: "", key: newKey, value: newValue });
						}}
					/>
					<Button
						onClick={() =>
							newKey && newValue && upsertItem.mutate({ section: "", key: newKey, value: newValue })
						}
						disabled={!newKey || !newValue || upsertItem.isPending}
						size="sm"
					>
						{upsertItem.isPending ? <Spinner /> : <Plus />}
						Save Key
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => {
							setAdding(false);
							setNewKey("");
							setNewValue("");
						}}
						aria-label="Cancel"
					>
						<X />
					</Button>
				</div>
			) : null}

			{allFields.length > 0 ? (
				<DataTable columns={columns} data={allFields} />
			) : !adding ? (
				<p className="text-sm text-muted-foreground">
					{readOnly
						? "No key names are visible in this shared Project yet."
						: "No keys yet. Add the first key for this Project entry."}
				</p>
			) : null}
		</section>
	);
}

function VaultDetailSkeleton() {
	return (
		<section className="rounded-lg border bg-card/60 p-5">
			<Skeleton className="h-12 w-2/3" />
			<Skeleton className="mt-5 h-20 w-full" />
			<Skeleton className="mt-4 h-44 w-full" />
		</section>
	);
}

function normalizeVaultSlug(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function projectSummary(entries: VaultCatalogEntry[]) {
	const names = entries.map((entry) =>
		entry.project ? displayProjectName(entry.project) : "Unknown Project",
	);
	if (names.length <= 2) return names.join(", ");
	return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}
