import { type Project, slugFromVaultName } from "@clawdi/shared/api";
import { HERO_GRID_CLASS, vaultsSurfaceClasses } from "@clawdi/shared/ui";
import { getProjectResourceDefinition, identityFor } from "@clawdi/shared/view";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { Plus } from "lucide-react-native";
import { useState } from "react";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { ApiErrorPanel } from "../../ui/api-error-panel";
import { Button } from "../../ui/button";
import { LibraryPage } from "../../ui/detail/layout";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { EmptyState } from "../../ui/empty-state";
import { HeroCardSkeleton } from "../../ui/entity-card";
import { FilterChip } from "../../ui/filter-chip";
import { Icon } from "../../ui/icon";
import { Input } from "../../ui/input";
import { ListToolbar } from "../../ui/list-toolbar";
import { PageHeader } from "../../ui/page-header";
import { SearchInput } from "../../ui/search-input";
import { SectionLabel } from "../../ui/section-label";
import { Text } from "../../ui/text";
import { VaultCard } from "../../ui/vault/vault-card";
import { WebText, WebView } from "../../ui/web-layout";
import { ProjectResourceBoundary } from "../project-scope";
import { useCloudProjects } from "../projects";

export function useVaultCatalog(search = "", projectId?: string, enabled = true) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const { vault } = useMobileApi();
	return useInfiniteQuery({
		queryKey: accountQueryKey(scope, "vault-catalog", search, projectId ?? "all"),
		initialPageParam: 1,
		queryFn: ({ signal, pageParam }) =>
			read(
				(s) =>
					vault.list(
						{ q: search || undefined, project_id: projectId, page: pageParam, page_size: 25 },
						s,
					),
				signal,
			),
		getNextPageParam: (page) =>
			page.items.length && page.page * page.page_size < page.total ? page.page + 1 : undefined,
		enabled: scope.isReady && enabled,
		retry: false,
	});
}

export function VaultCatalogScreen() {
	return (
		<ProjectResourceBoundary>
			{(project) => <VaultCatalog project={project} />}
		</ProjectResourceBoundary>
	);
}

function VaultCatalog({ project }: { project?: Project }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const cache = useQueryClient();
	const { vault } = useMobileApi();
	const action = useAuthAction(scope);
	const capture = useForegroundLease();
	const [search, setSearch] = useState("");
	const [open, setOpen] = useState(false);
	const projects = useCloudProjects();
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const catalog = useVaultCatalog(search, project?.id);
	const canCreate =
		!project || (project.is_owner && project.kind !== "environment" && !project.archived_at);
	const items = [
		...new Map((catalog.data?.pages.flatMap((p) => p.items) ?? []).map((v) => [v.id, v])).values(),
	];
	const create = () => {
		const visible = capture();
		return action.run(async (isCurrent) => {
			if (!visible()) return;
			if (!canCreate || !name.trim() || !slug) return;
			const body = { name: name.trim(), slug };
			const result = await read((signal) =>
				project ? vault.createInProject(project.id, body, signal) : vault.create(body, signal),
			);
			if (!isCurrent()) return;
			setName("");
			setSlug("");
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "vault-catalog") });
			if (isCurrent() && visible())
				router.push({
					pathname: "/vault/detail",
					params: { vaultId: result.id, slug: result.slug },
				});
		});
	};
	const names = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
	const card = (item: (typeof items)[number]) => (
		<VaultCard key={item.id} vault={item} names={names} />
	);
	return (
		<LibraryPage>
			<PageHeader
				title={t("vault.title")}
				description={getProjectResourceDefinition("vaults").managementDescription}
				actions={
					canCreate ? (
						<Button size="sm" onPress={() => setOpen(true)}>
							<Icon as={Plus} />
							<Text>{t("libraryPort.createVault")}</Text>
						</Button>
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
					<>
						<FilterChip
							active={!project}
							onClick={() => router.setParams({ projectId: undefined })}
						>
							<Text>All Vaults {items.length}</Text>
						</FilterChip>
						{(projects.data ?? [])
							.filter((p) => p.vault_count > 0)
							.map((p) => (
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
			<Dialog
				open={open}
				onOpenChange={(v) => {
					if (!action.busy) setOpen(v);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("libraryPort.createVault")}</DialogTitle>
					</DialogHeader>
					<Input
						value={name}
						onChangeText={(v) => {
							setName(v);
							setSlug(slugFromVaultName(v));
						}}
						maxLength={200}
						editable={!action.busy}
						placeholder={t("vault.name")}
					/>
					<Input
						value={slug}
						onChangeText={(v) => setSlug(slugFromVaultName(v))}
						maxLength={200}
						editable={!action.busy}
						placeholder={t("vault.slug")}
					/>
					{action.error ? <ApiErrorPanel error={action.error} /> : null}
					<DialogFooter>
						<Button disabled={action.busy || !name.trim() || !slug} onPress={() => void create()}>
							<Text>{t("libraryPort.createVault")}</Text>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</LibraryPage>
	);
}
