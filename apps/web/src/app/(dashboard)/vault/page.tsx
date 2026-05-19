"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertCircle, Key, Plus, Trash2, X } from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import {
	compareProjectsForUse,
	displayProjectName,
	isProjectOwner,
	ProjectIdentity,
	ProjectScopePicker,
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
	const [projectFilter, setProjectFilter] = useQueryState(
		"project",
		parseAsString.withDefault("all").withOptions({ clearOnDefault: true, history: "replace" }),
	);
	const [createProjectId, setCreateProjectId] = useState("");

	// Vaults from shared projects (other users') need read-only treatment —
	// the membership is viewer, so any write would 403. /api/vault returns
	// them in the same list as owned vaults (the user CAN read them, after
	// all), so we cross-reference /api/projects' is_owner to decide which
	// cards render with write affordances disabled and a "shared" badge.
	const { data: projects, error: projectsError } = useQuery({
		queryKey: ["projects"],
		queryFn: async () => unwrap(await api.GET("/api/projects")),
	});
	const orderedProjects = useMemo(
		() => [...(projects ?? [])].filter((project) => project.id).sort(compareProjectsForUse),
		[projects],
	);
	const projectsById = useMemo(
		() => new Map(orderedProjects.map((project) => [project.id, project])),
		[orderedProjects],
	);
	const filterProjectId = projectFilter === "all" ? null : projectFilter;
	const filterProject = filterProjectId ? (projectsById.get(filterProjectId) ?? null) : null;
	const isStaleProjectFilter = !!filterProjectId && projects !== undefined && !filterProject;
	const vaultsEnabled = projectFilter === "all" || (projects !== undefined && !!filterProject);

	const { data, isLoading, error } = useQuery({
		queryKey: ["vaults", filterProjectId ?? "all"],
		// Vaults list is small; fetch one large page so the UI doesn't need
		// its own paginator here.
		queryFn: async () =>
			unwrap(
				await api.GET("/api/vault", {
					params: {
						query: { page_size: 100, project_id: filterProjectId ?? undefined },
					},
				}),
			),
		enabled: vaultsEnabled,
	});
	const vaults = data?.items;

	const ownedProjectIds = useMemo(
		() =>
			projects
				? new Set(
						projects.filter((project) => isProjectOwner(project)).map((project) => project.id),
					)
				: null,
		[projects],
	);
	const ownedProjects = useMemo(
		() => orderedProjects.filter((project) => isProjectOwner(project)),
		[orderedProjects],
	);

	useEffect(() => {
		const filteredProjectIsWritable =
			!!filterProjectId && ownedProjects.some((project) => project.id === filterProjectId);
		const nextProjectId = filteredProjectIsWritable
			? filterProjectId
			: (ownedProjects[0]?.id ?? "");
		if (createProjectId !== nextProjectId) setCreateProjectId(nextProjectId);
	}, [createProjectId, filterProjectId, ownedProjects]);
	const createProject = projectsById.get(createProjectId) ?? null;

	const createVault = useMutation({
		mutationFn: async ({ slug, projectId }: { slug: string; projectId: string }) =>
			unwrap(
				await api.POST("/api/vault", {
					params: { query: { project_id: projectId } },
					body: { slug, name: slug },
				}),
			),
		onSuccess: () => {
			setNewVaultSlug("");
			queryClient.invalidateQueries({ queryKey: ["vaults"] });
		},
		onError: (e) => toast.error("Failed to create vault", { description: errorMessage(e) }),
	});

	const deleteVault = useMutation({
		mutationFn: async (vault: { slug: string; project_id: string }) =>
			unwrap(
				await api.DELETE("/api/vault/{slug}", {
					params: { path: { slug: vault.slug }, query: { project_id: vault.project_id } },
				}),
			),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vaults"] }),
		onError: (e) => toast.error("Failed to delete vault", { description: errorMessage(e) }),
	});

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Vaults"
				description={VAULTS_RESOURCE.managementDescription}
				actions={
					vaults ? (
						<Badge variant="secondary">
							{vaults.length} vault{vaults.length === 1 ? "" : "s"}
						</Badge>
					) : null
				}
			/>

			<div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3">
				<div className="flex flex-wrap items-center gap-3">
					<ProjectScopePicker
						projects={orderedProjects}
						value={projectFilter}
						onValueChange={(value) => void setProjectFilter(value)}
						allowAll
						allLabel="All Projects"
						label="Show"
						disabled={!orderedProjects.length}
					/>
					{filterProject ? (
						<Badge variant={isProjectOwner(filterProject) ? "outline" : "secondary"}>
							{isProjectOwner(filterProject) ? "owner" : "viewer"}
						</Badge>
					) : null}
				</div>
				<div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
					{ownedProjects.length > 1 ? (
						<ProjectScopePicker
							projects={ownedProjects}
							value={createProjectId}
							onValueChange={setCreateProjectId}
							label="Create in"
							disabled={!ownedProjects.length}
						/>
					) : null}
					<Label htmlFor="new-vault-slug" className="sr-only">
						New vault name
					</Label>
					<Input
						id="new-vault-slug"
						name="new-vault-slug"
						value={newVaultSlug}
						onChange={(e) =>
							setNewVaultSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
						}
						placeholder={
							createProject
								? `New vault in ${displayProjectName(createProject)}…`
								: "New vault name…"
						}
						autoComplete="off"
						className="min-w-[240px] flex-1"
						onKeyDown={(e) => {
							if (e.key === "Enter" && newVaultSlug && createProjectId) {
								createVault.mutate({ slug: newVaultSlug, projectId: createProjectId });
							}
						}}
					/>
					<Button
						onClick={() =>
							newVaultSlug && createProjectId
								? createVault.mutate({ slug: newVaultSlug, projectId: createProjectId })
								: undefined
						}
						disabled={!newVaultSlug || !createProjectId || createVault.isPending}
					>
						<Plus />
						Create
					</Button>
				</div>
			</div>

			{error ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Failed to load vaults</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : null}
			{projectsError ? (
				<Alert>
					<AlertCircle />
					<AlertTitle>Project ownership unavailable</AlertTitle>
					<AlertDescription>
						Vault write actions are hidden until project access can be verified. Refresh to retry.
					</AlertDescription>
				</Alert>
			) : null}
			{isStaleProjectFilter ? (
				<Alert>
					<AlertCircle />
					<AlertTitle>Project unavailable</AlertTitle>
					<AlertDescription>
						This vault filter points to a Project you can no longer access. Pick another Project.
					</AlertDescription>
				</Alert>
			) : null}
			{!projectsError && orderedProjects.length > 0 && ownedProjects.length === 0 ? (
				<Alert>
					<AlertCircle />
					<AlertTitle>No writable Projects</AlertTitle>
					<AlertDescription>
						You only have viewer access right now, so vault creation and key edits are hidden.
					</AlertDescription>
				</Alert>
			) : null}

			{/* Vault list — flat sections, no per-vault outer card. Skeleton
			    mirrors the actual shape: heading line + 3 table-row bars. */}
			{isLoading || (!vaultsEnabled && !isStaleProjectFilter) ? (
				<div className="space-y-6">
					{Array.from({ length: 2 }).map((_, i) => (
						<div key={i} className="space-y-2">
							<Skeleton className="h-4 w-24" />
							<Skeleton className="h-24 w-full rounded-lg" />
						</div>
					))}
				</div>
			) : vaults?.length ? (
				<div className="space-y-6">
					{vaults.map((v) => {
						const isReadOnly = !ownedProjectIds?.has(v.project_id);
						return (
							<VaultCard
								key={v.id}
								vault={v}
								project={projectsById.get(v.project_id)}
								showProject={!filterProjectId}
								readOnly={isReadOnly}
								onDelete={() => deleteVault.mutate({ slug: v.slug, project_id: v.project_id })}
								isDeleting={deleteVault.isPending}
							/>
						);
					})}
				</div>
			) : (
				<EmptyState
					icon={Key}
					title={filterProject ? "No vaults in this Project yet" : "No vaults yet"}
					description={
						filterProject
							? "Create one above to store API keys inside this Project."
							: "Create one above to store API keys for your AI to use."
					}
				/>
			)}
		</div>
	);
}

