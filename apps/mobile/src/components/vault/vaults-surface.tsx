import {
	ApiClientError,
	type Project,
	resolveAgentProjectScope,
	slugFromVaultName,
} from "@clawdi/shared/api";
import { HERO_GRID_CLASS, vaultsSurfaceClasses } from "@clawdi/shared/ui";
import {
	compareVaultsForCatalog,
	vaultFormCopy as copy,
	fetchAgentProjectVaults,
	getProjectResourceDefinition,
	identityFor,
	vaultSearchRank,
} from "@clawdi/shared/view";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { Plus } from "lucide-react-native";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useMobileApi } from "@/components/api-provider";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { LibraryPage } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { HeroCardSkeleton } from "@/components/entity-card";
import { FilterChip } from "@/components/filter-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { ProjectResourceBoundary } from "@/components/projects/project-scope";
import { useCloudProjects } from "@/components/projects/projects-surface";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { AddKeysDialog } from "@/components/vault/add-keys-dialog";
import { VaultCard } from "@/components/vault/vault-card";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function useVaultCatalog(
	search = "",
	projectId?: string,
	enabled = true,
	agentProjectIds?: readonly string[],
) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const { vault } = useMobileApi();
	return useInfiniteQuery({
		queryKey: accountQueryKey(scope, "vault-catalog", search, projectId ?? "all", agentProjectIds),
		initialPageParam: 1,
		queryFn: ({ signal, pageParam }) =>
			read(async (s) => {
				if (agentProjectIds !== undefined) {
					const ids = projectId
						? agentProjectIds.filter((id) => id === projectId)
						: agentProjectIds;
					const rows = await fetchAgentProjectVaults(ids, (project_id, page, page_size) =>
						vault.list({ project_id, page, page_size }, s),
					);
					const items = rows.filter((item) => vaultSearchRank(item, search) !== null);
					return { items, total: items.length, page: 1, page_size: Math.max(1, items.length) };
				}
				return vault.list(
					{ q: search || undefined, project_id: projectId, page: pageParam, page_size: 25 },
					s,
				);
			}, signal),
		getNextPageParam: (page) =>
			page.items.length && page.page * page.page_size < page.total ? page.page + 1 : undefined,
		enabled: scope.isReady && enabled,
		retry: false,
	});
}

export function VaultCatalogScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{
		id?: string;
		agentId?: string;
		project?: string;
		projectId?: string;
	}>();
	const agentId = routeParam(params.id ?? params.agentId);
	if (agentId)
		return (
			<AgentVaultCatalog
				key={`${scope.identity}:${scope.generation}:${agentId}`}
				agentId={agentId}
				projectId={routeParam(params.projectId ?? params.project)}
			/>
		);
	return (
		<ProjectResourceBoundary>
			{(project) => <VaultCatalog project={project} />}
		</ProjectResourceBoundary>
	);
}

function AgentVaultCatalog({ agentId, projectId }: { agentId: string; projectId?: string }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { agentProjects } = useMobileApi();
	const agent = useCloudAgent(agentId);
	const projects = useCloudProjects();
	const bindings = useQuery({
		queryKey: accountQueryKey(scope, "agent-overview-bindings", agentId),
		enabled: scope.isReady,
		retry: false,
		queryFn: ({ signal }) => read((s) => agentProjects.listBindings(agentId, s), signal),
	});
	let projectIds: string[] = [];
	let scopeError: unknown;
	if (bindings.data && agent.data) {
		try {
			projectIds = resolveAgentProjectScope(
				bindings.data,
				agent.data.default_project_id,
			).projectIds;
			if (projectId && !projectIds.includes(projectId))
				scopeError = new ApiClientError(404, "project_unavailable");
		} catch (error) {
			scopeError = error;
		}
	}
	const error = scopeError || bindings.error || agent.error || projects.error;
	if (error || bindings.isPending || agent.isPending || projects.isPending)
		return (
			<LibraryPage>
				<AgentSectionNavigation agentId={agentId} section="vaults" />
				{error ? (
					<ApiErrorPanel
						error={error}
						title={t("libraryPort.agentVaultsError")}
						onRetry={() => {
							void bindings.refetch();
							void agent.refetch();
							void projects.refetch();
						}}
					/>
				) : (
					<HeroCardSkeleton />
				)}
			</LibraryPage>
		);
	return (
		<VaultCatalog
			agentId={agentId}
			agentProjectIds={projectIds}
			project={projects.data?.find((item) => item.id === projectId && projectIds.includes(item.id))}
		/>
	);
}

