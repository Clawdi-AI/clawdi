"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertCircle, Key, Lock, Plus, Trash2, X } from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	DashboardSection,
	DashboardSectionHeader,
	DashboardSectionToolbar,
} from "@/components/dashboard/section";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import {
	compareProjectsForUse,
	displayProjectName,
	isProjectOwner,
	type ProjectAgentMetadata,
	ProjectCompactPicker,
	ProjectIdentity,
	ProjectScopePicker,
	projectAgentFor,
} from "@/components/projects/project-metadata";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { DataTable } from "@/components/ui/data-table";
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
import { VaultKeyImportDialog } from "@/components/vault/key-import";
import type { KeyImportSummary } from "@/components/vault/key-import-parse";
import { unwrap, useApi } from "@/lib/api";
import { fetchAllPages } from "@/lib/api-pagination";
import type { Vault, VaultItems } from "@/lib/api-schemas";
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

interface VaultAttachmentView {
	projectId: string;
	project?: VaultProjectMetadata;
	agent: ProjectAgentMetadata | null;
	readOnly: boolean;
}

interface VaultCatalogView {
	vault: Vault;
	attachments: VaultAttachmentView[];
	visibleAttachments: VaultAttachmentView[];
}

const VAULTS_RESOURCE = getProjectResourceDefinition("vaults");
const VAULT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;

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
	const [createDialogOpen, setCreateDialogOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useQueryState(
		"search",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true, history: "replace" }),
	);
	const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);
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
			fetchAllPages<Vault>(
				async (page, pageSize) =>
					unwrap(
						await api.GET("/api/vault", {
							params: { query: { page, page_size: pageSize } },
						}),
					),
				{ pageSize: 200, resourceName: "vaults" },
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
	const projectsById = useMemo(
		() => new Map(orderedProjects.map((project) => [project.id, project])),
		[orderedProjects],
	);
	const agentsById = useMemo(() => new Map((envs ?? []).map((agent) => [agent.id, agent])), [envs]);
	const filterProjectId = projectFilter === "all" ? null : projectFilter;
	const filterProject = filterProjectId ? (projectsById.get(filterProjectId) ?? null) : null;
	const isStaleProjectFilter = !!filterProjectId && projects !== undefined && !filterProject;

	const vaultCatalog = useMemo<VaultCatalogView[]>(() => {
		const projectRank = new Map(orderedProjects.map((project, index) => [project.id, index]));

		return [...(vaults ?? [])]
			.sort((a, b) => a.slug.localeCompare(b.slug))
			.map((vault) => {
				const attachments = vault.project_ids
					.map((projectId) => {
						const project = projectsById.get(projectId);
						return {
							projectId,
							project,
							agent: project ? projectAgentFor(project, agentsById) : null,
							readOnly: !isProjectOwner(project ?? { is_owner: false }),
						};
					})
					.sort((a, b) => {
						const rankA = projectRank.get(a.projectId) ?? Number.MAX_SAFE_INTEGER;
						const rankB = projectRank.get(b.projectId) ?? Number.MAX_SAFE_INTEGER;
						if (rankA !== rankB) return rankA - rankB;
						const nameA = a.project ? displayProjectName(a.project) : a.projectId;
						const nameB = b.project ? displayProjectName(b.project) : b.projectId;
						return nameA.localeCompare(nameB);
					});
				return { vault, attachments, visibleAttachments: attachments };
			});
	}, [agentsById, orderedProjects, projectsById, vaults]);

	const visibleVaultCatalog = useMemo<VaultCatalogView[]>(() => {
		const query = searchQuery.trim().toLowerCase();
		return vaultCatalog
			.map((entry) => {
				const visibleAttachments = filterProjectId
					? entry.attachments.filter((attachment) => attachment.projectId === filterProjectId)
					: entry.attachments;
				return { ...entry, visibleAttachments };
			})
			.filter((entry) => !filterProjectId || entry.visibleAttachments.length > 0)
			.filter((entry) => {
				if (!query) return true;
				if (entry.vault.slug.toLowerCase().includes(query)) return true;
				if (entry.vault.name.toLowerCase().includes(query)) return true;
				return entry.attachments.some((attachment) => {
					const project = attachment.project;
					return project
						? `${displayProjectName(project)} ${project.slug}`.toLowerCase().includes(query)
						: attachment.projectId.toLowerCase().includes(query);
				});
			});
	}, [filterProjectId, searchQuery, vaultCatalog]);

	const ownedVaultCatalog = useMemo(
		() => visibleVaultCatalog.filter((entry) => entry.vault.is_owner),
		[visibleVaultCatalog],
	);
	const sharedVaultCatalog = useMemo(
		() => visibleVaultCatalog.filter((entry) => !entry.vault.is_owner),
		[visibleVaultCatalog],
	);
	const selectedVault = useMemo(
		() => visibleVaultCatalog.find((entry) => entry.vault.id === selectedVaultId) ?? null,
		[visibleVaultCatalog, selectedVaultId],
	);
	const isNewVaultSlugValid = isValidVaultSlug(newVaultSlug);
	const createProjectAlreadyHasSlug =
		!!newVaultSlug &&
		vaultCatalog.some((entry) => entry.vault.is_owner && entry.vault.slug === newVaultSlug);

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

	useEffect(() => {
		if (visibleVaultCatalog.length === 0) {
			if (selectedVaultId) setSelectedVaultId(null);
			return;
		}
		if (
			!selectedVaultId ||
			!visibleVaultCatalog.some((entry) => entry.vault.id === selectedVaultId)
		) {
			setSelectedVaultId(ownedVaultCatalog[0]?.vault.id ?? sharedVaultCatalog[0]?.vault.id ?? null);
		}
	}, [ownedVaultCatalog, selectedVaultId, sharedVaultCatalog, visibleVaultCatalog]);

	const createVault = useMutation({
		mutationFn: async ({ slug, projectId }: { slug: string; projectId: string }) =>
			unwrap(
				await api.POST("/api/vault", {
					params: { query: { project_id: projectId } },
					body: { slug, name: slug },
				}),
			),
		onSuccess: async (_created, variables) => {
			setNewVaultSlug("");
			setCreateDialogOpen(false);
			setSearchQuery(variables.slug);
			void setProjectFilter(variables.projectId);
			await queryClient.invalidateQueries({ queryKey: ["vaults"] });
			const project = projectsById.get(variables.projectId);
			const projectName = project ? displayProjectName(project) : "the selected Project";
			toast.success("Vault Created", { description: `Added to ${projectName}.` });
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
		onSuccess: async (_created, variables) => {
			setSearchQuery(variables.slug);
			await queryClient.invalidateQueries({ queryKey: ["vaults"] });
			const project = projectsById.get(variables.projectId);
			const projectName = project ? displayProjectName(project) : "the selected Project";
			toast.success("Vault Added to Project", {
				description: `${variables.slug} is now available in ${projectName}.`,
			});
		},
		onError: (e) => toast.error("Failed to Add to Project", { description: errorMessage(e) }),
	});

	const detachVaultProject = useMutation({
		mutationFn: async (vault: { slug: string; projectId: string }) =>
			unwrap(
				await api.DELETE("/api/vault/{slug}", {
					params: { path: { slug: vault.slug }, query: { project_id: vault.projectId } },
				}),
			),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["vaults"] });
			toast.success("Vault Removed from Project");
		},
		onError: (e) => toast.error("Failed to Remove from Project", { description: errorMessage(e) }),
	});

	const deleteVault = useMutation({
		mutationFn: async (vault: { slug: string }) =>
			unwrap(
				await api.DELETE("/api/vault/{slug}", {
					params: { path: { slug: vault.slug }, query: {} },
				}),
			),
		onSuccess: async (_result, variables) => {
			await queryClient.invalidateQueries({ queryKey: ["vaults"] });
			queryClient.removeQueries({ queryKey: ["vault-items"] });
			toast.success("Vault Deleted", {
				description: `${variables.slug} and its keys were removed.`,
			});
		},
		onError: (e) => toast.error("Failed to Delete Vault", { description: errorMessage(e) }),
	});

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader title="Vaults" description={VAULTS_RESOURCE.managementDescription} />

			<Alert>
				<Lock className="size-4" />
				<AlertTitle>Vault Privacy</AlertTitle>
				<AlertDescription>
					A Vault is a shared bundle of API keys and secrets. Add a Vault to each Project where
					members or agents should use those keys. Project members can see Vault names and key names
					in the dashboard and resolve values through CLI runtime reads.
				</AlertDescription>
			</Alert>

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
					<AlertTitle>Project List Unavailable</AlertTitle>
					<AlertDescription>
						Vault write actions are hidden until we can reload your Project list. Please refresh or
						try again later.
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

			<CreateVaultDialog
				open={createDialogOpen}
				onOpenChange={setCreateDialogOpen}
				ownedProjects={ownedProjects}
				agents={envs ?? []}
				agentsById={agentsById}
				projectId={createProjectId}
				onProjectChange={setCreateProjectId}
				slug={newVaultSlug}
				onSlugChange={setNewVaultSlug}
				isSlugValid={isNewVaultSlugValid}
				onSubmit={() => {
					if (!isNewVaultSlugValid || !createProjectId || createProjectAlreadyHasSlug) return;
					createVault.mutate({ slug: newVaultSlug, projectId: createProjectId });
				}}
				isPending={createVault.isPending}
				isDuplicate={createProjectAlreadyHasSlug}
				onOpenExisting={() => {
					setSearchQuery(newVaultSlug);
					void setProjectFilter("all");
					setCreateDialogOpen(false);
				}}
			/>

			<DashboardSection>
				<DashboardSectionHeader
					icon={Key}
					title="Vault Inventory"
					count={
						vaults
							? `${ownedVaultCatalog.length} mine · ${sharedVaultCatalog.length} shared`
							: undefined
					}
					description={
						filterProject
							? `Showing Vaults available in ${displayProjectName(filterProject)}.`
							: "My Vaults are editable. Vaults shared by other users are read-only."
					}
				/>
				<DashboardSectionToolbar>
					<div className="grid gap-2 lg:grid-cols-[minmax(260px,360px)_minmax(220px,1fr)_auto] lg:items-center">
						<ProjectCompactPicker
							projects={orderedProjects}
							agents={envs ?? []}
							value={projectFilter}
							onValueChange={(value) => void setProjectFilter(value)}
							allowAll
							allLabel="All Projects"
							allDescription="Show every Vault you can read"
							disabled={!orderedProjects.length}
						/>
						<SearchInput
							value={searchQuery}
							onChange={(value) => void setSearchQuery(value)}
							placeholder="Search vaults…"
							className="w-full"
						/>
						<Button
							type="button"
							size="sm"
							onClick={() => setCreateDialogOpen(true)}
							disabled={ownedProjects.length === 0}
							className="h-9 w-full lg:w-auto"
						>
							<Plus />
							Create Vault
						</Button>
					</div>
				</DashboardSectionToolbar>

				{isLoading ? (
					<div className="grid xl:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
						<div className="p-4 xl:border-r">
							<Skeleton className="h-6 w-32" />
							<Skeleton className="mt-4 h-16 w-full" />
							<Skeleton className="mt-3 h-16 w-full" />
						</div>
						<div className="p-4">
							<Skeleton className="h-16 w-full" />
							<Skeleton className="mt-4 h-52 w-full" />
						</div>
					</div>
				) : visibleVaultCatalog.length > 0 ? (
					<div className="grid xl:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
						<VaultInventoryList
							ownedEntries={ownedVaultCatalog}
							sharedEntries={sharedVaultCatalog}
							selectedVaultId={selectedVault?.vault.id ?? null}
							onSelect={setSelectedVaultId}
						/>
						{selectedVault ? (
							<VaultDetailPanel
								entry={selectedVault}
								ownedProjects={ownedProjects}
								agents={envs ?? []}
								onAddProject={(projectId) =>
									addVaultToProject.mutateAsync({ slug: selectedVault.vault.slug, projectId })
								}
								isAddingProject={addVaultToProject.isPending}
								onDetachProject={(projectId) =>
									detachVaultProject.mutate({ slug: selectedVault.vault.slug, projectId })
								}
								isDetachingProject={detachVaultProject.isPending}
								detachingProjectId={detachVaultProject.variables?.projectId ?? null}
								onDeleteVault={() => deleteVault.mutate({ slug: selectedVault.vault.slug })}
								isDeletingVault={deleteVault.isPending}
							/>
						) : null}
					</div>
				) : (
					<div className="p-6">
						<EmptyState
							icon={Key}
							title={vaultCatalog.length === 0 ? "No vaults yet" : "No vaults match this view"}
							description={
								vaultCatalog.length === 0
									? "Create a vault, add it to a Project, then add the keys that agents should use."
									: "Change the Project filter or search term to see more vaults."
							}
						/>
					</div>
				)}
			</DashboardSection>
		</div>
	);
}