function VaultCard({
	vault,
	project,
	showProject = false,
	readOnly = false,
	onDelete,
	isDeleting,
}: {
	vault: Vault;
	project?: {
		name: string;
		slug: string;
		kind?: string;
		is_owner?: boolean;
		owner_display?: string | null;
		owner_handle?: string | null;
	};
	showProject?: boolean;
	readOnly?: boolean;
	onDelete: () => void;
	isDeleting: boolean;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [adding, setAdding] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");

	// Cache key includes project_id so a JWT user with the same slug
	// in two projects (Personal + env-A) doesn't share entries.
	// Without the project_id in the key the second card would render
	// the first's items.
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
		onError: (e) => toast.error("Failed to save key", { description: errorMessage(e) }),
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
		onError: (e) => toast.error("Failed to delete key", { description: errorMessage(e) }),
	});

	const allFields: VaultField[] = items
		? Object.entries(items).flatMap(([section, fields]) =>
				fields.map((f) => ({
					key: section === "(default)" ? f : `${section}/${f}`,
					name: f,
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
			// Read-only vaults (shared from someone else's project) get no
			// per-row delete column at all — viewer membership can't mutate.
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
									onClick={(e) => {
										e.stopPropagation();
										// Removing a secret breaks any clawdi:// reference
										// to it the next time an AI tries to resolve.
										const ok = window.confirm(
											`Delete "${row.original.key}"?\n\n` +
												"Anything that resolves this key will start failing. To get it back you'd have to paste the value in again.",
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

	// Flat section layout — heading + action row on top, then the table.
	// No outer card/border wrapping so it reads like Sessions/Memories and
	// doesn't stack a card inside a card.
	return (
		<section className="space-y-2">
			{/* Project group/header to the heading row only — otherwise the delete
			    icon pops in whenever the cursor moves anywhere in the table body
			    below. */}
			<div className="group/header flex items-center justify-between gap-2 px-1">
				<div className="min-w-0">
					<div className="flex flex-wrap items-baseline gap-2">
						<h3 className="font-semibold text-sm">{vault.slug}</h3>
						<span className="text-xs text-muted-foreground">
							{allFields.length} {allFields.length === 1 ? "key" : "keys"}
						</span>
						{readOnly ? (
							<Badge
								variant="secondary"
								className="text-xs"
								title="Shared from another project — viewer membership is read-only"
							>
								shared
							</Badge>
						) : null}
					</div>
					{showProject && project ? (
						<ProjectIdentity
							project={project}
							showKind={false}
							showOwner={false}
							showAccess={false}
							titleClassName="text-xs font-medium"
							className="mt-1"
						/>
					) : null}
				</div>
				{readOnly ? null : (
					<div className="flex items-center gap-1">
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
								// Vault deletion permanently destroys every key
								// inside it — anything that resolves a clawdi://
								// URI from this vault will start failing the next
								// time an AI tries to use it.
								const ok = window.confirm(
									`Delete vault "${vault.slug}"?\n\n` +
										`This will permanently remove ${allFields.length} ` +
										`secret${allFields.length === 1 ? "" : "s"} stored inside. ` +
										"Anything that uses these keys will stop working.",
								);
								if (ok) onDelete();
							}}
							disabled={isDeleting}
							className="text-muted-foreground opacity-0 group-hover/header:opacity-100 hover:text-destructive"
							aria-label="Delete vault"
						>
							<Trash2 className="size-3.5" />
						</Button>
					</div>
				)}
			</div>

			{/* Inline add form, when toggled */}
			{!readOnly && adding ? (
				<div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed bg-muted/20 px-3 py-2">
					<Label htmlFor={`key-${vault.slug}`} className="sr-only">
						Key name
					</Label>
					<Input
						id={`key-${vault.slug}`}
						name={`key-${vault.slug}`}
						value={newKey}
						onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
						placeholder="KEY_NAME…"
						autoComplete="off"
						spellCheck={false}
						className="max-w-[220px] flex-1 font-mono"
					/>
					<Label htmlFor={`value-${vault.slug}`} className="sr-only">
						Secret value
					</Label>
					<Input
						id={`value-${vault.slug}`}
						name={`value-${vault.slug}`}
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

			{allFields.length > 0 ? (
				<DataTable columns={columns} data={allFields} />
			) : !adding ? (
				<p className="px-1 text-sm text-muted-foreground">
					{readOnly
						? "No keys in this shared vault yet — the owner hasn't stored any secrets."
						: "No keys yet. Click "}
					{readOnly ? null : <span className="font-medium">Add Key</span>}
					{readOnly ? null : " to store your first secret."}
				</p>
			) : null}
		</section>
	);
}
