import { type Project, slugFromVaultName } from "@clawdi/shared/api";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { NativeButton } from "../../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../../ui/primitives";
import { InventoryList } from "../inventory-list";
import { ProjectResourceBoundary, ProjectScopeHeader } from "../project-scope";

export function useVaultCatalog(search = "", projectId?: string) {
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
		enabled: scope.isReady,
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
	const [query, setQuery] = useState("");
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const catalog = useVaultCatalog(query, project?.id);
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
	return (
		<InventoryList
			items={items}
			title={t("vault.title")}
			description={t("vault.description")}
			empty={t(catalog.isPending ? "loading.app" : "vault.empty")}
			header={
				<AppView className="gap-3">
					<ProjectScopeHeader project={project} />
					<AppTextInput
						accessibilityLabel={t("vault.search")}
						placeholder={t("vault.search")}
						value={search}
						onChangeText={setSearch}
						maxLength={200}
						className="rounded-xl bg-surface p-3 text-foreground"
					/>
					<NativeButton label={t("vault.searchAction")} onPress={() => setQuery(search.trim())} />
					{canCreate ? (
						<>
							<AppTextInput
								accessibilityLabel={t("vault.name")}
								placeholder={t("vault.name")}
								value={name}
								onChangeText={(value) => {
									setName(value);
									setSlug(slugFromVaultName(value));
								}}
								maxLength={200}
								editable={!action.busy}
								className="rounded-xl bg-surface p-3 text-foreground"
							/>
							<AppTextInput
								accessibilityLabel={t("vault.slug")}
								placeholder={t("vault.slug")}
								value={slug}
								onChangeText={(value) => setSlug(slugFromVaultName(value))}
								maxLength={200}
								autoCapitalize="none"
								autoCorrect={false}
								editable={!action.busy}
								className="rounded-xl bg-surface p-3 text-foreground"
							/>
							<NativeButton
								label={t("vault.create")}
								disabled={action.busy || !name.trim() || !slug}
								onPress={() => void create()}
							/>
							{action.error ? (
								<AppText accessibilityRole="alert">{t("vault.failed")}</AppText>
							) : null}
						</>
					) : null}
				</AppView>
			}
			renderItem={(item) => (
				<AppView className="gap-2 rounded-xl bg-surface p-4">
					<AppText className="text-lg font-semibold text-foreground">{item.name}</AppText>
					<AppText className="text-muted">
						{item.slug} · {item.item_count} {t("vault.keys")}
					</AppText>
					<AppText className="text-muted">
						{t(item.is_owner ? "vault.owner" : "vault.shared")}
					</AppText>
					<NativeButton
						label={t("vault.open")}
						onPress={() =>
							router.push({
								pathname: "/vault/detail",
								params: { vaultId: item.id, slug: item.slug },
							})
						}
					/>
				</AppView>
			)}
			refreshing={catalog.isRefetching}
			onRefresh={() => {
				if (!catalog.isFetching) void catalog.refetch();
			}}
			error={catalog.isError}
			onRetry={() => void catalog.refetch()}
			busy={catalog.isFetching}
			more={catalog.hasNextPage}
			onMore={() => {
				if (!catalog.isFetching) void catalog.fetchNextPage();
			}}
		/>
	);
}
