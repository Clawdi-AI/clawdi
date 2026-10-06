import {
	ApiClientError,
	type Project,
	resolveAgentProjectScope,
	slugFromVaultName,
} from "@clawdi/shared/api";
import { vaultsSurfaceClasses } from "@clawdi/shared/ui";
import {
	compareVaultsForCatalog,
	vaultFormCopy as copy,
	fetchAgentProjectVaults,
	getProjectResourceDefinition,
	identityFor,
	vaultSearchRank,
} from "@clawdi/shared/view";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Plus } from "lucide-react-native";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
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
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { NativeList } from "@/components/ui/native-list";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text } from "@/components/ui/text";
import { WebText, WebView } from "@/components/ui/web-layout";
import { useCompleteVaultCatalog } from "@/components/vault/project-vault-catalog";
import { VaultCard } from "@/components/vault/vault-card";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useHeaderSearch } from "@/platform/navigation/native-header";
import { useSheet } from "@/platform/navigation/use-sheet";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
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
	const [search, setSearch] = useState("");
	const projects = useCloudProjects();
	const catalog = useVaultCatalog(search, project?.id, true, agentProjectIds);
	const canCreate =
		!agentId &&
		(!project || (project.is_owner && project.kind !== "environment" && !project.archived_at));
	const items = [
		...new Map((catalog.data?.pages.flatMap((p) => p.items) ?? []).map((v) => [v.id, v])).values(),
	].sort((a, b) => compareVaultsForCatalog(a, b, search));
	const names = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
	const filterableProjects = (projects.data ?? [])
		.filter((p) => p.vault_count > 0)
		.filter((p) => !agentProjectIds || agentProjectIds.includes(p.id))
		.sort((a, b) => b.vault_count - a.vault_count || a.name.localeCompare(b.name));
	const card = (item: (typeof items)[number]) => (
		<VaultCard key={item.id} vault={item} names={names} />
	);

	const listRows = [
		...items.filter((v) => v.is_owner !== false),
		...items.filter((v) => v.is_owner === false),
	];
	const searchOptions = useHeaderSearch({
		value: search,
		onChange: setSearch,
		placeholder: t("libraryPort.searchVaults"),
	});
	return (
		<SafeAreaScreen>
			<Stack.Screen
				options={{ headerSearchBarOptions: searchOptions, headerLargeTitleEnabled: !agentId }}
			/>
			<NativeList
				data={listRows}
				keyExtractor={(item) => item.id}
				refreshing={catalog.isRefetching && !catalog.isFetchingNextPage}
				onRefresh={() => void catalog.refetch()}
				hasMore={catalog.hasNextPage}
				loadingMore={catalog.isFetching}
				onLoadMore={() => void catalog.fetchNextPage().catch(() => undefined)}
				header={
					<>
						{agentId ? <AgentSectionNavigation agentId={agentId} section="vaults" /> : null}
						<PageHeader
							title={getProjectResourceDefinition("vaults").label}
							description={
								agentId
									? t("libraryPort.agentVaultsDescription")
									: getProjectResourceDefinition("vaults").managementDescription
							}
							headerMenu={
								canCreate
									? {
											label: getProjectResourceDefinition("vaults").label,
											items: [
												{
													id: "add",
													label: t("libraryPort.addKeys"),
													onPress: () => router.push("/vault/add-keys"),
												},
												{
													id: "create",
													label: t("libraryPort.createVault"),
													onPress: () =>
														router.push({
															pathname: "/vault/new",
															params: { projectId: project?.id ?? "" },
														}),
												},
											],
										}
									: undefined
							}
						/>
						<ListToolbar
							filters={
								filterableProjects.length > 1 ? (
									<>
										<FilterChip
											active={!project}
											onClick={() => router.setParams({ projectId: undefined })}
										>
											<Text>All vaults {items.length}</Text>
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
					</>
				}
				renderItem={({ item, index }) => (
					<>
						{item.is_owner === false && (index === 0 || listRows[index - 1]?.is_owner !== false) ? (
							<>
								<SectionLabel count={items.filter((v) => v.is_owner === false).length}>
									{t("libraryPort.shared")}
								</SectionLabel>
								<WebText recipe={vaultsSurfaceClasses.description}>
									{t("libraryPort.sharedVaults")}
								</WebText>
							</>
						) : null}
						{card(item)}
					</>
				)}
				empty={
					catalog.isPending ? (
						<HeroCardSkeleton />
					) : !catalog.error ? (
						<EmptyState
							title={t("libraryPort.noVaults")}
							description={t("libraryPort.emptyVaults")}
						/>
					) : null
				}
			/>
		</SafeAreaScreen>
	);
}
export function VaultCreateScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ projectId?: string }>();
	return (
		<VaultCreate
			key={`${scope.identity}:${scope.generation}:${params.projectId ?? "all"}`}
			projectId={routeParam(params.projectId)}
		/>
	);
}
function VaultCreate({ projectId }: { projectId?: string }) {
	const _t = useI18n(),
		scope = useAccountScope(),
		read = useAccountRead(),
		capture = useForegroundLease();
	const { vault, cloud } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [closeError, setCloseError] = useState<unknown>();
	const catalog = useCompleteVaultCatalog();
	const slugTaken = Boolean(
		slug && catalog.data?.items.some((item) => item.is_owner !== false && item.slug === slug),
	);
	const sheet = useSheet<boolean>({ fallback: "/vault", busy: action.busy });
	const create = () =>
		action.run(async (current) => {
			const visible = capture();
			if (!visible() || !name.trim() || !slug || slugTaken || catalog.isFetching || catalog.isError)
				return;
			if (projectId) {
				const fresh = (await read((signal) => cloud.listProjects(signal))).find(
					(p) => p.id === projectId,
				);
				if (!fresh?.is_owner || fresh.archived_at || fresh.kind === "environment")
					throw new Error("Project unavailable");
			}
			if (!current() || !visible()) return;
			await read((s) =>
				projectId
					? vault.createInProject(projectId, { name: name.trim(), slug }, s)
					: vault.create({ name: name.trim(), slug }, s),
			);
			if (!current()) return;
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
			if (current() && visible()) await sheet.close(true);
		});
	return (
		<SheetPage
			title={copy.title}
			description={copy.description}
			fallback="/vault"
			busy={action.busy}
			sheet={sheet}
		>
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
				<WebView recipe={vaultsSurfaceClasses.form}>
					<Button
						variant="ghost"
						disabled={action.busy}
						onPress={() => void sheet.close().catch(setCloseError)}
					>
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
				</WebView>
			</WebView>
			{closeError ? <ApiErrorPanel error={closeError} /> : null}
		</SheetPage>
	);
}