function VaultCatalog({
	project,
	agentId,
	agentProjectIds,
}: {
	project?: Project;
	agentId?: string;
	agentProjectIds?: readonly string[];
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const cache = useQueryClient();
	const { vault } = useMobileApi();
	const action = useAuthAction(scope);
	const capture = useForegroundLease();
	const [search, setSearch] = useState("");
	const [open, setOpen] = useState(false);
	const [addOpen, setAddOpen] = useState(false);
	const projects = useCloudProjects();
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const catalog = useVaultCatalog(search, project?.id, true, agentProjectIds);
	const canCreate =
		!agentId &&
		(!project || (project.is_owner && project.kind !== "environment" && !project.archived_at));
	const items = [
		...new Map((catalog.data?.pages.flatMap((p) => p.items) ?? []).map((v) => [v.id, v])).values(),
	].sort((a, b) => compareVaultsForCatalog(a, b, search));
	const slugTaken = Boolean(
		slug && items.some((item) => item.is_owner !== false && item.slug === slug),
	);
	const create = () => {
		const visible = capture();
		return action.run(async (isCurrent) => {
			if (!visible()) return;
			if (!canCreate || !name.trim() || !slug || slugTaken || catalog.isFetching || catalog.isError)
				return;
			const body = { name: name.trim(), slug };
			const result = await read((signal) =>
				project ? vault.createInProject(project.id, body, signal) : vault.create(body, signal),
			);
			if (!isCurrent()) return;
			setName("");
			setSlug("");
			setOpen(false);
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "vault-catalog") });
			if (isCurrent() && visible())
				router.push({
					pathname: "/vault/[slug]",
					params: { vaultId: result.id, slug: result.slug },
				});
		});
	};
	const names = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
	const filterableProjects = (projects.data ?? [])
		.filter((p) => p.vault_count > 0)
		.filter((p) => !agentProjectIds || agentProjectIds.includes(p.id))
		.sort((a, b) => b.vault_count - a.vault_count || a.name.localeCompare(b.name));
	const card = (item: (typeof items)[number]) => (
		<VaultCard key={item.id} vault={item} names={names} />
	);
	return (
		<LibraryPage>
			{agentId ? <AgentSectionNavigation agentId={agentId} section="vaults" /> : null}
			<PageHeader
				title={getProjectResourceDefinition("vaults").label}
				description={
					agentId
						? t("libraryPort.agentVaultsDescription")
						: getProjectResourceDefinition("vaults").managementDescription
				}
				actions={
					canCreate ? (
						<>
							<Button variant="outline" size="sm" onPress={() => setAddOpen(true)}>
								<Icon as={Plus} />
								<Text>{t("libraryPort.addKeys")}</Text>
							</Button>
							<Button size="sm" onPress={() => setOpen(true)}>
								<Icon as={Plus} />
								<Text>{t("libraryPort.createVault")}</Text>
							</Button>
						</>
					) : undefined
				}
			/>
			<ListToolbar
				search={
					<SearchInput
						value={search}
						onChange={setSearch}
						placeholder={t("libraryPort.searchVaults")}
					/>
				}
				filters={
					filterableProjects.length > 1 ? (
						<>
							<FilterChip
								active={!project}
								onClick={() => router.setParams({ projectId: undefined })}
							>
								<Text>All Vaults {items.length}</Text>
							</FilterChip>
							{filterableProjects.map((p) => (
								<FilterChip
									key={p.id}
									active={project?.id === p.id}
									onClick={() => router.setParams({ projectId: p.id })}
								>
									<Text>
										{identityFor(p.name).emoji} {p.name} {p.vault_count}
									</Text>
								</FilterChip>
							))}
						</>
					) : undefined
				}
			/>
			{catalog.error ? (
				<ApiErrorPanel error={catalog.error} onRetry={() => void catalog.refetch()} />
			) : null}
			<WebView recipe={HERO_GRID_CLASS}>
				{catalog.isPending
					? [0, 1, 2].map((i) => <HeroCardSkeleton key={i} />)
					: items.filter((v) => v.is_owner !== false).map(card)}
			</WebView>
			{items.some((v) => v.is_owner === false) ? (
				<WebView recipe={vaultsSurfaceClasses.section}>
					<SectionLabel count={items.filter((v) => v.is_owner === false).length}>
						{t("libraryPort.shared")}
					</SectionLabel>
					<WebText recipe={vaultsSurfaceClasses.description}>
						{t("libraryPort.sharedVaults")}
					</WebText>
					<WebView recipe={HERO_GRID_CLASS}>
						{items.filter((v) => v.is_owner === false).map(card)}
					</WebView>
				</WebView>
			) : null}
			{!catalog.isPending && !catalog.error && !items.length ? (
				<EmptyState title={t("libraryPort.noVaults")} description={t("libraryPort.emptyVaults")} />
			) : null}
			{catalog.hasNextPage ? (
				<Button
					variant="outline"
					disabled={catalog.isFetching}
					onPress={() => void catalog.fetchNextPage()}
				>
					<Text>{t("inventory.loadMore")}</Text>
				</Button>
			) : null}
			<AddKeysDialog open={addOpen} onOpenChange={setAddOpen} />
			<Dialog
				open={open}
				onOpenChange={(v) => {
					if (!action.busy) setOpen(v);
				}}
			>
				<DialogContent
					className={webView(vaultsSurfaceClasses.dialog)}
					showCloseButton={!action.busy}
				>
					<DialogHeader>
						<DialogTitle>{copy.title}</DialogTitle>
						<DialogDescription>{copy.description}</DialogDescription>
					</DialogHeader>
					<WebView recipe={vaultsSurfaceClasses.form}>
						<WebView recipe={vaultsSurfaceClasses.field}>
							<Label>{copy.name}</Label>
							<Input
								value={name}
								onChangeText={(v) => {
									setName(v);
									setSlug(slugFromVaultName(v));
								}}
								maxLength={200}
								editable={!action.busy}
								placeholder={copy.placeholder}
								accessibilityLabel={copy.name}
							/>
							{slugTaken ? (
								<WebText recipe={vaultsSurfaceClasses.error}>{copy.nameTaken}</WebText>
							) : null}
						</WebView>
						{action.error ? <ApiErrorPanel error={action.error} /> : null}
						<DialogFooter>
							<Button variant="ghost" disabled={action.busy} onPress={() => setOpen(false)}>
								<Text>{copy.cancel}</Text>
							</Button>
							<Button
								disabled={
									action.busy ||
									!name.trim() ||
									!slug ||
									slugTaken ||
									catalog.isFetching ||
									catalog.isError
								}
								onPress={() => void create()}
							>
								<Icon as={Plus} />
								<Text>{copy.title}</Text>
							</Button>
						</DialogFooter>
					</WebView>
				</DialogContent>
			</Dialog>
		</LibraryPage>
	);
}
