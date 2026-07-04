"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
	ArrowLeft,
	Check,
	Copy as CopyIcon,
	FolderInput,
	ListChecks,
	Plus,
	Search,
	Share2,
	Trash2,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { BulkActionBar } from "@/components/bulk-action-bar";
import { DetailNotFound, DetailTitle } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { displayProjectName, isCustomProject } from "@/components/projects/project-metadata";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/ui/confirm-action";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AddKeysDialog } from "@/components/vault/add-keys-dialog";
import { CopyKeysDialog } from "@/components/vault/copy-keys-dialog";
import { prefixGroupsFor, SplitVaultDialog } from "@/components/vault/split-vault-dialog";
import { unwrap, useApi } from "@/lib/api";
import { isApiNotFoundError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { cn, errorMessage } from "@/lib/utils";

type VaultSummary = components["schemas"]["VaultResponse"];
type ProjectRow = components["schemas"]["ProjectResponse"];

/** Selection identity for a key row. Sections can't contain spaces. */
function keyId(k: { section: string; name: string }): string {
	return `${k.section} ${k.name}`;
}

/** The listing endpoint names the implicit section "(default)"; writes
 * must address it as "" or the section validator rejects the call. */
function apiSection(section: string): string {
	return section === "(default)" ? "" : section;
}

/* Vault detail (journeys J5 + J6): a real page for one secret bundle —
 * keys (names only; values stay server-side), paste-to-import, project
 * attachments, and the guided "Share keys" chain. */

export default function VaultDetailPage({ slug: rawSlug }: { slug: string }) {
	const slug = decodeURIComponent(rawSlug);
	const api = useApi();
	const qc = useQueryClient();
	const router = useRouter();

	const vaults = useQuery({
		queryKey: ["vaults", "all"],
		queryFn: async () =>
			unwrap(await api.GET("/v1/vault", { params: { query: { page_size: 200 } } })),
	});
	const vault: VaultSummary | null = vaults.data?.items.find((v) => v.slug === slug) ?? null;
	const isOwner = vault?.is_owner !== false;
	const anyProjectId = vault?.project_ids?.[0];

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => unwrap(await api.GET("/v1/projects")),
	});
	const projectById = useMemo(
		() => new Map((projects.data ?? []).map((p) => [p.id, p])),
		[projects.data],
	);

	const keys = useQuery({
		queryKey: ["vault-items", slug, anyProjectId],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/vault/{slug}/items", {
					params: { path: { slug }, query: { project_id: anyProjectId ?? undefined } },
				}),
			),
		enabled: !!vault,
	});
	const keyNames = useMemo(() => {
		if (!keys.data) return [];
		return Object.entries(keys.data).flatMap(([section, names]) =>
			names.map((name) => ({ section, name })),
		);
	}, [keys.data]);

	// Curation toolkit for grab-bag vaults (the default vault holds
	// hundreds of keys): search by name, batch-select, then copy/move
	// the selection into a named vault or delete it.
	const [search, setSearch] = useState("");
	const [selectMode, setSelectMode] = useState(false);
	const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
	const clearSelection = () => setSelectedKeys(new Set());
	const filteredKeyNames = useMemo(() => {
		const needle = search.trim().toLowerCase();
		if (!needle) return keyNames;
		return keyNames.filter(
			({ section, name }) =>
				name.toLowerCase().includes(needle) || section.toLowerCase().includes(needle),
		);
	}, [keyNames, search]);
	const selectedList = useMemo(
		() => keyNames.filter((k) => selectedKeys.has(keyId(k))),
		[keyNames, selectedKeys],
	);
	// App-prefixed keys (`clawdi-backend/DATABASE_URL`) are a grab-bag
	// smell — offer the split wizard when at least two app groups exist.
	const prefixGroups = useMemo(() => prefixGroupsFor(keyNames), [keyNames]);
	const allFilteredSelected =
		filteredKeyNames.length > 0 && filteredKeyNames.every((k) => selectedKeys.has(keyId(k)));

	const refresh = () => {
		qc.invalidateQueries({ queryKey: ["vaults"] });
		qc.invalidateQueries({ queryKey: ["vault-items", slug] });
	};

	const deleteKey = useMutation({
		mutationFn: async ({ section, name }: { section: string; name: string }) => {
			if (!anyProjectId) throw new Error("No Project attachment");
			return unwrap(
				await api.DELETE("/v1/vault/{slug}/items", {
					params: {
						path: { slug },
						query: { project_id: anyProjectId, global_delete: true },
					},
					body: { section: apiSection(section), fields: [name] },
				}),
			);
		},
		onSuccess: () => refresh(),
		onError: (e) => toast.error("Couldn't delete key", { description: errorMessage(e) }),
	});

	const bulkDeleteKeys = useMutation({
		mutationFn: async (list: { section: string; name: string }[]) => {
			if (!anyProjectId) throw new Error("No Project attachment");
			const bySection = new Map<string, string[]>();
			for (const k of list) {
				const section = apiSection(k.section);
				const bucket = bySection.get(section);
				if (bucket) bucket.push(k.name);
				else bySection.set(section, [k.name]);
			}
			// API caps fields per request at 200; chunk for big selections.
			for (const [section, names] of bySection) {
				for (let i = 0; i < names.length; i += 150) {
					unwrap(
						await api.DELETE("/v1/vault/{slug}/items", {
							params: {
								path: { slug },
								query: { project_id: anyProjectId, global_delete: true },
							},
							body: { section, fields: names.slice(i, i + 150) },
						}),
					);
				}
			}
			return list.length;
		},
		onSuccess: (n) => {
			refresh();
			clearSelection();
			toast.success(`${n} ${n === 1 ? "key" : "keys"} deleted`);
		},
		onError: (e) => toast.error("Couldn't delete keys", { description: errorMessage(e) }),
	});

	const attachProject = useMutation({
		mutationFn: async (projectId: string) => {
			if (!vault) throw new Error("Vault not loaded");
			return unwrap(
				await api.POST("/v1/vault", {
					params: { query: { project_id: projectId } },
					body: { slug: vault.slug, name: vault.name },
				}),
			);
		},
		onSuccess: () => {
			refresh();
			toast.success("Vault added to Project");
		},
		onError: (e) => toast.error("Couldn't add vault to Project", { description: errorMessage(e) }),
	});

	const detachProject = useMutation({
		mutationFn: async (projectId: string) =>
			unwrap(
				await api.DELETE("/v1/vault/{slug}", {
					params: { path: { slug }, query: { project_id: projectId } },
				}),
			),
		onSuccess: () => {
			refresh();
			toast.success("Vault removed from Project");
		},
		onError: (e) =>
			toast.error("Couldn't remove vault from Project", { description: errorMessage(e) }),
	});

	const deleteVault = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.DELETE("/v1/vault/{slug}", {
					params: { path: { slug }, query: {} },
				}),
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["vaults"] });
			qc.removeQueries({ queryKey: ["vault-items", slug] });
			toast.success("Vault deleted", {
				description: `${vault?.name ?? slug} and its keys were removed.`,
			});
			void router.navigate({ href: "/vault" });
		},
		onError: (e) => toast.error("Couldn't delete vault", { description: errorMessage(e) }),
	});

	useSetBreadcrumbTitle(vault?.name ?? null);

	if (vaults.isLoading) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<Skeleton className="h-8 w-20" />
				<div className="flex items-start gap-3">
					<Skeleton className="size-11 rounded-xl" />
					<div className="min-w-0 flex-1 space-y-2">
						<Skeleton className="h-6 w-48 max-w-full" />
						<Skeleton className="h-4 w-96 max-w-full" />
						<Skeleton className="h-3 w-40" />
					</div>
				</div>
				<Skeleton className="h-36 w-full rounded-lg" />
				<Skeleton className="h-24 w-full rounded-lg" />
			</div>
		);
	}

	if (vaults.error) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<Button asChild variant="ghost" size="sm" className="w-fit">
					<Link to="/vault">
						<ArrowLeft className="mr-1.5 size-4" />
						Vaults
					</Link>
				</Button>
				{isApiNotFoundError(vaults.error) ? (
					<DetailNotFound
						title="Vault not found"
						message="This vault may have been removed, or your account no longer has access."
					/>
				) : (
					<ApiErrorPanel
						error={vaults.error}
						onRetry={() => {
							void vaults.refetch();
						}}
						title="Couldn't load vault"
					/>
				)}
			</div>
		);
	}

	if (!vault) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<Button asChild variant="ghost" size="sm" className="w-fit">
					<Link to="/vault">
						<ArrowLeft className="mr-1.5 size-4" />
						Vaults
					</Link>
				</Button>
				<DetailNotFound
					title="Vault not found"
					message="This vault may have been removed, or your account no longer has access."
				/>
			</div>
		);
	}

	const attachedProjects = (vault.project_ids ?? [])
		.map((id) => projectById.get(id))
		.filter((p): p is ProjectRow => !!p);

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6")}>
			<Button asChild variant="ghost" size="sm" className="w-fit">
				<Link to="/vault">
					<ArrowLeft className="mr-1.5 size-4" />
					Vaults
				</Link>
			</Button>

			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex min-w-0 items-start gap-3">
					<span
						className={cn(
							"flex size-11 shrink-0 select-none items-center justify-center rounded-xl text-2xl leading-none",
							identityFor(vault.name).colorClasses,
						)}
					>
						{identityFor(vault.name).emoji}
					</span>
					<div className="min-w-0">
						<DetailTitle className="truncate">{vault.name}</DetailTitle>
						<p className="mt-1 text-sm text-muted-foreground">
							{isOwner
								? "Keys live here once and work in every Project this vault is added to."
								: "Shared with you — your agents can use these keys; only the owner edits them."}
						</p>
						<p className="mt-0.5 font-mono text-xs text-muted-foreground">vault://{vault.slug}</p>
					</div>
				</div>
				{isOwner ? (
					<div className="flex shrink-0 items-center gap-2">
						<ShareKeysDialog
							vault={vault}
							projects={projects.data ?? []}
							onAttach={(projectId) => attachProject.mutateAsync(projectId)}
						/>
						<ConfirmAction
							title={`Delete ${vault.name}?`}
							description={
								<p>
									Every key in this vault is removed for every Project using it. Agents lose access
									immediately.
								</p>
							}
							confirmLabel="Delete vault"
							destructive
							onConfirm={() => deleteVault.mutateAsync()}
						>
							<Button
								variant="outline"
								size="sm"
								disabled={deleteVault.isPending}
								className="text-destructive"
							>
								<Trash2 className="mr-1.5 size-3.5" />
								Delete
							</Button>
						</ConfirmAction>
					</div>
				) : null}
			</div>

			{/* Keys */}
			<section className="space-y-3">
				<div className="flex items-end justify-between gap-2">
					<div>
						<div className="flex items-center gap-2">
							<h2 className="text-sm font-semibold">Keys</h2>
							{keys.error ? (
								<Badge variant="secondary" className="tabular-nums">
									—
								</Badge>
							) : keys.data ? (
								<Badge variant="secondary" className="tabular-nums">
									{keyNames.length}
								</Badge>
							) : null}
						</div>
						<p className="mt-0.5 text-xs text-muted-foreground">
							Values are write-only here — agents read them at runtime through the CLI.
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{keyNames.length > 0 ? (
							<>
								<div className="relative">
									<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
									<Input
										value={search}
										onChange={(e) => setSearch(e.target.value)}
										placeholder="Search keys…"
										aria-label="Search keys"
										className="h-8 w-40 pl-8 text-sm sm:w-52"
									/>
								</div>
								{isOwner ? (
									<Button
										variant={selectMode ? "secondary" : "outline"}
										size="sm"
										onClick={() => {
											setSelectMode((on) => {
												if (on) clearSelection();
												return !on;
											});
										}}
										aria-pressed={selectMode}
									>
										<ListChecks className="size-3.5" />
										{selectMode ? "Done" : "Select"}
									</Button>
								) : null}
							</>
						) : null}
						{isOwner && prefixGroups.length >= 2 ? (
							<SplitVaultDialog
								vault={vault}
								groups={prefixGroups}
								onDone={() => clearSelection()}
							/>
						) : null}
						{isOwner ? (
							<AddKeysDialog vaultSlug={slug}>
								<Button variant="outline" size="sm" disabled={!anyProjectId}>
									<Plus className="size-3.5" />
									Add keys
								</Button>
							</AddKeysDialog>
						) : null}
					</div>
				</div>
				{selectMode && filteredKeyNames.length > 0 ? (
					<Button
						variant="ghost"
						size="sm"
						className="h-6 w-fit px-2 text-xs"
						onClick={() => {
							setSelectedKeys((prev) => {
								const next = new Set(prev);
								for (const k of filteredKeyNames) {
									if (allFilteredSelected) next.delete(keyId(k));
									else next.add(keyId(k));
								}
								return next;
							});
						}}
					>
						{allFilteredSelected
							? "Deselect all"
							: `Select all${search.trim() ? " matching" : ""} (${filteredKeyNames.length})`}
					</Button>
				) : null}

				{keys.isLoading ? (
					<Skeleton className="h-32 w-full rounded-lg" />
				) : keys.error ? (
					<ApiErrorPanel
						error={keys.error}
						onRetry={() => {
							void keys.refetch();
						}}
						title="Couldn't load vault keys"
					/>
				) : keyNames.length === 0 ? (
					<EmptyState
						variant="inset"
						title="No keys yet"
						description="Add one above or paste several at once with Import."
					/>
				) : filteredKeyNames.length === 0 ? (
					<EmptyState
						variant="inset"
						title="No keys match that search"
						description="Try another key name or section."
					/>
				) : (
					/* Keys as compact cards: a 200-key vault scans far better in a
				   multi-column grid than a one-column ledger. */
					<div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
						{filteredKeyNames.map(({ section, name }) => {
							const isSelected = selectedKeys.has(keyId({ section, name }));
							return (
								<div
									key={`${section}/${name}`}
									className={cn(
										"group relative flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 transition-colors duration-150",
										selectMode && isSelected
											? "border-foreground/40 bg-accent/50"
											: "hover:border-foreground/20",
									)}
								>
									{selectMode ? (
										<Checkbox
											checked={isSelected}
											tabIndex={-1}
											aria-hidden
											className="pointer-events-none shrink-0"
										/>
									) : null}
									<Tooltip>
										<TooltipTrigger asChild>
											<span className="min-w-0 flex-1 truncate font-mono text-xs">
												{/* "(default)" is the backend's implicit section — noise, hide it. */}
												{section && section !== "(default)" ? `${section}/` : ""}
												{name}
											</span>
										</TooltipTrigger>
										<TooltipContent>{name}</TooltipContent>
									</Tooltip>
									<span className="shrink-0 font-mono text-3xs text-muted-foreground select-none">
										••••••
									</span>
									{selectMode ? (
										<button
											type="button"
											onClick={() => {
												setSelectedKeys((prev) => {
													const next = new Set(prev);
													const id = keyId({ section, name });
													if (next.has(id)) next.delete(id);
													else next.add(id);
													return next;
												});
											}}
											aria-pressed={isSelected}
											className="absolute inset-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										>
											<span className="sr-only">
												{isSelected ? "Deselect" : "Select"} {name}
											</span>
										</button>
									) : isOwner ? (
										<ConfirmAction
											title={`Delete ${name}?`}
											description={<p>The key is removed for every Project using this vault.</p>}
											confirmLabel="Delete key"
											destructive
											onConfirm={() => deleteKey.mutate({ section, name })}
										>
											<Button
												variant="ghost"
												size="icon-xs"
												className="text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-destructive group-focus-within:opacity-100 group-hover:opacity-100"
												aria-label={`Delete ${name}`}
											>
												<Trash2 className="size-3" />
											</Button>
										</ConfirmAction>
									) : null}
								</div>
							);
						})}
					</div>
				)}
			</section>

			<BulkActionBar count={selectedKeys.size} noun="key" onClear={clearSelection}>
				<CopyKeysDialog vault={vault} keys={selectedList} mode="copy" onDone={clearSelection}>
					<Button size="sm" variant="outline">
						<CopyIcon className="size-3.5" />
						Copy to vault…
					</Button>
				</CopyKeysDialog>
				<CopyKeysDialog vault={vault} keys={selectedList} mode="move" onDone={clearSelection}>
					<Button size="sm">
						<FolderInput className="size-3.5" />
						Move to vault…
					</Button>
				</CopyKeysDialog>
				<ConfirmAction
					title={`Delete ${selectedKeys.size} ${selectedKeys.size === 1 ? "key" : "keys"}?`}
					description={<p>They are removed for every Project using this vault.</p>}
					confirmLabel="Delete"
					destructive
					onConfirm={() => bulkDeleteKeys.mutate(selectedList)}
				>
					<Button
						size="sm"
						variant="outline"
						disabled={bulkDeleteKeys.isPending}
						className="text-destructive"
					>
						<Trash2 className="size-3.5" />
						Delete
					</Button>
				</ConfirmAction>
			</BulkActionBar>

			{/* Projects */}
			<section className="space-y-3">
				<div className="flex items-end justify-between gap-2">
					<div>
						<div className="flex items-center gap-2">
							<h2 className="text-sm font-semibold">Projects</h2>
							{projects.isLoading ? null : (
								<Badge variant="secondary" className="tabular-nums">
									{projects.error ? "—" : attachedProjects.length}
								</Badge>
							)}
						</div>
						<p className="mt-0.5 text-xs text-muted-foreground">
							Same vault everywhere — key changes apply to every Project here. Agents bound to these
							Projects resolve the keys at runtime.
						</p>
					</div>
					{isOwner && !projects.error ? (
						<AttachProjectPicker
							projects={(projects.data ?? []).filter(
								(p) => p.is_owner !== false && !(vault.project_ids ?? []).includes(p.id),
							)}
							isPending={attachProject.isPending}
							onAttach={(projectId) => attachProject.mutate(projectId)}
						/>
					) : null}
				</div>
				{projects.isLoading ? (
					<Skeleton className="h-16 w-full" />
				) : projects.error ? (
					<ApiErrorPanel
						error={projects.error}
						onRetry={() => {
							void projects.refetch();
						}}
						title="Couldn't load attached Projects"
					/>
				) : attachedProjects.length === 0 ? (
					<EmptyState
						variant="inset"
						title="Not added to any Project yet"
						description="Agents can't use these keys until this vault is added to a Project."
					/>
				) : (
					<div className="divide-y overflow-hidden rounded-lg border bg-card">
						{attachedProjects.map((project) => (
							<div key={project.id} className="flex items-center gap-3 px-4 py-2.5">
								<Link
									to="/projects/$id"
									params={{ id: project.id }}
									className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
								>
									{displayProjectName(project)}
								</Link>
								<span className="font-mono text-xs text-muted-foreground">{project.slug}</span>
								{isOwner && (vault.project_ids?.length ?? 0) > 1 ? (
									<ConfirmAction
										title={`Remove from ${displayProjectName(project)}?`}
										description={<p>Agents using that Project lose access to these keys.</p>}
										confirmLabel="Remove"
										destructive
										onConfirm={() => detachProject.mutate(project.id)}
									>
										<Button
											variant="ghost"
											size="icon-sm"
											className="text-muted-foreground hover:text-destructive"
											aria-label={`Remove from ${displayProjectName(project)}`}
										>
											<Trash2 className="size-3.5" />
										</Button>
									</ConfirmAction>
								) : null}
							</div>
						))}
					</div>
				)}
			</section>
		</div>
	);
}

