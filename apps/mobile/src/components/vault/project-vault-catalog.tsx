import { type Project, slugFromVaultName, type Vault } from "@clawdi/shared/api";
import { projectDetailClasses, projectVaultCatalogClasses } from "@clawdi/shared/ui";
import {
	displayProjectName,
	fetchAllPages,
	isCustomProject,
	PROJECT_VAULT_COPY,
	projectVaultCatalogDescription,
	projectVaultCatalogRows,
	projectVaultCreateDescription,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Plus } from "lucide-react-native";
import { type ReactElement, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { HeroCardSkeleton } from "@/components/entity-card";
import { HeaderActionGroup } from "@/components/header-action-group";
import { useProject } from "@/components/projects/project-scope";
import { useCloudProjects } from "@/components/projects/projects-surface";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { NativeList } from "@/components/ui/native-list";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text } from "@/components/ui/text";
import { WebText, WebView } from "@/components/ui/web-layout";
import { VaultCard } from "@/components/vault/vault-card";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useHeaderSearch } from "@/platform/navigation/native-header";
import { useSheet } from "@/platform/navigation/use-sheet";
import { useForegroundLease } from "@/platform/use-foreground-lease";

/** Complete snapshots keep attachment status independent from list pagination/search. */
export function useCompleteVaultCatalog(projectId?: string, enabled = true) {
	const scope = useAccountScope(),
		read = useAccountRead(),
		{ vault } = useMobileApi();
	return useQuery({
		queryKey: accountQueryKey(scope, "vault-catalog", "complete", projectId ?? "all"),
		queryFn: ({ signal }) =>
			read(
				(s) =>
					fetchAllPages(
						(page, page_size) => vault.list({ project_id: projectId, page, page_size }, s),
						{ resourceName: "Vault catalog" },
					),
				signal,
			),
		enabled: scope.isReady && enabled,
		retry: false,
	});
}

