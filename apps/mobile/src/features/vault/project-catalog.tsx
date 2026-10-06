import { type Project, slugFromVaultName, type Vault } from "@clawdi/shared/api";
import {
	HERO_GRID_CLASS,
	projectDetailClasses,
	projectVaultCatalogClasses,
} from "@clawdi/shared/ui";
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
import { Plus } from "lucide-react-native";
import { useRef, useState } from "react";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { ApiErrorPanel } from "../../ui/api-error-panel";
import { Button } from "../../ui/button";
import { ConfirmAction } from "../../ui/confirm-action";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../ui/dialog";
import { EmptyState } from "../../ui/empty-state";
import { HeroCardSkeleton } from "../../ui/entity-card";
import { HeaderActionGroup } from "../../ui/header-action-group";
import { Icon } from "../../ui/icon";
import { Input, Label } from "../../ui/input";
import { ListToolbar } from "../../ui/list-toolbar";
import { SearchInput } from "../../ui/search-input";
import { SectionLabel } from "../../ui/section-label";
import { Text } from "../../ui/text";
import { VaultCard } from "../../ui/vault/vault-card";
import { WebText, WebView } from "../../ui/web-layout";
import { useCloudProjects } from "../projects";

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

export function ProjectVaultCatalog({ project }: { project: Project }) {
	const t = useI18n(),
		scope = useAccountScope(),
		read = useAccountRead(),
		{ vault, cloud } = useMobileApi();
	const cache = useQueryClient(),
		action = useAuthAction(scope),
		capture = useForegroundLease();
	const [search, setSearch] = useState(""),
		[createOpen, setCreateOpen] = useState(false),
		[name, setName] = useState("");
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
			throw new Error("Refresh Vault links and try again.");
		await checkProject();
		const currentVault = await read((s) => vault.get(selected, s));
		if (!visible() || !scope.isCurrent() || currentVault.is_owner === false)
			throw new Error("Vault unavailable");
		if (remove) await read((s) => vault.detach(selected, project.id, s));
		else await read((s) => vault.attach(selected, project.id, s));
		if (scope.isCurrent()) await changed();
	};
	return (
		<WebView recipe={projectDetailClasses.section}>
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
								setCreateOpen(true);
							}}
						>
							<Icon as={Plus} />
							<Text>{t("libraryPort.createVault")}</Text>
						</Button>
					</HeaderActionGroup>
				) : null}
			</WebView>
			<WebView recipe={projectVaultCatalogClasses.root}>
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
					<WebText recipe={projectVaultCatalogClasses.description}>
						{projectVaultCatalogDescription(context)}
					</WebText>
				) : null}
				{attached.error ? (
					<ApiErrorPanel
						error={attached.error}
						onRetry={() => void attached.refetch()}
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
				{action.error && !createOpen ? <ApiErrorPanel error={action.error} /> : null}
				{rows.length ? (
					groups.map((group) =>
						group.rows.length ? (
							<WebView key={group.label ?? "catalog"} recipe={projectVaultCatalogClasses.section}>
								{group.label ? (
									<SectionLabel count={group.rows.length}>{group.label}</SectionLabel>
								) : null}
								<WebView recipe={HERO_GRID_CLASS}>
									{group.rows.map((item) => {
										const linked = attachedIds.has(item.id),
											unavailable = disabled || (!linked && (!catalog.data || !!catalog.error));
										return (
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
										);
									})}
								</WebView>
							</WebView>
						) : null,
					)
				) : attached.isPending || (canAttach && catalog.isPending) ? (
					<WebView recipe={HERO_GRID_CLASS}>
						{[0, 1, 2].map((i) => (
							<HeroCardSkeleton key={i} />
						))}
					</WebView>
				) : !attached.error && (!canAttach || !catalog.error) ? (
					<EmptyState
						variant="inset"
						description={search.trim() ? PROJECT_VAULT_COPY.noMatches : PROJECT_VAULT_COPY.empty}
					/>
				) : null}
			</WebView>
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
			<Dialog
				open={createOpen}
				onOpenChange={(open) => {
					if (!action.busy) {
						setCreateOpen(open);
						if (!open) setName("");
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("libraryPort.createVault")}</DialogTitle>
						<DialogDescription>{projectVaultCreateDescription(context)}</DialogDescription>
					</DialogHeader>
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
							<WebText recipe={projectDetailClasses.error}>
								{PROJECT_VAULT_COPY.invalidName}
							</WebText>
						) : null}
					</WebView>
					{action.error ? <ApiErrorPanel error={action.error} /> : null}
					<DialogFooter>
						<Button
							variant="ghost"
							disabled={action.busy}
							onPress={() => {
								setCreateOpen(false);
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
										setCreateOpen(false);
									}
								});
							}}
						>
							<Icon as={Plus} />
							<Text>{t("libraryPort.createVault")}</Text>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</WebView>
	);
}
