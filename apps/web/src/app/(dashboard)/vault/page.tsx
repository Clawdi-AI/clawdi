"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertCircle, Key, Plus, Search, Trash2, X } from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
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
import { errorMessage } from "@/lib/utils";

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

interface VaultCatalogView extends VaultCatalogGroup {
	visibleEntries: VaultCatalogEntry[];
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
	const [searchQuery, setSearchQuery] = useState("");
	const [projectFilter, setProjectFilter] = useQueryState(
		"project",
		parseAsString.withDefault("all").withOptions({ clearOnDefault: true, history: "replace" }),
	);

	const { data: projects, error: projectsError } = useQuery({
		queryKey: ["projects"],
		queryFn: async () => unwrap(await api.GET("/api/projects")),
	});
	const { data: envs } = useQuery({
		queryKey: ["environments"],
		queryFn: async () => unwrap(await api.GET("/api/environments")),
	});
	const { data, isLoading, error } = useQuery({
		queryKey: ["vaults", "all"],
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
	const filterProjectId = projectFilter === "all" ? null : projectFilter;
	const filterProject = filterProjectId ? (projectsById.get(filterProjectId) ?? null) : null;
	const isStaleProjectFilter = !!filterProjectId && projects !== undefined && !filterProject;

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

	const visibleVaultCatalog = useMemo<VaultCatalogView[]>(() => {
		const query = searchQuery.trim().toLowerCase();
		return vaultCatalog
			.map((group) => {
				const visibleEntries = filterProjectId
					? group.entries.filter((entry) => entry.vault.project_id === filterProjectId)
					: group.entries;
				return { ...group, visibleEntries };
			})
			.filter((group) => group.visibleEntries.length > 0)
			.filter((group) => {
				if (!query) return true;
				if (group.slug.toLowerCase().includes(query)) return true;
				return group.entries.some((entry) => {
					const project = entry.project;
					return project
						? `${displayProjectName(project)} ${project.slug}`.toLowerCase().includes(query)
						: entry.vault.project_id.toLowerCase().includes(query);
				});
			});
	}, [filterProjectId, searchQuery, vaultCatalog]);

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
		const filterProjectIsWritable =
			!!filterProjectId && ownedProjects.some((project) => project.id === filterProjectId);
		const nextProjectId = filterProjectIsWritable ? filterProjectId : (ownedProjects[0]?.id ?? "");
		if (createProjectId !== nextProjectId) setCreateProjectId(nextProjectId);
	}, [createProjectId, filterProjectId, ownedProjects]);

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
			setSearchQuery(variables.slug);
			void setProjectFilter(variables.projectId);
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
			setSearchQuery(variables.slug);
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
			{isStaleProjectFilter ? (
				<Alert>
					<AlertCircle />
					<AlertTitle>Project Unavailable</AlertTitle>
					<AlertDescription>
						This vault view points to a Project you can no longer access. Pick another Project.
					</AlertDescription>
				</Alert>
			) : null}

			<CreateVaultPanel
				ownedProjects={ownedProjects}
				agents={envs ?? []}
				agentsById={agentsById}
				projectId={createProjectId}
				onProjectChange={setCreateProjectId}
				slug={newVaultSlug}
				onSlugChange={setNewVaultSlug}
				onSubmit={() => {
					if (!newVaultSlug || !createProjectId || createProjectAlreadyHasSlug) return;
					createVault.mutate({ slug: newVaultSlug, projectId: createProjectId });
				}}
				isPending={createVault.isPending}
				isDuplicate={createProjectAlreadyHasSlug}
				onOpenExisting={() => {
					setSearchQuery(newVaultSlug);
					void setProjectFilter("all");
				}}
			/>