function AttachProjectPicker({
	projects,
	isPending,
	onAttach,
}: {
	projects: ProjectRow[];
	isPending: boolean;
	onAttach: (projectId: string) => void;
}) {
	const [value, setValue] = useState("");
	if (projects.length === 0) return null;
	return (
		<div className="flex items-center gap-2">
			<Select value={value} onValueChange={setValue}>
				<SelectTrigger size="sm" className="w-44" aria-label="Project to add this vault to">
					<SelectValue placeholder="Add to Project…" />
				</SelectTrigger>
				<SelectContent>
					{projects.map((p) => (
						<SelectItem key={p.id} value={p.id}>
							{displayProjectName(p)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Button
				size="sm"
				variant="outline"
				disabled={!value || isPending}
				onClick={() => {
					onAttach(value);
					setValue("");
				}}
			>
				{isPending ? <Spinner /> : <Plus className="size-3.5" />}
				Add
			</Button>
		</div>
	);
}

/**
 * The guided share chain (journey J5): keys are shared by putting the vault
 * in a workspace Project and sharing that Project. This sheet walks the two
 * hops in one place instead of leaving users to discover them.
 */
function ShareKeysDialog({
	vault,
	projects,
	onAttach,
}: {
	vault: VaultSummary;
	projects: ProjectRow[];
	onAttach: (projectId: string) => Promise<unknown>;
}) {
	const [open, setOpen] = useState(false);
	const shareable = projects.filter((p) => p.is_owner !== false && isCustomProject(p));
	const alreadyIn = shareable.filter((p) => (vault.project_ids ?? []).includes(p.id));
	// If the vault already lives in a shareable project, that's almost
	// certainly the one to share — preselect it so the common case is one
	// click (journey simulation finding J6).
	const [projectId, setProjectId] = useState(alreadyIn[0]?.id ?? "");
	const [attached, setAttached] = useState<ProjectRow | null>(null);
	const [isAttaching, setIsAttaching] = useState(false);

	const candidates = shareable;

	const reset = () => {
		setProjectId("");
		setAttached(null);
		setIsAttaching(false);
	};

	let body: ReactNode;
	if (attached) {
		body = (
			<div className="space-y-4">
				<Alert>
					<Check className="size-4" />
					<AlertTitle>Vault is in {displayProjectName(attached)}</AlertTitle>
					<AlertDescription>
						Now invite your colleague to that Project. They&apos;ll see key names here, and their
						agents can use the values through the CLI — they can never read or edit the values.
					</AlertDescription>
				</Alert>
				<ShareProjectDialog
					projectId={attached.id}
					projectName={displayProjectName(attached)}
					projectKind={attached.kind}
				>
					<Button className="w-full">
						<Share2 className="mr-1.5 size-3.5" />
						Invite people to {displayProjectName(attached)}
					</Button>
				</ShareProjectDialog>
			</div>
		);
	} else if (shareable.length === 0) {
		body = (
			<Alert>
				<AlertTitle>Create a Project first</AlertTitle>
				<AlertDescription>
					Keys are shared through a Project. Create one on the Projects page, then come back here.
				</AlertDescription>
			</Alert>
		);
	} else {
		body = (
			<div className="space-y-4">
				<p className="text-sm text-muted-foreground">
					Keys are shared through a Project: put this vault in one, then invite people to it.
					Members&apos; agents can use the keys; nobody but you can read or edit the values.
				</p>
				<div className="space-y-1.5">
					<Label htmlFor="share-keys-project">Project</Label>
					<Select value={projectId} onValueChange={setProjectId}>
						<SelectTrigger id="share-keys-project" className="w-full">
							<SelectValue placeholder="Choose a Project…" />
						</SelectTrigger>
						<SelectContent>
							{candidates.map((p) => (
								<SelectItem key={p.id} value={p.id}>
									{displayProjectName(p)}
									{(vault.project_ids ?? []).includes(p.id) ? " (already added)" : ""}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<Button
					className="w-full"
					disabled={!projectId || isAttaching}
					onClick={async () => {
						const project = candidates.find((p) => p.id === projectId);
						if (!project) return;
						if ((vault.project_ids ?? []).includes(project.id)) {
							setAttached(project);
							return;
						}
						setIsAttaching(true);
						try {
							await onAttach(project.id);
							setAttached(project);
						} finally {
							setIsAttaching(false);
						}
					}}
				>
					{isAttaching ? <Spinner /> : <Plus className="size-3.5" />}
					{projectId && (vault.project_ids ?? []).includes(projectId)
						? "Continue"
						: "Add vault to Project"}
				</Button>
				{alreadyIn.length > 0 ? (
					<p className="text-xs text-muted-foreground">
						Already in: {alreadyIn.map((p) => displayProjectName(p)).join(", ")}
					</p>
				) : null}
			</div>
		);
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) reset();
			}}
		>
			<DialogTrigger asChild>
				<Button size="sm">
					<Share2 className="mr-1.5 size-3.5" />
					Share keys
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Share keys</DialogTitle>
					<DialogDescription>
						Give a teammate&apos;s agents access to {vault.name}.
					</DialogDescription>
				</DialogHeader>
				{body}
			</DialogContent>
		</Dialog>
	);
}