function CreateVaultDialog({
	open,
	onOpenChange,
	ownedProjects,
	agents,
	agentsById,
	projectId,
	onProjectChange,
	slug,
	onSlugChange,
	isSlugValid,
	onSubmit,
	isPending,
	isDuplicate,
	onOpenExisting,
}: {
	open: boolean;
	onOpenChange: (value: boolean) => void;
	ownedProjects: VaultProjectMetadata[];
	agents: ProjectAgentMetadata[];
	agentsById: ReadonlyMap<string, ProjectAgentMetadata>;
	projectId: string;
	onProjectChange: (value: string) => void;
	slug: string;
	onSlugChange: (value: string) => void;
	isSlugValid: boolean;
	onSubmit: () => void;
	isPending: boolean;
	isDuplicate: boolean;
	onOpenExisting: () => void;
}) {
	const selectedProject = ownedProjects.find((project) => project.id === projectId) ?? null;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Create Vault</DialogTitle>
					<DialogDescription>
						Create the Vault once, then add it to each Project where agents should use those keys.
						Start with one Project here.
					</DialogDescription>
				</DialogHeader>
				{ownedProjects.length > 0 ? (
					<div className="grid gap-4">
						{ownedProjects.length > 1 ? (
							<ProjectScopePicker
								projects={ownedProjects}
								agents={agents}
								value={projectId}
								onValueChange={onProjectChange}
								label="Add to Project"
								layout="stacked"
								disabled={!ownedProjects.length}
								triggerClassName="min-h-14 py-2"
							/>
						) : selectedProject ? (
							<div className="grid gap-1.5">
								<Label className="text-xs font-medium">Add to Project</Label>
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
								placeholder="github…"
								autoComplete="off"
								spellCheck={false}
							/>
							{isDuplicate ? (
								<p className="text-xs text-muted-foreground">
									This vault already exists.{" "}
									<button
										type="button"
										onClick={onOpenExisting}
										className="font-medium text-foreground underline-offset-4 hover:underline"
									>
										Show it
									</button>
									, then use Add to Project if another Project needs it.
								</p>
							) : (
								<p className="text-xs text-muted-foreground">
									Use lowercase letters, numbers, and hyphens. Names cannot start or end with a
									hyphen.
								</p>
							)}
						</div>
					</div>
				) : (
					<Alert>
						<AlertCircle />
						<AlertTitle>No Writable Projects</AlertTitle>
						<AlertDescription>
							You need Owner access to a Project before you can create vaults.
						</AlertDescription>
					</Alert>
				)}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={isPending}
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={
							!isSlugValid || !projectId || isDuplicate || isPending || ownedProjects.length === 0
						}
						onClick={onSubmit}
					>
						{isPending ? <Spinner /> : <Plus />}
						{isPending ? "Creating…" : "Create Vault"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function VaultInventoryList({
	ownedEntries,
	sharedEntries,
	selectedVaultId,
	onSelect,
}: {
	ownedEntries: VaultCatalogView[];
	sharedEntries: VaultCatalogView[];
	selectedVaultId: string | null;
	onSelect: (vaultId: string) => void;
}) {
	return (
		<aside className="overflow-hidden border-b bg-background/20 xl:border-r xl:border-b-0">
			<div className="border-b p-4">
				<h3 className="text-sm font-semibold">Vaults</h3>
				<p className="mt-1 text-xs text-muted-foreground">
					Select a Vault to review its keys and Project availability.
				</p>
			</div>
			<div className="divide-y">
				<VaultInventorySection
					title="My Vaults"
					count={ownedEntries.length}
					emptyText="No editable vaults in this view."
					entries={ownedEntries}
					selectedVaultId={selectedVaultId}
					onSelect={onSelect}
				/>
				<VaultInventorySection
					title="Shared by Others"
					count={sharedEntries.length}
					emptyText="No read-only vaults in this view."
					entries={sharedEntries}
					selectedVaultId={selectedVaultId}
					onSelect={onSelect}
				/>
			</div>
		</aside>
	);
}

function VaultInventorySection({
	title,
	count,
	emptyText,
	entries,
	selectedVaultId,
	onSelect,
}: {
	title: string;
	count: number;
	emptyText: string;
	entries: VaultCatalogView[];
	selectedVaultId: string | null;
	onSelect: (vaultId: string) => void;
}) {
	return (
		<section className="p-3">
			<div className="mb-2 flex items-center justify-between gap-2 px-1">
				<h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
				<Badge variant="secondary" className="text-xs">
					{count}
				</Badge>
			</div>
			{entries.length > 0 ? (
				<div className="space-y-1.5">
					{entries.map((entry) => (
						<VaultInventoryRow
							key={entry.vault.id}
							entry={entry}
							selected={entry.vault.id === selectedVaultId}
							onSelect={() => onSelect(entry.vault.id)}
						/>
					))}
				</div>
			) : (
				<p className="px-1 py-3 text-sm text-muted-foreground">{emptyText}</p>
			)}
		</section>
	);
}

function VaultInventoryRow({
	entry,
	selected,
	onSelect,
}: {
	entry: VaultCatalogView;
	selected: boolean;
	onSelect: () => void;
}) {
	const { vault, visibleAttachments, attachments } = entry;
	const attachmentLabel =
		visibleAttachments.length === 1
			? attachmentName(visibleAttachments[0])
			: `Used by ${visibleAttachments.length || attachments.length} Projects`;
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-pressed={selected}
			className={cn(
				"flex w-full items-start gap-3 rounded-md border border-transparent px-3 py-2.5 text-left transition-colors",
				"hover:border-border hover:bg-muted/30",
				!vault.is_owner && "border-l-2 border-l-muted-foreground/40 bg-muted/10",
				selected && "border-border bg-background shadow-xs",
			)}
		>
			<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-background/70 text-muted-foreground">
				{vault.is_owner ? <Key className="size-4" /> : <Lock className="size-4" />}
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate text-sm font-semibold" translate="no">
						{vault.name || vault.slug}
					</span>
					<VaultAccessBadge isOwner={vault.is_owner} compact />
				</span>
				<span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
					<span className="truncate font-mono" translate="no">
						{vault.slug}
					</span>
					<span className="shrink-0">·</span>
					<span className="truncate">{attachmentLabel}</span>
				</span>
			</span>
		</button>
	);
}

function VaultDetailPanel({
	entry,
	ownedProjects,
	agents,
	onAddProject,
	isAddingProject,
	onDetachProject,
	isDetachingProject,
	detachingProjectId,
	onDeleteVault,
	isDeletingVault,
}: {
	entry: VaultCatalogView;
	ownedProjects: VaultProjectMetadata[];
	agents: ProjectAgentMetadata[];
	onAddProject: (projectId: string) => Promise<unknown>;
	isAddingProject: boolean;
	onDetachProject: (projectId: string) => void;
	isDetachingProject: boolean;
	detachingProjectId: string | null;
	onDeleteVault: () => void;
	isDeletingVault: boolean;
}) {
	const { vault, attachments, visibleAttachments } = entry;
	const canManageVault = vault.is_owner;
	const usedProjectIds = useMemo(() => new Set(vault.project_ids), [vault.project_ids]);
	const addProjectOptions = useMemo(
		() =>
			canManageVault
				? ownedProjects.filter((project) => project.id && !usedProjectIds.has(project.id))
				: [],
		[canManageVault, ownedProjects, usedProjectIds],
	);
	const accessProjectId = visibleAttachments[0]?.projectId ?? attachments[0]?.projectId ?? null;

	return (
		<section
			className={cn(
				"min-w-0 overflow-hidden",
				!canManageVault && "border-l-2 border-l-muted-foreground/40 bg-muted/10",
			)}
		>
			<div className="border-b p-4">
				<div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
					<div className="flex min-w-0 items-start gap-3">
						<span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-md border bg-background/70 text-muted-foreground">
							{canManageVault ? <Key className="size-5" /> : <Lock className="size-5" />}
						</span>
						<div className="min-w-0 space-y-2">
							<div className="flex flex-wrap items-center gap-2">
								<h3 className="truncate text-xl font-semibold" translate="no">
									{vault.name || vault.slug}
								</h3>
								<VaultAccessBadge isOwner={vault.is_owner} />
								<Badge variant="secondary">
									{`Used by ${attachments.length} Project${attachments.length === 1 ? "" : "s"}`}
								</Badge>
							</div>
							<div className="truncate font-mono text-xs text-muted-foreground" translate="no">
								{vault.slug}
							</div>
						</div>
					</div>
					{canManageVault ? (
						<div className="flex flex-wrap gap-2 lg:justify-end">
							<AddProjectToVaultControl
								vaultName={vault.name || vault.slug}
								options={addProjectOptions}
								agents={agents}
								onAddProject={onAddProject}
								isPending={isAddingProject}
							/>
							<ConfirmAction
								title={`Delete ${vault.name || vault.slug}?`}
								description={
									<p>
										This cannot be undone. Agents using these keys will fail until you create the
										keys again in another Vault. This permanently deletes every key in this Vault
										and removes it from {attachments.length} Project
										{attachments.length === 1 ? "" : "s"}.
									</p>
								}
								confirmLabel="Delete Vault"
								destructive
								onConfirm={onDeleteVault}
							>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									disabled={isDeletingVault}
									aria-busy={isDeletingVault}
									className={cn(
										"w-fit text-muted-foreground hover:text-destructive",
										isDeletingVault && "disabled:opacity-100",
									)}
								>
									{isDeletingVault ? (
										<Spinner className="size-3.5" />
									) : (
										<Trash2 className="size-3.5" />
									)}
									{isDeletingVault ? "Deleting…" : "Delete Vault"}
								</Button>
							</ConfirmAction>
						</div>
					) : null}
				</div>
			</div>
			{canManageVault ? null : (
				<div className="flex gap-3 border-b bg-muted/25 px-4 py-3 text-sm">
					<Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
					<div>
						<p className="font-medium">Read-only Vault</p>
						<p className="text-xs text-muted-foreground">
							You can view key names because this Vault is available through a shared Project. The
							dashboard hides values, but CLI runtime reads can resolve them. Only the owner can
							edit keys or change who has access.
						</p>
					</div>
				</div>
			)}
			<AttachedProjectsPanel
				vault={vault}
				attachments={attachments}
				visibleAttachments={visibleAttachments}
				onDetachProject={onDetachProject}
				isDetachingProject={isDetachingProject}
				detachingProjectId={detachingProjectId}
			/>
			<VaultKeysPanel vault={vault} accessProjectId={accessProjectId} />
		</section>
	);
}

function AddProjectToVaultControl({
	vaultName,
	options,
	agents,
	onAddProject,
	isPending,
}: {
	vaultName: string;
	options: VaultProjectMetadata[];
	agents: ProjectAgentMetadata[];
	onAddProject: (projectId: string) => Promise<unknown>;
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
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="w-fit justify-self-start lg:justify-self-end"
				>
					<Plus />
					Add to Project
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Add Vault to Project</DialogTitle>
					<DialogDescription>
						Make {vaultName} available in another Project. Members can see key names in the
						dashboard and resolve values through CLI runtime reads.
					</DialogDescription>
				</DialogHeader>
				<ProjectScopePicker
					projects={options}
					agents={agents}
					value={projectId}
					onValueChange={setProjectId}
					label="Project"
					layout="stacked"
					triggerClassName="min-h-14 py-2"
				/>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => setOpen(false)}
						disabled={isPending}
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={!projectId || isPending}
						onClick={async () => {
							if (!projectId) return;
							try {
								await onAddProject(projectId);
								setOpen(false);
							} catch {
								// The mutation owns user-facing error handling.
							}
						}}
					>
						{isPending ? <Spinner /> : <Plus />}
						Add to Project
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
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

function VaultAccessBadge({ isOwner, compact = false }: { isOwner: boolean; compact?: boolean }) {
	return (
		<Badge
			variant={isOwner ? "secondary" : "outline"}
			className={cn("shrink-0 text-xs", compact && "px-1.5 py-0 text-[11px]")}
		>
			{isOwner ? "Owner" : "Read-only"}
		</Badge>
	);
}

function attachmentName(attachment: VaultAttachmentView) {
	return attachment.project ? displayProjectName(attachment.project) : "Unknown Project";
}

function VaultKeysPanel({
	vault,
	accessProjectId,
}: {
	vault: Vault;
	accessProjectId: string | null;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [adding, setAdding] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");
	const readOnly = !vault.is_owner;
	const fieldDomId = `${vault.slug}-keys`;
	const vaultItemsCacheKey = ["vault-items", vault.id] as const;
	const itemsCacheKey = [...vaultItemsCacheKey, accessProjectId] as const;
	const queryParams = { project_id: accessProjectId ?? undefined };

	const {
		data: items,
		error: itemsError,
		isLoading: itemsLoading,
	} = useQuery({
		queryKey: itemsCacheKey,
		queryFn: async () =>
			unwrap(
				await api.GET("/api/vault/{slug}/items", {
					params: { path: { slug: vault.slug }, query: queryParams },
				}),
			),
		enabled: vault.is_owner || !!accessProjectId,
	});

	const upsertItem = useMutation({
		mutationFn: async ({ section, key, value }: { section: string; key: string; value: string }) =>
			unwrap(
				await api.PUT("/api/vault/{slug}/items", {
					params: { path: { slug: vault.slug }, query: queryParams },
					body: { section, fields: { [key]: value } },
				}),
			),
		onSuccess: (_result, variables) => {
			setNewKey("");
			setNewValue("");
			setAdding(false);
			queryClient.setQueriesData<VaultItems>({ queryKey: vaultItemsCacheKey }, (current) =>
				addVaultItemNames(current, variables.section, [variables.key]),
			);
			void queryClient.invalidateQueries({ queryKey: vaultItemsCacheKey });
		},
		onError: (e) => toast.error("Failed to Save Key", { description: errorMessage(e) }),
	});

	const importItems = useMutation({
		mutationFn: async ({
			fields,
			summary,
		}: {
			fields: Record<string, string>;
			summary: KeyImportSummary;
		}) => {
			unwrap(
				await api.PUT("/api/vault/{slug}/items", {
					params: { path: { slug: vault.slug }, query: queryParams },
					body: { section: "", fields },
				}),
			);
			return summary;
		},
		onSuccess: (summary, variables) => {
			queryClient.setQueriesData<VaultItems>({ queryKey: vaultItemsCacheKey }, (current) =>
				addVaultItemNames(current, "", Object.keys(variables.fields)),
			);
			void queryClient.invalidateQueries({ queryKey: vaultItemsCacheKey });
			const changed = summary.created + summary.updated;
			toast.success("Keys Imported", {
				description:
					summary.updated > 0 || summary.skipped > 0
						? `${summary.created} new, ${summary.updated} updated, ${summary.skipped} skipped.`
						: `${changed} key${changed === 1 ? "" : "s"} added to ${vault.name || vault.slug}.`,
			});
		},
		onError: (e) => toast.error("Failed to Import Keys", { description: errorMessage(e) }),
	});

	const deleteItem = useMutation({
		mutationFn: async ({ section, name }: { section: string; name: string }) =>
			unwrap(
				await api.DELETE("/api/vault/{slug}/items", {
					params: { path: { slug: vault.slug }, query: queryParams },
					body: { section, fields: [name] },
				}),
			),
		onSuccess: (_result, variables) => {
			queryClient.setQueriesData<VaultItems>({ queryKey: vaultItemsCacheKey }, (current) =>
				removeVaultItemNames(current, variables.section, [variables.name]),
			);
			void queryClient.invalidateQueries({ queryKey: vaultItemsCacheKey });
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
	const defaultKeyNames = new Set(
		allFields.filter((field) => field.section === "").map((field) => field.name),
	);

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
							cell: ({ row }) => {
								const isDeletingThisKey =
									deleteItem.isPending &&
									deleteItem.variables?.section === row.original.section &&
									deleteItem.variables?.name === row.original.name;

								return (
									<ConfirmAction
										title={`Delete ${row.original.key}?`}
										description={
											<p>
												This cannot be undone. Apps, workflows, or agent runs using this key will
												fail until you add it again.
											</p>
										}
										confirmLabel="Delete Key"
										destructive
										onConfirm={() =>
											deleteItem.mutate({ section: row.original.section, name: row.original.name })
										}
									>
										<Button
											variant="ghost"
											size="icon-sm"
											onClick={(event) => event.stopPropagation()}
											disabled={deleteItem.isPending}
											aria-busy={isDeletingThisKey}
											className={cn(
												"text-muted-foreground hover:text-destructive",
												isDeletingThisKey && "disabled:opacity-100",
											)}
											aria-label={
												isDeletingThisKey
													? `Deleting ${row.original.key}`
													: `Delete ${row.original.key}`
											}
										>
											{isDeletingThisKey ? (
												<Spinner className="size-3.5" />
											) : (
												<Trash2 className="size-3.5" />
											)}
										</Button>
									</ConfirmAction>
								);
							},
							size: 40,
						} satisfies ColumnDef<VaultField>,
					]),
		],
		[deleteItem, readOnly],
	);

	const keyCountLabel = itemsLoading
		? "Loading keys"
		: `${allFields.length} ${allFields.length === 1 ? "key" : "keys"}`;

	return (
		<section className="space-y-3 p-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<h4 className="text-sm font-semibold">Keys</h4>
					<p className="text-xs text-muted-foreground">
						{readOnly
							? "Key names are visible here; CLI runtime reads can resolve values."
							: "Keys live in this Vault, not inside a Project. Every Project using this Vault sees the same keys; key updates here apply everywhere."}
					</p>
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
								disabled={itemsLoading || !!itemsError}
								className="text-muted-foreground"
							>
								<Plus className="size-3.5" />
								Add Key
							</Button>
							<VaultKeyImportDialog
								existingKeys={defaultKeyNames}
								isPending={importItems.isPending || itemsLoading || !!itemsError}
								onImport={async (fields, summary) => {
									try {
										await importItems.mutateAsync({ fields, summary });
										return true;
									} catch {
										return false;
									}
								}}
							/>
						</>
					)}
				</div>
			</div>

			{readOnly ? (
				<div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
					<Lock className="size-3.5 shrink-0 text-current" />
					<span>Read-only: contact the owner to update keys.</span>
				</div>
			) : null}

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
						placeholder="KEY_NAME…"
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
						placeholder="Secret value…"
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

			{itemsError ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Failed to Load Keys</AlertTitle>
					<AlertDescription>{errorMessage(itemsError)}</AlertDescription>
				</Alert>
			) : itemsLoading ? (
				<div className="rounded-lg border bg-card">
					<div className="grid grid-cols-[minmax(0,1fr)_120px_40px] gap-3 border-b bg-muted/40 px-3 py-2">
						<Skeleton className="h-4 w-20" />
						<Skeleton className="h-4 w-16" />
						<span />
					</div>
					<div className="space-y-3 p-3">
						<Skeleton className="h-4 w-2/3" />
						<Skeleton className="h-4 w-1/2" />
					</div>
				</div>
			) : allFields.length > 0 ? (
				<DataTable columns={columns} data={allFields} />
			) : !adding ? (
				<p className="text-sm text-muted-foreground">
					{readOnly
						? "No key names are visible in this shared vault yet."
						: "No keys yet. Add the first key to this vault."}
				</p>
			) : null}
		</section>
	);
}