export function ProjectVaultCatalog({
	project,
	header,
	form = false,
}: {
	project: Project;
	header?: ReactElement;
	form?: boolean;
}) {
	const t = useI18n(),
		scope = useAccountScope(),
		read = useAccountRead(),
		{ vault, cloud } = useMobileApi();
	const cache = useQueryClient(),
		action = useAuthAction(scope),
		capture = useForegroundLease();
	const [search, setSearch] = useState(""),
		[name, setName] = useState("");
	const [closeError, setCloseError] = useState<unknown>();
	const sheet = useSheet<boolean>({
		fallback: { pathname: "/projects/[id]", params: { id: project.id, tab: "vaults" } },
		busy: action.busy,
	});
	const [removing, setRemoving] = useState<Vault | null>(null);
	const confirmationLease = useRef<() => boolean>(() => false);
	const attached = useCompleteVaultCatalog(project.id),
		canAttach = isCustomProject(project) && project.is_owner !== false && !project.archived_at;
	const catalog = useCompleteVaultCatalog(undefined, canAttach),
		projects = useCloudProjects();
	const context = project.kind === "environment" ? "Workspace" : "Project";
	const names = new Map((projects.data ?? []).map((p) => [p.id, displayProjectName(p)]));
	names.set(project.id, displayProjectName(project));
	const attachedIds = new Set(attached.data?.items.map((v) => v.id));
	const rows = projectVaultCatalogRows({
		projectId: project.id,
		attachedVaults: attached.data?.items,
		attachedVaultsUpdatedAt: attached.dataUpdatedAt,
		catalogVaults: canAttach ? (catalog.data?.items ?? []) : [],
		catalogUpdatedAt: catalog.dataUpdatedAt,
		search,
	});
	const groups = attached.data
		? [
				{ label: `In this ${context}`, rows: rows.filter((v) => attachedIds.has(v.id)) },
				{ label: PROJECT_VAULT_COPY.available, rows: rows.filter((v) => !attachedIds.has(v.id)) },
			]
		: [{ label: null, rows }];
	const disabled = !attached.data || !!attached.error || action.busy || removing !== null;
	const changed = () => cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
	const checkProject = async () => {
		const fresh = (await read((s) => cloud.listProjects(s))).find((p) => p.id === project.id);
		if (!fresh || !isCustomProject(fresh) || !fresh.is_owner || fresh.archived_at)
			throw new Error("Project unavailable");
	};
	const update = async (selected: Vault, remove: boolean, visible: () => boolean) => {
		if (
			!canAttach ||
			!attached.data ||
			attached.error ||
			selected.is_owner === false ||
			(!remove && (!catalog.data || catalog.error))
		)
			throw new Error("Refresh vault links and try again.");
		await checkProject();
		const currentVault = await read((s) => vault.get(selected, s));
		if (!visible() || !scope.isCurrent() || currentVault.is_owner === false)
			throw new Error("Vault unavailable");
		if (remove) await read((s) => vault.detach(selected, project.id, s));
		else await read((s) => vault.attach(selected, project.id, s));
		if (scope.isCurrent()) await changed();
	};

	const searchOptions = useHeaderSearch({
		value: search,
		onChange: setSearch,
		placeholder: PROJECT_VAULT_COPY.searchPlaceholder,
	});
	if (form)
		return (
			<SheetPage
				title={t("libraryPort.createVault")}
				description={projectVaultCreateDescription(context)}
				fallback="/projects"
				busy={action.busy}
				sheet={sheet}
			>
				<WebView recipe={projectDetailClasses.fieldStack}>
					<Label>{PROJECT_VAULT_COPY.name}</Label>
					<Input
						value={name}
						onChangeText={setName}
						placeholder={PROJECT_VAULT_COPY.placeholder}
						maxLength={200}
						editable={!action.busy}
					/>
					{name.trim() && !slugFromVaultName(name) ? (
						<WebText recipe={projectDetailClasses.error}>{PROJECT_VAULT_COPY.invalidName}</WebText>
					) : null}
				</WebView>
				{action.error ? <ApiErrorPanel error={action.error} /> : null}
				<WebView recipe={projectDetailClasses.form}>
					<Button
						variant="ghost"
						disabled={action.busy}
						onPress={() => {
							void sheet.close().catch(setCloseError);
							setName("");
						}}
					>
						<Text>{t("libraryPort.cancel")}</Text>
					</Button>
					<Button
						disabled={action.busy || !name.trim() || !slugFromVaultName(name)}
						onPress={() => {
							const visible = capture();
							void action.run(async (current) => {
								await checkProject();
								if (!current() || !visible()) return;
								await read((s) =>
									vault.createInProject(
										project.id,
										{ name: name.trim(), slug: slugFromVaultName(name) },
										s,
									),
								);
								if (!current()) return;
								await changed();
								if (current() && visible()) {
									setName("");
									await sheet.close(true);
								}
							});
						}}
					>
						<Icon as={Plus} />
						<Text>{t("libraryPort.createVault")}</Text>
					</Button>
				</WebView>
				{closeError ? <ApiErrorPanel error={closeError} /> : null}
			</SheetPage>
		);
	const listRows = groups.flatMap((group) =>
		group.rows.map((item, index) => ({
			item,
			label: index === 0 ? group.label : null,
			count: group.rows.length,
		})),
	);
	return (
		<>
			<Stack.Screen options={{ headerSearchBarOptions: searchOptions }} />
			<NativeList
				data={listRows}
				keyExtractor={(row) => row.item.id}
				refreshing={attached.isRefetching || catalog.isRefetching}
				onRefresh={() => {
					void attached.refetch();
					if (canAttach) void catalog.refetch();
				}}
				header={
					<>
						{header}
						<WebView recipe={projectDetailClasses.sectionHeader}>
							<WebView recipe={projectDetailClasses.sectionHeading}>
								<WebText recipe={projectDetailClasses.heading}>{t("navigation.vaults")}</WebText>
								<WebText recipe={projectDetailClasses.subtitle}>
									{t("libraryPort.projectVaultsDescription")}
								</WebText>
							</WebView>
							{canAttach ? (
								<HeaderActionGroup>
									<Button
										variant="outline"
										size="sm"
										disabled={action.busy}
										onPress={() => {
											action.clearError();
											router.push({
												pathname: "/projects/[id]/vaults/new",
												params: { id: project.id },
											});
										}}
									>
										<Icon as={Plus} />
										<Text>{t("libraryPort.createVault")}</Text>
									</Button>
								</HeaderActionGroup>
							) : null}
						</WebView>
						<WebView recipe={projectVaultCatalogClasses.root}>
							{canAttach ? (
								<WebText recipe={projectVaultCatalogClasses.description}>
									{projectVaultCatalogDescription(context)}
								</WebText>
							) : null}
							{attached.error ? (
								<ApiErrorPanel
									error={attached.error}
									onRetry={() => void attached.refetch()}
									title={`Couldn't load ${context} vault links`}
								/>
							) : null}
							{canAttach && catalog.error ? (
								<ApiErrorPanel
									error={catalog.error}
									onRetry={() => void catalog.refetch()}
									title="Couldn't load vault catalog"
								/>
							) : null}
							{action.error ? <ApiErrorPanel error={action.error} /> : null}
						</WebView>
					</>
				}
				renderItem={({ item: { item, label, count } }) => {
					const linked = attachedIds.has(item.id),
						unavailable = disabled || (!linked && (!catalog.data || !!catalog.error));
					return (
						<>
							{label ? <SectionLabel count={count}>{label}</SectionLabel> : null}
							<VaultCard
								key={item.id}
								vault={item}
								names={names}
								projectId={linked ? project.id : undefined}
								searchQuery={search.trim() || undefined}
								actions={
									canAttach && item.is_owner !== false ? (
										<Button
											size="sm"
											variant={linked ? "ghost" : "default"}
											disabled={unavailable}
											accessibilityLabel={`${linked ? "Remove" : "Add"} ${item.name} ${linked ? "from" : "to"} ${context}`}
											onPress={() => {
												const visible = capture();
												if (linked) {
													confirmationLease.current = visible;
													setRemoving(item);
												} else
													void action.run(async (current) => {
														await update(item, false, visible);
														if (!current()) return;
													});
											}}
										>
											<Text>{linked ? "Remove" : "Add"}</Text>
										</Button>
									) : null
								}
							/>
						</>
					);
				}}
				empty={
					attached.isPending || (canAttach && catalog.isPending) ? (
						<HeroCardSkeleton />
					) : !attached.error && (!canAttach || !catalog.error) ? (
						<EmptyState
							variant="inset"
							description={search.trim() ? PROJECT_VAULT_COPY.noMatches : PROJECT_VAULT_COPY.empty}
						/>
					) : null
				}
			/>
			<ConfirmAction
				open={removing !== null}
				onOpenChange={(open) => {
					if (!open) setRemoving(null);
				}}
				title={`Remove ${removing?.name ?? "Vault"} from ${context}?`}
				description={PROJECT_VAULT_COPY.removeDescription}
				confirmLabel="Remove"
				onConfirm={async () => {
					if (removing) await update(removing, true, confirmationLease.current);
				}}
			/>
		</>
	);
}
export function ProjectVaultCreateScreen() {
	const params = useLocalSearchParams<{ id?: string }>();
	const project = useProject(routeParam(params.id));
	return project.data && !project.isError ? (
		<ProjectVaultCatalog project={project.data} form />
	) : (
		<SheetPage title="Create vault" fallback="/projects">
			{project.isPending ? (
				<HeroCardSkeleton />
			) : (
				<ApiErrorPanel error={project.error} onRetry={() => void project.refetch()} />
			)}
		</SheetPage>
	);
}
