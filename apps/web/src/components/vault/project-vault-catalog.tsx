"use client";

import { useMutation } from "@tanstack/react-query";
import { Link2, Unlink } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import type { AgentProjectBinding } from "@/components/dashboard/agent-project-scope";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { ListToolbar } from "@/components/list-toolbar";
import { displayProjectName } from "@/components/projects/project-metadata";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { useVaultCatalog } from "@/components/vault/vault-catalog-query";
import { compareVaultsForCatalog, vaultSearchRank } from "@/components/vault/vault-search";
import { VaultCard, VaultCardSkeleton } from "@/components/vault/vaults-surface";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";
import { LIBRARY_RESOURCE_SCOPE, type ResourceNavigationScope } from "@/lib/resource-navigation";

type Vault = components["schemas"]["VaultResponse"];
type Project = components["schemas"]["ProjectResponse"];

export function ProjectVaultCatalog({
	project,
	attachedVaults,
	isLoading,
	error,
	onRetry,
	scope,
	agentBindings,
	onChanged,
}: {
	project: Project;
	attachedVaults: Vault[] | undefined;
	isLoading: boolean;
	error: unknown;
	onRetry: () => void;
	scope: ResourceNavigationScope;
	agentBindings: readonly AgentProjectBinding[] | undefined;
	onChanged: () => Promise<void>;
}) {
	const api = useApi();
	const projects = useOpenApi().useQuery("get", "/v1/projects", {});
	const projectNames = new Map(
		(projects.data ?? []).map((row) => [row.id, displayProjectName(row)]),
	);
	projectNames.set(project.id, displayProjectName(project));
	const [search, setSearch] = useState("");
	const locked = useRef(false);
	const canAttach = project.is_owner !== false;
	const catalog = useVaultCatalog({ enabled: canAttach });
	const context = project.kind === "environment" ? "Workspace" : "Project";
	const attachedIds = new Set(attachedVaults?.map((vault) => vault.id));
	const attachmentsKnown = attachedVaults !== undefined && !error;
	// Scoped rows remain visible even when the account catalog is unavailable.
	const rows = Array.from(
		new Map(
			[...(attachedVaults ?? []), ...(canAttach ? (catalog.data?.items ?? []) : [])].map(
				(vault) => [vault.id, vault],
			),
		).values(),
	)
		.filter((vault) => vaultSearchRank(vault, search) !== null)
		.sort(
			(a, b) =>
				Number(a.is_owner === false) - Number(b.is_owner === false) ||
				compareVaultsForCatalog(a, b, search),
		);
	const updateAttachment = useMutation({
		mutationFn: async ({ vault, attached }: { vault: Vault; attached: boolean }) => {
			if (!canAttach || !attachmentsKnown || vault.is_owner === false)
				throw new Error("Refresh Vault attachments and try again.");
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
						await api.POST("/v1/vault", {
							params: { query: { project_id: project.id } },
							body: { slug: vault.slug, name: vault.name },
						}),
					);
		},
		onSuccess: async (_, { attached }) => {
			await onChanged();
			toast.success(`Vault ${attached ? "detached from" : "attached to"} ${context}`);
		},
		onError: (error) =>
			toast.error("Couldn't update Vault attachment", { description: normalizeApiError(error) }),
		onSettled: () => {
			locked.current = false;
		},
	});

	return (
		<div className="space-y-4" data-testid="project-vault-catalog">
			<ListToolbar
				search={
					<SearchInput
						value={search}
						onChange={setSearch}
						placeholder="Search Vaults…"
						ariaLabel="Search Vaults"
					/>
				}
			/>
			{canAttach ? (
				<p className="text-sm text-muted-foreground">
					Vaults from your Library. Attach to this {context} to grant access. Detaching keeps the
					Vault and its other attachments.
				</p>
			) : null}
			{error ? (
				<ApiErrorPanel
					error={error}
					onRetry={onRetry}
					title={`Couldn't load ${context} Vault attachments`}
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
				<div className={HERO_GRID_CLASS}>
					{rows.map((vault) => {
						const attached = attachmentsKnown && attachedIds.has(vault.id);
						const inherited =
							scope.kind === "agent" && !attached
								? agentBindings?.find(
										(binding) =>
											binding.project_id !== project.id &&
											vault.project_ids.includes(binding.project_id),
									)
								: undefined;
						const pending =
							updateAttachment.isPending && updateAttachment.variables.vault.id === vault.id;
						return (
							<div key={vault.id} data-testid="project-vault-card" className="min-w-0">
								<VaultCard
									vault={vault}
									projectNameById={projectNames}
									projectNamesUnavailable={Boolean(projects.error)}
									visibleProjectIds={null}
									projectId={attached ? project.id : undefined}
									navigationScope={attached ? scope : LIBRARY_RESOURCE_SCOPE}
									shared={vault.is_owner === false}
									searchQuery={search.trim() || undefined}
									status={
										attachmentsKnown
											? attached
												? `Attached to ${context}`
												: inherited
													? inherited.binding_type === "primary"
														? "Via Workspace"
														: "Via linked Project"
													: scope.kind === "agent" && !agentBindings
														? "Agent access unavailable"
														: "Not attached"
											: "Attachment status unavailable"
									}
									primaryAction={
										canAttach && vault.is_owner !== false ? (
											<Button
												size="sm"
												variant={attached ? "outline" : "default"}
												disabled={
													!attachmentsKnown || updateAttachment.isPending || Boolean(catalog.error)
												}
												aria-label={`${attached ? "Detach" : "Attach"} ${vault.name} ${attached ? "from" : "to"} ${context}`}
												onClick={() => {
													if (locked.current) return;
													locked.current = true;
													updateAttachment.mutate({ vault, attached });
												}}
											>
												{pending ? (
													<Spinner className="size-3.5" />
												) : attached ? (
													<Unlink className="size-3.5" />
												) : (
													<Link2 className="size-3.5" />
												)}
												{attachmentsKnown ? (attached ? "Detach" : "Attach") : "Unavailable"}
											</Button>
										) : undefined
									}
								/>
							</div>
						);
					})}
				</div>
			) : isLoading || (canAttach && catalog.isLoading) ? (
				<div className={HERO_GRID_CLASS}>
					{Array.from({ length: 3 }).map((_, index) => (
						<VaultCardSkeleton key={index} />
					))}
				</div>
			) : !error && !catalog.error ? (
				<EmptyState
					variant="inset"
					description={search.trim() ? "No Vaults match that search." : "No Vaults available yet."}
				/>
			) : null}
		</div>
	);
}