			<section className="space-y-3">
				<div className="rounded-lg border bg-card/60 p-4">
					<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)_minmax(220px,320px)] lg:items-end">
						<div className="space-y-1">
							<h2 className="text-base font-semibold">Vaults</h2>
							<p className="text-sm text-muted-foreground">
								{filterProject
									? `Showing vaults available in ${displayProjectName(filterProject)}.`
									: "Each vault shows the Projects where agents can use it."}
							</p>
						</div>
						<ProjectScopePicker
							projects={orderedProjects}
							agents={envs ?? []}
							value={projectFilter}
							onValueChange={(value) => void setProjectFilter(value)}
							allowAll
							allLabel="All Projects"
							allDescription="Every vault you can read"
							label="Show"
							layout="stacked"
							disabled={!orderedProjects.length}
							triggerClassName="min-h-14 py-2"
						/>
						<div className="grid gap-1.5">
							<Label htmlFor="vault-search" className="text-xs font-medium">
								Search
							</Label>
							<div className="relative">
								<Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									id="vault-search"
									value={searchQuery}
									onChange={(event) => setSearchQuery(event.target.value)}
									placeholder="Vault or Project"
									className="pl-9"
								/>
							</div>
						</div>
					</div>
				</div>

				{isLoading ? (
					<div className="space-y-3">
						{Array.from({ length: 3 }).map((_, index) => (
							<div key={index} className="rounded-lg border bg-card/60 p-4">
								<Skeleton className="h-14 w-full" />
								<Skeleton className="mt-3 h-28 w-full" />
							</div>
						))}
					</div>
				) : visibleVaultCatalog.length > 0 ? (
					<div className="space-y-3">
						{visibleVaultCatalog.map((group) => (
							<VaultGroupCard
								key={group.slug}
								group={group}
								ownedProjects={ownedProjects}
								agents={envs ?? []}
								onAddProject={(projectId) =>
									addVaultToProject.mutate({ slug: group.slug, projectId })
								}
								isAddingProject={addVaultToProject.isPending}
								onRemove={(vault) =>
									deleteVault.mutate({ slug: vault.slug, project_id: vault.project_id })
								}
								isRemoving={deleteVault.isPending}
							/>
						))}
					</div>
				) : (
					<EmptyState
						icon={Key}
						title={vaultCatalog.length === 0 ? "No vaults yet" : "No vaults match this view"}
						description={
							vaultCatalog.length === 0
								? "Create a vault above, then add keys for each Project that should use it."
								: "Change the Project filter or search term to see more vaults."
						}
					/>
				)}
			</section>
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
			<div className="grid gap-4 xl:grid-cols-[minmax(220px,1fr)_minmax(280px,380px)_minmax(220px,1fr)_auto] xl:items-start">
				<div className="space-y-1">
					<h2 className="text-sm font-semibold">Create Vault</h2>
					<p className="text-xs text-muted-foreground">
						Pick the first Project that can use this vault. You can add more Projects later.
					</p>
				</div>
				{ownedProjects.length > 0 ? (
					<>
						{ownedProjects.length > 1 ? (
							<ProjectScopePicker
								projects={ownedProjects}
								agents={agents}
								value={projectId}
								onValueChange={onProjectChange}
								label="Project"
								layout="stacked"
								disabled={!ownedProjects.length}
								triggerClassName="min-h-14 py-2"
							/>
						) : selectedProject ? (
							<div className="grid gap-1.5">
								<Label className="text-xs font-medium">Project</Label>
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
									This vault already exists in the selected Project.{" "}
									<button
										type="button"
										onClick={onOpenExisting}
										className="font-medium text-foreground underline-offset-4 hover:underline"
									>
										Show it
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
							type="button"
							disabled={!slug || !projectId || isDuplicate || isPending}
							variant={slug && projectId && !isDuplicate ? "default" : "outline"}
							className="w-full xl:mt-5 xl:w-auto"
							onClick={onSubmit}
						>
							{isPending ? <Spinner /> : <Plus />}
							{isPending ? "Creating..." : "Create"}
						</Button>
					</>
				) : (
					<Alert className="xl:col-span-3">
						<AlertCircle />
						<AlertTitle>No Writable Projects</AlertTitle>
						<AlertDescription>
							You need Owner access to a Project before you can create vaults.
						</AlertDescription>
					</Alert>
				)}
			</div>
		</section>
	);
}