function AttachedProjectsPanel({
	vault,
	attachments,
	visibleAttachments,
	onDetachProject,
	isDetachingProject,
	detachingProjectId,
}: {
	vault: Vault;
	attachments: VaultAttachmentView[];
	visibleAttachments: VaultAttachmentView[];
	onDetachProject: (projectId: string) => void;
	isDetachingProject: boolean;
	detachingProjectId: string | null;
}) {
	return (
		<section className="space-y-3 border-b bg-muted/10 p-4">
			<div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
				<div>
					<h4 className="text-sm font-semibold">Used by Projects</h4>
					<p className="text-xs text-muted-foreground">
						{vault.is_owner
							? "Used by these Projects. Members see key names only; values stay hidden."
							: "Used by Projects shared by other users. You can read names only."}
					</p>
				</div>
				{visibleAttachments.length !== attachments.length ? (
					<p className="text-xs text-muted-foreground">
						Showing {visibleAttachments.length} of {attachments.length}
					</p>
				) : null}
			</div>
			{visibleAttachments.length > 0 ? (
				<div className={cn("grid gap-2", visibleAttachments.length > 1 && "md:grid-cols-2")}>
					{visibleAttachments.map((attachment) => (
						<VaultProjectAttachmentRow
							key={attachment.projectId}
							vault={vault}
							attachment={attachment}
							onDetachProject={onDetachProject}
							isDetachingProject={isDetachingProject}
							detachingProjectId={detachingProjectId}
						/>
					))}
				</div>
			) : (
				<p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
					This Vault is not used by any Project in the current view.
				</p>
			)}
		</section>
	);
}

