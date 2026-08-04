"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
	ArrowLeft,
	Check,
	Copy as CopyIcon,
	ExternalLink,
	FolderInput,
	ListChecks,
	Plus,
	Search,
	Share2,
	Trash2,
} from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { BulkActionBar } from "@/components/bulk-action-bar";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { effectiveAgentProjectIds } from "@/components/dashboard/agent-project-scope";
import { DetailNotFound, DetailPanel } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
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
import { resolveLegacyVaultSummary } from "@/components/vault/vault-detail-resolution";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import { isApiNotFoundError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { decodeResourceRouteParam } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import {
	libraryManagementTarget,
	projectDetailLink,
	type ResourceNavigationScope,
	resourceCollectionTarget,
	vaultDetailHrefForScope,
} from "@/lib/resource-navigation";
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

export default function VaultDetailPage({
	slug: rawSlug,
	scope,
}: {
	slug: string;
	scope: ResourceNavigationScope;
}) {
	const slug = decodeResourceRouteParam(rawSlug);
	const [vaultId] = useQueryState("vault", parseAsString);
	const api = useApi();
	const $api = useOpenApi();
	const qc = useQueryClient();
	const router = useRouter();
	const backTarget = resourceCollectionTarget(scope, "vaults");
	const managementTarget = libraryManagementTarget("vaults", { vaultSlug: slug, vaultId });
	const isAgentScope = scope.kind === "agent";
	const requestedProjectId =
		scope.kind === "agent" && scope.projectId?.trim() ? scope.projectId.trim() : null;
	const scopedBindings = useAgentProjectBindings(scope.kind === "agent" ? scope.agentId : "", {
		enabled: scope.kind === "agent",
	});
	const scopedProjectIds = useMemo(
		() => effectiveAgentProjectIds(scopedBindings.data ?? []),
		[scopedBindings.data],
	);
	const scopedProjectIdSet = useMemo(() => new Set(scopedProjectIds), [scopedProjectIds]);

	// UUID links use an exact authorized metadata lookup. Slug-only deep links
	// remain a compatibility fallback for bookmarks created before stable IDs.
	const vaultDetail = useQuery({
		queryKey: ["vault-detail", slug, vaultId],
		queryFn: async () => {
			if (vaultId) {
				return unwrap(
					await api.GET("/v1/vault/detail", {
						params: { query: { vault_id: vaultId, slug } },
					}),
				);
			}
			// Reuse the backend's canonical slug resolver first. It returns 409
			// when more than one visible Vault owns this slug, so legacy links
			// fail closed before list metadata is considered.
			await unwrap(
				await api.GET("/v1/vault/{slug}/items", {
					params: { path: { slug }, query: {} },
				}),
			);
			const listing = unwrap(
				await api.GET("/v1/vault", { params: { query: { q: slug, page_size: 200 } } }),
			);
			return resolveLegacyVaultSummary(listing.items, slug);
		},
	});
	const vault: VaultSummary | null = vaultDetail.data ?? null;
	const isOwner = vault?.is_owner !== false;
	const anyProjectId = isAgentScope
		? requestedProjectId
			? scopedProjectIdSet.has(requestedProjectId) &&
				vault?.project_ids?.includes(requestedProjectId)
				? requestedProjectId
				: undefined
			: vault?.project_ids?.find((projectId) => scopedProjectIdSet.has(projectId))
		: vault?.project_ids?.[0];
	const canonicalAgentProjectId =
		isAgentScope && !requestedProjectId
			? (vault?.project_ids?.find((projectId) => scopedProjectIdSet.has(projectId)) ?? null)
			: null;
	const canonicalAgentVaultHref =
		scope.kind === "agent" && canonicalAgentProjectId && vault
			? vaultDetailHrefForScope({ ...scope, projectId: canonicalAgentProjectId }, slug, vault.id)
			: null;

	useEffect(() => {
		if (!canonicalAgentVaultHref) return;
		void router.navigate({ href: canonicalAgentVaultHref, replace: true, resetScroll: false });
	}, [canonicalAgentVaultHref, router]);

	const projects = $api.useQuery("get", "/v1/projects", {});
	const projectById = useMemo(
		() => new Map((projects.data ?? []).map((p) => [p.id, p])),
		[projects.data],
	);

	const keys = useQuery({
		queryKey: ["vault-items", vault?.id, slug, anyProjectId],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/vault/{slug}/items", {
					params: {
						path: { slug },
						query: { project_id: anyProjectId ?? undefined, vault_id: vault?.id },
					},
				}),
			),
		enabled: !!vault && (!isAgentScope || !!anyProjectId),
	});
	const keyNames = useMemo(() => {
		if (!keys.data) return [];
		return Object.entries(keys.data).flatMap(([section, names]) =>
			names.map((name) => ({ section, name })),
		);
	}, [keys.data]);
	const blockingVaultDetailError =
		isApiNotFoundError(vaultDetail.error) ||
		shouldBlockQueryError(vaultDetail.error, vaultDetail.data)
			? vaultDetail.error
			: null;
	const blockingKeysError = shouldBlockQueryError(keys.error, keys.data) ? keys.error : null;
	const blockingProjectsError = shouldBlockQueryError(projects.error, projects.data)
		? projects.error
		: null;
	const blockingScopeError = isAgentScope
		? shouldBlockQueryError(scopedBindings.error, scopedBindings.data)
			? scopedBindings.error
			: null
		: null;

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
		qc.invalidateQueries({ queryKey: ["get", "/v1/vault"] });
		qc.invalidateQueries({ queryKey: ["vault-items", vault?.id, slug] });
		qc.invalidateQueries({ queryKey: ["vault-detail", slug] });
		qc.invalidateQueries({ queryKey: ["vaults", "agent-projects"] });
	};

	const deleteKey = useMutation({
		mutationFn: async ({ section, name }: { section: string; name: string }) => {
			if (!anyProjectId) throw new Error("No Project attachment");
			return unwrap(
				await api.DELETE("/v1/vault/{slug}/items", {
					params: {
						path: { slug },
						query: { project_id: anyProjectId, vault_id: vault?.id, global_delete: true },
					},
					body: { section: apiSection(section), fields: [name] },
				}),
			);
		},
		onSuccess: () => {
			refresh();
			toast.success("Key deleted", {
				description: "Every Agent using a Project attached to this Vault loses the key.",
			});
		},
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
								query: { project_id: anyProjectId, vault_id: vault?.id, global_delete: true },
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
			toast.success(`${n} ${n === 1 ? "key" : "keys"} deleted`, {
				description: "Every Agent using a Project attached to this Vault loses these keys.",
			});
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
			toast.success("Vault added to Project", {
				description: "Every Agent using that Project can now access this Vault.",
			});
		},
		onError: (e) => toast.error("Couldn't add vault to Project", { description: errorMessage(e) }),
	});

	const detachProject = useMutation({
		mutationFn: async (projectId: string) =>
			unwrap(
				await api.DELETE("/v1/vault/{slug}", {
					params: { path: { slug }, query: { project_id: projectId, vault_id: vault?.id } },
				}),
			),
		onSuccess: () => {
			refresh();
			toast.success("Vault removed from Project", {
				description:
					"Every Agent using that Project loses access. Other attached Projects keep the Vault.",
			});
		},
		onError: (e) =>
			toast.error("Couldn't remove vault from Project", { description: errorMessage(e) }),
	});

	const deleteVault = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.DELETE("/v1/vault/{slug}", {
					params: { path: { slug }, query: { vault_id: vault?.id } },
				}),
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["get", "/v1/vault"] });
			qc.invalidateQueries({ queryKey: ["vaults", "agent-projects"] });
			qc.removeQueries({ queryKey: ["vault-items", vault?.id, slug] });
			toast.success("Vault deleted", {
				description: `${vault?.name ?? slug} and its keys were removed for every Agent and Project using it.`,
			});
			void router.navigate({ href: backTarget.href });
		},
		onError: (e) => toast.error("Couldn't delete vault", { description: errorMessage(e) }),
	});

	useSetBreadcrumbTitle(vault?.name ?? null);

	if (vaultDetail.isLoading || (isAgentScope && scopedBindings.isLoading)) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<Button
					render={<Link to={backTarget.href} />}
					nativeButton={false}
					variant="ghost"
					size="sm"
					className="w-fit"
				>
					<ArrowLeft className="size-4" />
					Back to {backTarget.label}
				</Button>
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

	if (blockingVaultDetailError || blockingScopeError) {
		const blockingError = blockingVaultDetailError ?? blockingScopeError;
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<Button
					render={<Link to={backTarget.href} />}
					nativeButton={false}
					variant="ghost"
					size="sm"
					className="w-fit"
				>
					<ArrowLeft className="mr-1.5 size-4" />
					Back to {backTarget.label}
				</Button>
				{isApiNotFoundError(blockingError) ? (
					<DetailNotFound
						title="Vault not found"
						message="This vault may have been removed, or your account no longer has access."
					/>
				) : (
					<ApiErrorPanel
						error={blockingError}
						onRetry={() => {
							if (blockingVaultDetailError) void vaultDetail.refetch();
							if (blockingScopeError) void scopedBindings.refetch();
						}}
						title={blockingScopeError ? "Couldn't load Agent Vault access" : "Couldn't load vault"}
					/>
				)}
			</div>
		);
	}

	if (!vault) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<Button
					render={<Link to={backTarget.href} />}
					nativeButton={false}
					variant="ghost"
					size="sm"
					className="w-fit"
				>
					<ArrowLeft className="mr-1.5 size-4" />
					Back to {backTarget.label}
				</Button>
				<DetailNotFound
					title="Vault not found"
					message="This vault may have been removed, or your account no longer has access."
				/>
			</div>
		);
	}

	const isAvailableToAgent =
		!isAgentScope ||
		(requestedProjectId
			? scopedProjectIdSet.has(requestedProjectId) &&
				(vault.project_ids ?? []).includes(requestedProjectId)
			: (vault.project_ids ?? []).some((projectId) => scopedProjectIdSet.has(projectId)));
	if (!isAvailableToAgent) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<Button
					render={<Link to={backTarget.href} />}
					nativeButton={false}
					variant="ghost"
					size="sm"
					className="w-fit"
				>
					<ArrowLeft className="mr-1.5 size-4" />
					Back to {backTarget.label}
				</Button>
				<DetailNotFound
					title="Vault not available to this Agent"
					message="This Vault is no longer available through the Agent's Projects. It remains in the resource library if your account still has access."
				/>
				<Button
					render={<Link to={managementTarget.href} />}
					nativeButton={false}
					variant="ghost"
					size="sm"
					className="w-fit text-muted-foreground"
				>
					<ExternalLink className="size-3.5" />
					{managementTarget.label}
				</Button>
			</div>
		);
	}

	const attachedProjects = (vault.project_ids ?? [])
		.filter((id) => !isAgentScope || scopedProjectIdSet.has(id))
		.map((id) => projectById.get(id))
		.filter((p): p is ProjectRow => !!p);
	const vaultIdentity = identityFor(vault.name);

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6")}>
			<PageHeader
				title={vault.name}
				icon={
					<span
						className={cn(
							"flex size-11 shrink-0 select-none items-center justify-center rounded-xl text-2xl leading-none",
							vaultIdentity.colorClasses,
						)}
					>
						{vaultIdentity.emoji}
					</span>
				}
				description={
					isAgentScope
						? requestedProjectId
							? "Attached to this Project. Vault changes affect every Project and Agent using this Vault."
							: "This Agent can use these keys through the Projects shown below. Vault changes affect every attached Project."
						: isOwner
							? "Keys live here once and work in every Project this Vault is added to."
							: "Shared with you — your Agents can use these keys; only the owner edits them."
				}
				status={
					<span className="font-mono text-xs text-muted-foreground">vault://{vault.slug}</span>
				}
				actions={
					<>
						<Button
							render={<Link to={backTarget.href} />}
							nativeButton={false}
							variant="outline"
							size="sm"
						>
							<ArrowLeft className="size-4" />
							Back to {backTarget.label}
						</Button>
						{isAgentScope ? (
							<Button
								render={<Link to={managementTarget.href} />}
								nativeButton={false}
								variant="ghost"
								size="sm"
								className="shrink-0 text-muted-foreground"
							>
								<ExternalLink className="size-3.5" />
								{managementTarget.label}
							</Button>
						) : isOwner ? (
							<ShareKeysDialog
								vault={vault}
								projects={projects.data ?? []}
								onAttach={(projectId) => attachProject.mutateAsync(projectId)}
							/>
						) : null}
						{isOwner ? (
							<ConfirmAction
								title={`Delete ${vault.name}?`}
								description={
									<p>
										Every key in this Vault is removed for every Project using it. Agents lose
										access immediately.
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
									<Trash2 className="size-3.5" />
									Delete
								</Button>
							</ConfirmAction>
						) : null}
					</>
				}
			/>

			{isAgentScope ? (
				<DetailPanel className="space-y-1">
					<h2 className="text-sm font-semibold">Agent access</h2>
					<p className="text-xs text-muted-foreground">
						Available through {attachedProjects.length} Agent{" "}
						{attachedProjects.length === 1 ? "Project" : "Projects"}. Vaults do not attach directly
						to Agents, so there is no Agent-only Vault relationship to remove.
					</p>
				</DetailPanel>
			) : null}

			{/* Keys */}
			<section className="space-y-3">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h2 className="text-sm font-semibold">Keys</h2>
							{blockingKeysError ? (
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
					<div className="flex w-full flex-col gap-2 sm:w-auto sm:shrink-0 sm:flex-row sm:items-center">
						{keyNames.length > 0 ? (
							<>
								<div className="relative w-full sm:w-auto">
									<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
									<Input
										value={search}
										onChange={(e) => setSearch(e.target.value)}
										placeholder="Search keys…"
										aria-label="Search keys"
										className="h-8 w-full pl-8 text-sm sm:w-52"
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
										className="w-full sm:w-auto"
									>
										<ListChecks className="size-3.5" />
										{selectMode ? "Done" : "Select"}
									</Button>
								) : null}
							</>
						) : null}
						{!isAgentScope && isOwner && prefixGroups.length >= 2 ? (
							<SplitVaultDialog
								vault={vault}
								groups={prefixGroups}
								onDone={() => clearSelection()}
							/>
						) : null}
						{isOwner ? (
							<AddKeysDialog vaultSlug={slug} vaultId={vault.id} vaultProjectId={anyProjectId}>
								<Button
									variant="outline"
									size="sm"
									disabled={!anyProjectId}
									className="w-full sm:w-auto"
								>
									<Plus className="size-3.5" />
									Add keys
								</Button>
							</AddKeysDialog>
						) : null}
					</div>
				</div>
				{isOwner && selectMode && filteredKeyNames.length > 0 ? (
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
				) : blockingKeysError ? (
					<ApiErrorPanel
						error={blockingKeysError}
						onRetry={() => {
							void keys.refetch();
						}}
						title="Couldn't load vault keys"
					/>
				) : keyNames.length === 0 ? (
					<EmptyState
						variant="inset"
						title="No keys yet"
						description={
							isAgentScope
								? "This Vault currently has no keys available to the Agent."
								: "Add one above or paste several at once with Import."
						}
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
										<TooltipTrigger
											render={<span className="min-w-0 flex-1 truncate font-mono text-xs" />}
										>
											{/* "(default)" is the backend's implicit section — noise, hide it. */}
											{section && section !== "(default)" ? `${section}/` : ""}
											{name}
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
											onConfirm={() => {
												if (!deleteKey.isPending) deleteKey.mutate({ section, name });
											}}
										>
											<Button
												variant="ghost"
												size="icon-xs"
												disabled={deleteKey.isPending}
												className="text-muted-foreground opacity-100 transition-opacity duration-150 hover:text-destructive sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
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

			{isOwner ? (
				<BulkActionBar count={selectedKeys.size} noun="key" onClear={clearSelection}>
					{!isAgentScope ? (
						<>
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
						</>
					) : null}
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
			) : null}

			{/* Projects */}
			<section id="projects" className="scroll-mt-20 space-y-3">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h2 className="text-sm font-semibold">Projects</h2>
							{projects.isLoading ? null : (
								<Badge variant="secondary" className="tabular-nums">
									{blockingProjectsError ? "—" : attachedProjects.length}
								</Badge>
							)}
						</div>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{isAgentScope
								? "This Agent gets Vault access through these Projects. Use the resource library only for broader attachment changes."
								: "Same vault everywhere — key changes apply to every Project here. Agents bound to these Projects resolve the keys at runtime."}
						</p>
					</div>
					{!isAgentScope && isOwner && !blockingProjectsError ? (
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
				) : blockingProjectsError ? (
					<ApiErrorPanel
						error={blockingProjectsError}
						onRetry={() => {
							void projects.refetch();
						}}
						title="Couldn't load attached Projects"
					/>
				) : attachedProjects.length === 0 ? (
					<EmptyState
						variant="inset"
						title={isAgentScope ? "Project details unavailable" : "Not added to any Project yet"}
						description={
							isAgentScope
								? "Refresh to load the Agent Projects that provide this Vault."
								: "Agents can't use these keys until this vault is added to a Project."
						}
					/>
				) : (
					<div className="divide-y overflow-hidden rounded-lg border bg-card">
						{attachedProjects.map((project) => (
							<div key={project.id} className="flex items-center gap-3 px-4 py-2.5">
								<Link
									{...projectDetailLink(scope, project.id)}
									className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
								>
									{displayProjectName(project)}
								</Link>
								<span className="font-mono text-xs text-muted-foreground">{project.slug}</span>
								{requestedProjectId === project.id ? (
									<Badge variant="secondary" className="shrink-0">
										Current Project
									</Badge>
								) : null}
								{!isAgentScope && isOwner && (vault.project_ids?.length ?? 0) > 1 ? (
									<ConfirmAction
										title={`Remove from ${displayProjectName(project)}?`}
										description={<p>Agents using that Project lose access to these keys.</p>}
										confirmLabel="Remove"
										destructive
										onConfirm={() => {
											if (!detachProject.isPending) detachProject.mutate(project.id);
										}}
									>
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={detachProject.isPending}
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
	const projectItems = projects.map((project) => ({
		value: project.id,
		label: displayProjectName(project),
	}));
	if (projects.length === 0) return null;
	return (
		<div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
			<Select
				items={projectItems}
				value={value}
				onValueChange={(nextValue) => {
					if (nextValue !== null) setValue(nextValue);
				}}
			>
				<SelectTrigger
					size="sm"
					className="w-full sm:w-44"
					aria-label="Project to add this vault to"
				>
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
				className="w-full sm:w-auto"
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
	const candidateItems = candidates.map((project) => ({
		value: project.id,
		label: `${displayProjectName(project)}${
			(vault.project_ids ?? []).includes(project.id) ? " (already added)" : ""
		}`,
	}));

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
					<Select
						items={candidateItems}
						value={projectId}
						onValueChange={(value) => {
							if (value !== null) setProjectId(value);
						}}
					>
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
			}}
			onOpenChangeComplete={(next) => {
				if (!next) reset();
			}}
		>
			<DialogTrigger render={<Button size="sm" />}>
				<Share2 className="mr-1.5 size-3.5" />
				Share keys
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