function VaultGroupCard({
	group,
	ownedProjects,
	agents,
	onAddProject,
	isAddingProject,
	onRemove,
	isRemoving,
}: {
	group: VaultCatalogView;
	ownedProjects: VaultProjectMetadata[];
	agents: ProjectAgentMetadata[];
	onAddProject: (projectId: string) => void;
	isAddingProject: boolean;
	onRemove: (vault: Vault) => void;
	isRemoving: boolean;
}) {
	const usedProjectIds = useMemo(
		() => new Set(group.entries.map((entry) => entry.vault.project_id)),
		[group.entries],
	);
	const addProjectOptions = useMemo(
		() => ownedProjects.filter((project) => project.id && !usedProjectIds.has(project.id)),
		[ownedProjects, usedProjectIds],
	);
	return (
		<section className="overflow-hidden rounded-lg border bg-card/60">
			<div className="border-b p-4">
				<div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
					<div className="flex min-w-0 items-start gap-3">
						<span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border bg-background/70 text-muted-foreground">
							<Key className="size-4.5" />
						</span>
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-2">
								<h3 className="truncate font-mono text-lg font-semibold" translate="no">
									{group.slug}
								</h3>
								<Badge variant="secondary">
									{group.entries.length} Project{group.entries.length === 1 ? "" : "s"}
								</Badge>
							</div>
							<div className="mt-2 flex flex-wrap gap-1.5">
								{group.entries.map((entry) => (
									<ProjectChip key={entry.vault.id} entry={entry} />
								))}
							</div>
						</div>
					</div>
					<AddProjectToVaultControl
						options={addProjectOptions}
						agents={agents}
						onAddProject={onAddProject}
						isPending={isAddingProject}
					/>
				</div>
			</div>
			<div className="divide-y">
				{group.visibleEntries.map((entry) => (
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

function AddProjectToVaultControl({
	options,
	agents,
	onAddProject,
	isPending,
}: {
	options: VaultProjectMetadata[];
	agents: ProjectAgentMetadata[];
	onAddProject: (projectId: string) => void;
	isPending: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [projectId, setProjectId] = useState("");
	useEffect(() => {
		if (options.length === 0) {
			if (projectId) setProjectId("");
			if (open) setOpen(false);
			return;
		}
		if (!options.some((project) => project.id === projectId)) {
			setProjectId(options[0]?.id ?? "");
		}
	}, [open, options, projectId]);

	if (options.length === 0) return null;
	if (!open) {
		return (
			<Button
				type="button"
				size="sm"
				variant="outline"
				onClick={() => setOpen(true)}
				className="w-fit justify-self-start lg:justify-self-end"
			>
				<Plus />
				Add Project
			</Button>
		);
	}
	return (
		<div className="grid justify-self-stretch gap-2 sm:grid-cols-[minmax(260px,340px)_auto_auto] sm:items-end lg:justify-self-end">
			<ProjectScopePicker
				projects={options}
				agents={agents}
				value={projectId}
				onValueChange={setProjectId}
				label="Add to Project"
				layout="stacked"
				triggerClassName="min-h-12 py-2"
			/>
			<Button
				type="button"
				size="sm"
				disabled={!projectId || isPending}
				onClick={() => {
					if (!projectId) return;
					onAddProject(projectId);
					setOpen(false);
				}}
				className="w-full sm:w-auto"
			>
				{isPending ? <Spinner /> : <Plus />}
				Add
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				onClick={() => setOpen(false)}
				aria-label="Cancel adding project"
			>
				<X />
			</Button>
		</div>
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

function ProjectChip({ entry }: { entry: VaultCatalogEntry }) {
	if (!entry.project) {
		return (
			<Badge variant="outline" className="text-xs">
				Unknown Project
			</Badge>
		);
	}
	return (
		<Badge
			variant="outline"
			className="max-w-full gap-1.5 text-xs"
			title={displayProjectName(entry.project)}
		>
			<span className="truncate">{displayProjectName(entry.project)}</span>
			{entry.readOnly ? <span className="text-muted-foreground">Viewer</span> : null}
		</Badge>
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
	const removeLabel = totalProjects > 1 ? "Remove from Project" : "Delete Vault";

	return (
		<section className="space-y-3 p-4">
			<div className="group/header flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
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
							<h4 className="text-sm font-semibold">Unknown Project</h4>
							<p className="truncate font-mono text-xs text-muted-foreground" translate="no">
								{vault.project_id}
							</p>
						</div>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-1.5 md:justify-end">
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
								size="icon-sm"
								onClick={() => {
									const projectName = project ? displayProjectName(project) : "this Project";
									const ok = window.confirm(
										`${removeLabel}?\n\n${vault.slug} will no longer be available in ${projectName}. Keys in this Project entry will be removed.`,
									);
									if (ok) onRemove();
								}}
								disabled={isRemoving}
								className="text-muted-foreground hover:text-destructive md:opacity-0 md:group-hover/header:opacity-100 md:focus-visible:opacity-100"
								aria-label={removeLabel}
								title={removeLabel}
							>
								<Trash2 className="size-3.5" />
							</Button>
						</>
					)}
				</div>
			</div>

			{!readOnly && adding ? (
				<div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed bg-muted/20 px-3 py-2 sm:ml-9">
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
				<div className="sm:pl-9">
					<DataTable columns={columns} data={allFields} />
				</div>
			) : !adding ? (
				<p className="text-sm text-muted-foreground sm:pl-9">
					{readOnly
						? "No key names are visible in this shared Project yet."
						: "No keys yet. Add the first key for this Project."}
				</p>
			) : null}
		</section>
	);
}

function normalizeVaultSlug(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9-]/g, "");
}
