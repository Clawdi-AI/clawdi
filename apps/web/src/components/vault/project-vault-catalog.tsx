"use client";

import { projectVaultCatalogClasses } from "@clawdi/shared/ui";
import {
	displayProjectName,
	isCustomProject,
	PROJECT_VAULT_COPY,
	projectVaultCatalogDescription,
	projectVaultCatalogRows,
} from "@clawdi/shared/view";
import { useMutation } from "@tanstack/react-query";
import { parseAsString, useQueryState } from "nuqs";
import { useRef } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { ListToolbar } from "@/components/list-toolbar";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { useVaultCatalog } from "@/components/vault/vault-catalog-query";
import { VaultCard, VaultCardSkeleton } from "@/components/vault/vaults-surface";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";
import { shouldBlockQueryError } from "@/lib/query-state";
import {
	agentResourceScope,
	LIBRARY_RESOURCE_SCOPE,
	type ResourceNavigationScope,
	resourceCollectionTarget,
} from "@/lib/resource-navigation";
import { useCommittedLocation } from "@/lib/use-committed-location";

type Vault = components["schemas"]["VaultResponse"];
type Project = components["schemas"]["ProjectResponse"];

export function ProjectVaultCatalog({
	project,
	attachedVaults,
	attachedVaultsUpdatedAt,
	isLoading,
	error,
	onRetry,
	scope,
	onChanged,
}: {
	project: Project;
	attachedVaults: Vault[] | undefined;
	attachedVaultsUpdatedAt: number;
	isLoading: boolean;
	error: unknown;
	onRetry: () => void;
	scope: ResourceNavigationScope;
	onChanged: () => Promise<void>;
}) {
	const api = useApi();
	const projects = useOpenApi().useQuery("get", "/v1/projects", {});
	const projectNames = new Map(
		(projects.data ?? []).map((row) => [row.id, displayProjectName(row)]),
	);
	projectNames.set(
		project.id,
		scope.kind === "agent" && project.kind === "environment"
			? "Workspace"
			: displayProjectName(project),
	);
	const [search, setSearch] = useQueryState(
		"q",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true, history: "replace" }),
	);
	const location = useCommittedLocation();
	const returnSearch = new URLSearchParams();
	for (const [key, value] of Object.entries(location.search)) {
		if (typeof value === "string") returnSearch.set(key, value);
	}
	if (search) returnSearch.set("q", search);
	else returnSearch.delete("q");
	const returnHref = `${location.pathname}${returnSearch.size ? `?${returnSearch}` : ""}`;
	const locked = useRef(false);
	const canAttach = isCustomProject(project) && project.is_owner !== false;
	const catalog = useVaultCatalog({ enabled: canAttach });
	const context = project.kind === "environment" ? "Workspace" : "Project";
	const attachedIds = new Set(attachedVaults?.map((vault) => vault.id));
	const attachmentsKnown = attachedVaults !== undefined;
	const rows = projectVaultCatalogRows({
		projectId: project.id,
		attachedVaults,
		attachedVaultsUpdatedAt,
		catalogVaults: canAttach ? (catalog.data?.items ?? []) : [],
		catalogUpdatedAt: catalog.dataUpdatedAt,
		search,
	});
	const groups = attachmentsKnown
		? [
				{ label: `In this ${context}`, rows: rows.filter((vault) => attachedIds.has(vault.id)) },
				{ label: "Available", rows: rows.filter((vault) => !attachedIds.has(vault.id)) },
			]
		: [{ label: null, rows }];
	const updateAttachment = useMutation({
		mutationFn: async ({ vault, attached }: { vault: Vault; attached: boolean }) => {
			if (
				!canAttach ||
				!attachmentsKnown ||
				error ||
				vault.is_owner === false ||
				(!attached && (catalog.data === undefined || catalog.error))
			)
				throw new Error("Refresh Vault links and try again.");
			return attached
				? unwrap(
						await api.DELETE("/v1/vault/{slug}", {
							params: {
								path: { slug: vault.slug },
								query: { project_id: project.id, vault_id: vault.id },
							},
						}),
					)
				: unwrap(
						await api.POST("/v1/vault/{slug}/attachments/{project_id}", {
							params: {
								path: { slug: vault.slug, project_id: project.id },
								query: { vault_id: vault.id },
							},
						}),
					);
		},
		onSuccess: async (_, { attached }) => {
			await onChanged();
			toast.success(`Vault ${attached ? "removed from" : "added to"} ${context}`);
		},
		onError: (error) =>
			toast.error("Couldn't update Project Vaults", { description: normalizeApiError(error) }),
		onSettled: () => {
			locked.current = false;
		},
	});

	return (
		<div className={projectVaultCatalogClasses.root} data-testid="project-vault-catalog">
			<ListToolbar
				search={
					<SearchInput
						value={search}
						onChange={setSearch}
						placeholder={PROJECT_VAULT_COPY.searchPlaceholder}
						ariaLabel={PROJECT_VAULT_COPY.searchLabel}
					/>
				}
			/>
			{canAttach ? (
				<p className={projectVaultCatalogClasses.description}>
					{projectVaultCatalogDescription(context)}
				</p>
			) : null}
			{error ? (
				<ApiErrorPanel
					error={error}
					onRetry={onRetry}
					title={`Couldn't load ${context} Vault links`}
				/>
			) : null}
			{canAttach && catalog.error ? (
				<ApiErrorPanel
					error={catalog.error}
					onRetry={() => void catalog.refetch()}
					title="Couldn't load Vault catalog"
				/>
			) : null}
			{rows.length ? (
				groups.map((group) =>
					group.rows.length > 0 ? (
						<section
							key={group.label ?? "catalog"}
							className={projectVaultCatalogClasses.section}
							aria-label={
								group.label
									? `${group.label}${group.label === "Available" ? ` ${context}` : ""} Vaults`
									: undefined
							}
						>
							{group.label ? (
								<SectionLabel count={group.rows.length}>{group.label}</SectionLabel>
							) : null}
							<div className={HERO_GRID_CLASS}>
								{group.rows.map((vault) => {
									const attached = attachmentsKnown && attachedIds.has(vault.id);
									const pending =
										updateAttachment.isPending && updateAttachment.variables.vault.id === vault.id;
									const actionsDisabled =
										!attachmentsKnown ||
										Boolean(error) ||
										updateAttachment.isPending ||
										(!attached && (catalog.data === undefined || Boolean(catalog.error)));
									const toggleAttachment = () => {
										if (actionsDisabled || locked.current) return;
										locked.current = true;
										updateAttachment.mutate({ vault, attached });
									};
									const detailScope = attached
										? scope
										: scope.kind === "agent"
											? agentResourceScope(scope.agentId)
											: LIBRARY_RESOURCE_SCOPE;
									return (
										<div
											key={vault.id}
											data-testid="project-vault-card"
											className={projectVaultCatalogClasses.card}
										>
											<VaultCard
												vault={vault}
												projectNameById={projectNames}
												projectNamesUnavailable={shouldBlockQueryError(
													projects.error,
													projects.data,
												)}
												visibleProjectIds={null}
												projectId={attached ? project.id : undefined}
												navigationScope={detailScope}
												returnHref={
													returnHref !== resourceCollectionTarget(detailScope, "vaults").href
														? returnHref
														: undefined
												}
												shared={vault.is_owner === false}
												searchQuery={search.trim() || undefined}
												actions={
													canAttach && vault.is_owner !== false ? (
														<Button
															size="sm"
															variant={attached ? "ghost" : "default"}
															disabled={actionsDisabled}
															aria-busy={pending}
															aria-label={
																attachmentsKnown
																	? `${attached ? "Remove" : "Add"} ${vault.name} ${attached ? "from" : "to"} ${context}`
																	: `Link status unavailable for ${vault.name}`
															}
															onClick={toggleAttachment}
														>
															{pending || isLoading ? <Spinner /> : null}
															{pending
																? updateAttachment.variables.attached
																	? "Removing…"
																	: "Adding…"
																: attachmentsKnown
																	? attached
																		? "Remove"
																		: "Add"
																	: isLoading
																		? "Loading…"
																		: "Unavailable"}
														</Button>
													) : null
												}
											/>
										</div>
									);
								})}
							</div>
						</section>
					) : null,
				)
			) : isLoading || (canAttach && catalog.isLoading) ? (
				<div className={HERO_GRID_CLASS}>
					{Array.from({ length: 3 }).map((_, index) => (
						<VaultCardSkeleton key={index} />
					))}
				</div>
			) : !shouldBlockQueryError(error, attachedVaults) &&
				(!canAttach || !shouldBlockQueryError(catalog.error, catalog.data)) ? (
				<EmptyState
					variant="inset"
					description={search.trim() ? PROJECT_VAULT_COPY.noMatches : PROJECT_VAULT_COPY.empty}
				/>
			) : null}
		</div>
	);
}