function VaultProjectAttachmentRow({
	vault,
	attachment,
	onDetachProject,
	isDetachingProject,
	detachingProjectId,
}: {
	vault: Vault;
	attachment: VaultAttachmentView;
	onDetachProject: (projectId: string) => void;
	isDetachingProject: boolean;
	detachingProjectId: string | null;
}) {
	const projectName = attachment.project ? displayProjectName(attachment.project) : "this Project";
	const isRemovingThisProject = isDetachingProject && detachingProjectId === attachment.projectId;
	return (
		<div className="flex items-start justify-between gap-3 rounded-md border bg-background/70 p-3">
			<div className="min-w-0">
				{attachment.project ? (
					<ProjectIdentity
						project={attachment.project}
						agent={attachment.agent}
						showOwner={false}
						showAccess={attachment.readOnly}
						titleClassName="text-sm"
					/>
				) : (
					<div className="min-w-0">
						<h5 className="text-sm font-semibold">Unknown Project</h5>
						<p className="truncate font-mono text-xs text-muted-foreground" translate="no">
							{attachment.projectId}
						</p>
					</div>
				)}
			</div>
			{vault.is_owner ? (
				<ConfirmAction
					title={`Remove from ${projectName}?`}
					description={
						<p>
							{vault.slug} will no longer be available in {projectName}. The Vault and its keys stay
							in your account; only this Project loses access.
						</p>
					}
					confirmLabel="Remove from Project"
					destructive
					onConfirm={() => onDetachProject(attachment.projectId)}
				>
					<Button
						variant="ghost"
						size="icon-sm"
						disabled={isDetachingProject}
						aria-busy={isRemovingThisProject}
						className={cn(
							"shrink-0 text-muted-foreground hover:text-destructive",
							isRemovingThisProject && "disabled:opacity-100",
						)}
						aria-label={
							isRemovingThisProject
								? `Removing ${vault.slug} from ${projectName}`
								: `Remove ${vault.slug} from ${projectName}`
						}
						title={isRemovingThisProject ? "Removing from Project" : "Remove from Project"}
					>
						{isRemovingThisProject ? (
							<Spinner className="size-3.5" />
						) : (
							<Trash2 className="size-3.5" />
						)}
					</Button>
				</ConfirmAction>
			) : null}
		</div>
	);
}

function addVaultItemNames(
	current: VaultItems | undefined,
	section: string,
	names: string[],
): VaultItems {
	const sectionKey = vaultItemsSectionKey(section);
	const next = cloneVaultItems(current);
	const merged = new Set(next[sectionKey] ?? []);
	for (const name of names) merged.add(name);
	next[sectionKey] = [...merged].sort();
	return next;
}

function removeVaultItemNames(
	current: VaultItems | undefined,
	section: string,
	names: string[],
): VaultItems {
	const sectionKey = vaultItemsSectionKey(section);
	const next = cloneVaultItems(current);
	const removing = new Set(names);
	const remaining = (next[sectionKey] ?? []).filter((name) => !removing.has(name));
	if (remaining.length > 0) {
		next[sectionKey] = remaining;
	} else {
		delete next[sectionKey];
	}
	return next;
}

function cloneVaultItems(current: VaultItems | undefined): VaultItems {
	return Object.fromEntries(
		Object.entries(current ?? {}).map(([section, names]) => [section, [...names]]),
	);
}

function vaultItemsSectionKey(section: string) {
	return section || "(default)";
}

function normalizeVaultSlug(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function isValidVaultSlug(value: string) {
	return VAULT_SLUG_PATTERN.test(value);
}
