import {
	ApiClientError,
	buildKeyImportPreview,
	splitVaultKeys,
	transferVaultKeys,
	type VaultIdentity,
	type VaultKeySelection,
	type VaultPrefixGroup,
	type VaultSplitResult,
	validVaultSplit,
} from "@clawdi/shared/api";
import { projectDetailClasses, vaultDetailClasses } from "@clawdi/shared/ui";
import { getProjectResourceDefinition, identityFor } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { ListChecks, Plus, Trash2 } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Alert, AppState } from "react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { ApiErrorPanel } from "../../ui/api-error-panel";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { ChoiceSelect } from "../../ui/detail/choice-select";
import { DetailBackLink, LibraryPage } from "../../ui/detail/layout";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";
import { EntityCardSkeleton } from "../../ui/entity-card";
import { Icon } from "../../ui/icon";
import { IconChip } from "../../ui/icon-chip";
import { Input } from "../../ui/input";
import { PageHeader, PageHeaderSkeleton } from "../../ui/page-header";
import { AppText, AppView } from "../../ui/primitives";
import { SearchInput } from "../../ui/search-input";
import { Switch } from "../../ui/switch";
import { Text } from "../../ui/text";
import { WebText, WebView, webBoth, webText } from "../../ui/web-layout";
import { useCloudProjects } from "../projects";
import { routeParam } from "../read-helpers";
import { ResourceError } from "../resource-error";
import { useVaultCatalog } from "./catalog";
import { VaultRequests } from "./requests";
import { VaultSplit } from "./split";

export function VaultDetailScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{
		vaultId?: string | string[];
		slug?: string | string[];
		add?: string;
	}>();
	const id = routeParam(params.vaultId);
	const slug = routeParam(params.slug);
	return (
		<VaultDetail
			key={`${scope.identity}:${scope.generation}:${id}:${slug}`}
			identity={id && slug ? { id, slug } : undefined}
			initialAdd={params.add === "1"}
		/>
	);
}

function VaultDetail({
	identity,
	initialAdd = false,
}: {
	identity?: VaultIdentity;
	initialAdd?: boolean;
}) {
	const [keySearch, setKeySearch] = useState("");
	const [selectMode, setSelectMode] = useState(false);
	const [addOpen, setAddOpen] = useState(initialAdd);
	const [transferOpen, setTransferOpen] = useState(false);
	const [requestOpen, setRequestOpen] = useState(false);
	const [splitOpen, setSplitOpen] = useState(false);
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { vault } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const projects = useCloudProjects();
	const targets = useVaultCatalog();
	const [section, setSection] = useState("");
	const [draft, setDraft] = useState("");
	const [replace, setReplace] = useState(false);
	const [targetId, setTargetId] = useState("");
	const [projectTargetId, setProjectTargetId] = useState("");
	const [saved, setSaved] = useState(false);
	const [selected, setSelected] = useState<VaultKeySelection[]>([]);
	const [splitResult, setSplitResult] = useState<VaultSplitResult>();
	const [transferResult, setTransferResult] =
		useState<Awaited<ReturnType<typeof transferVaultKeys>>>();
	const capture = useForegroundLease();
	useFocusEffect(
		useCallback(() => {
			const subscription = AppState.addEventListener("change", (state) => {
				if (state !== "active") setDraft("");
			});
			return () => {
				subscription.remove();
				setDraft("");
			};
		}, []),
	);
	const detail = useQuery({
		queryKey: accountQueryKey(scope, "vault-detail", identity?.id, identity?.slug),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!identity) throw new Error("Missing Vault identity");
				return vault.get(identity, s);
			}, signal),
		enabled: scope.isReady && !!identity,
		retry: false,
	});
	const sections = useQuery({
		queryKey: accountQueryKey(scope, "vault-sections", identity?.id, identity?.slug),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!identity) throw new Error("Missing Vault identity");
				return vault.sections(identity, s);
			}, signal),
		enabled: scope.isReady && !!identity && detail.isSuccess,
		retry: false,
	});
	const current = detail.data;
	const attachableProjects = (projects.data ?? []).filter(
		(project) =>
			project.is_owner &&
			project.kind === "workspace" &&
			!project.archived_at &&
			!current?.project_ids.includes(project.id),
	);
	const projectTarget = attachableProjects.find((project) => project.id === projectTargetId);
	const writable =
		!!identity &&
		current?.id === identity.id &&
		current.is_owner &&
		!detail.isError &&
		sections.isSuccess;
	const normalizedSection = section.trim();
	const existing = new Set(sections.data?.[normalizedSection || "(default)"] ?? []);
	const preview = buildKeyImportPreview(draft, existing, replace);
	const validSection =
		normalizedSection.length <= 200 && /^[A-Za-z0-9_.-]*$/.test(normalizedSection);
	const validImport =
		validSection &&
		!preview.parsed.errors.length &&
		preview.importableRows.length > 0 &&
		preview.importableRows.length <= 200 &&
		preview.importableRows.every((row) => row.key.length <= 200);
	const destinations = [
		...new Map(
			(targets.data?.pages.flatMap((p) => p.items) ?? [])
				.filter((v) => v.is_owner && v.id !== identity?.id)
				.map((v) => [v.id, v]),
		).values(),
	];
	const destination = destinations.find((v) => v.id === targetId);
	const refresh = async () => {
		await Promise.all([
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "vault-catalog") }),
			detail.refetch(),
			sections.refetch(),
		]);
	};
	const confirm = (
		title: string,
		warning: string,
		perform: (isCurrent: () => boolean) => Promise<void>,
		destructive = false,
		reportSuccess = true,
	) => {
		const visible = capture();
		if (!writable || action.busy || !visible()) return;
		const signal = scope.signal;
		Alert.alert(title, warning, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: title,
				style: destructive ? "destructive" : "default",
				onPress: () => {
					if (signal.aborted || !scope.isCurrent() || !visible()) return;
					void action.run(async (isCurrent) => {
						setSaved(false);
						setTransferResult(undefined);
						await perform(() => isCurrent() && visible());
						if (isCurrent() && visible() && reportSuccess) setSaved(true);
					});
				},
			},
		]);
	};
	const importKeys = () => {
		if (!identity || !validImport) return;
		confirm(t("vault.import"), t("vault.importWarning"), async (isCurrent) => {
			setDraft("");
			await read((s) =>
				vault.upsert(identity, { section: normalizedSection, fields: preview.fields }, s),
			);
			if (isCurrent()) await refresh();
		});
	};
	const remove = () => {
		if (!identity) return;
		confirm(
			t("vault.remove"),
			t("vault.removeWarning"),
			async (isCurrent) => {
				await read((s) => vault.remove(identity, s));
				if (!isCurrent()) return;
				await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "vault-catalog") });
				if (isCurrent()) router.replace("/vault");
			},
			true,
		);
	};
	const transfer = (mode: "copy" | "move") => {
		if (!identity || !destination || !selected.length || targets.isError) return;
		const source = identity;
		const target = destination;
		const keys = selected.filter((key) => sections.data?.[key.section]?.includes(key.name));
		if (keys.length !== selected.length) return;
		confirm(
			t(mode === "move" ? "vault.moveSelected" : "vault.copySelected"),
			`${keys.length} → ${target.name}\n\n${t(mode === "move" ? "vault.moveWarning" : "vault.selectedCopyWarning")}`,
			async (isCurrent) => {
				const result = await transferVaultKeys(keys, mode, {
					copy: (section, fields) =>
						read((signal) => vault.copyItems(source, target, { section, fields }, signal)),
					remove: (section, fields) =>
						read((signal) => vault.deleteItems(source, { section, fields }, true, signal)),
					isCurrent,
				});
				if (!isCurrent()) return;
				setTransferResult(result);
				setSelected([]);
				await Promise.all([
					refresh(),
					cache.invalidateQueries({
						queryKey: accountQueryKey(scope, "vault-sections", target.id),
					}),
				]);
			},
			mode === "move",
			false,
		);
	};
	const split = (groups: VaultPrefixGroup[], removeOriginals: boolean) => {
		if (!identity || !validVaultSplit(identity, groups)) return;
		confirm(
			t("vault.splitTitle"),
			`${groups.map((g) => `${g.prefix} → ${g.slug}`).join("\n")}\n\n${t(removeOriginals ? "vault.moveWarning" : "vault.selectedCopyWarning")}\n\n${t("vault.splitInspect")}`,
			async (isCurrent) => {
				const result = await splitVaultKeys(
					identity,
					groups,
					removeOriginals,
					{
						create: (body) => read((signal) => vault.create(body, signal)),
						copyItems: (source, target, body) =>
							read((signal) => vault.copyItems(source, target, body, signal)),
						deleteItems: (source, body, globalDelete) =>
							read((signal) => vault.deleteItems(source, body, globalDelete, signal)),
					},
					isCurrent,
				);
				if (!isCurrent()) return;
				setSplitResult(result);
				setSelected([]);
				await refresh();
			},
			removeOriginals,
			false,
		);
	};
	const keyRows = Object.entries(sections.data ?? {}).flatMap(([group, names]) =>
		names.map((name) => ({ section: group, name })),
	);
	const filteredKeys = keyRows.filter((k) =>
		`${k.section}/${k.name}`.toLowerCase().includes(keySearch.trim().toLowerCase()),
	);
	return (
		<LibraryPage detail>
			<DetailBackLink href="/vault" label={getProjectResourceDefinition("vaults").label} />
			{!identity || detail.isError ? (
				<ResourceError
					missing={
						!identity || (detail.error instanceof ApiClientError && detail.error.status === 404)
					}
					onRetry={() => void detail.refetch()}
				/>
			) : detail.isPending ? (
				<PageHeaderSkeleton icon actions />
			) : null}
			{current && !detail.isError ? (
				<>
					<PageHeader
						title={current.name}
						icon={
							<IconChip
								tint={identityFor(current.name).colorClasses}
								className={webBoth(vaultDetailClasses.emoji)}
							>
								{identityFor(current.name).emoji}
							</IconChip>
						}
						description={t(
							current.is_owner
								? "libraryPort.vaultDescription"
								: "libraryPort.sharedVaultDescription",
						)}
						actions={
							writable ? (
								<Button
									variant="outline"
									size="sm"
									textClassName={webText(vaultDetailClasses.deleteAction)}
									onPress={remove}
									disabled={action.busy}
								>
									<Icon as={Trash2} />
									<Text>{t("libraryPort.delete")}</Text>
								</Button>
							) : undefined
						}
					/>
					<WebView recipe={vaultDetailClasses.section}>
						<WebView recipe={vaultDetailClasses.sectionHeading}>
							<WebView recipe={vaultDetailClasses.headingRow}>
								<WebText recipe={vaultDetailClasses.heading}>{t("vault.keys")}</WebText>
								<Badge variant="secondary">
									<Text>{keyRows.length}</Text>
								</Badge>
							</WebView>
							<WebText recipe={vaultDetailClasses.subtitle}>
								{t("libraryPort.keysDescription")}
							</WebText>
						</WebView>
						<WebView recipe={vaultDetailClasses.actions}>
							<SearchInput
								value={keySearch}
								onChange={setKeySearch}
								placeholder={t("libraryPort.searchKeys")}
							/>
							{writable ? (
								<>
									<Button
										className={webBoth(vaultDetailClasses.control)}
										variant="outline"
										size="sm"
										onPress={() => {
											setSelectMode(!selectMode);
											setSelected([]);
										}}
									>
										<Icon as={ListChecks} />
										<Text>{t(selectMode ? "libraryPort.done" : "libraryPort.select")}</Text>
									</Button>
									<Button
										className={webBoth(vaultDetailClasses.control)}
										variant="outline"
										size="sm"
										onPress={() => setAddOpen(true)}
									>
										<Icon as={Plus} />
										<Text>{t("libraryPort.addKeys")}</Text>
									</Button>
									{selected.length ? (
										<Button
											className={webBoth(vaultDetailClasses.control)}
											variant="outline"
											size="sm"
											onPress={() => setTransferOpen(true)}
										>
											<Text>Copy or move {selected.length}</Text>
										</Button>
									) : null}
								</>
							) : null}
						</WebView>
						{sections.error ? (
							<ApiErrorPanel error={sections.error} onRetry={() => void sections.refetch()} />
						) : sections.isPending ? (
							<EntityCardSkeleton />
						) : (
							<WebView recipe={vaultDetailClasses.keyGrid}>
								{filteredKeys.map(({ section: group, name: key }) => (
									<WebView key={`${group}/${key}`} recipe={vaultDetailClasses.keyCard}>
										{selectMode ? (
											<AppView className="flex-row items-center gap-2">
												<Switch
													checked={selected.some((k) => k.section === group && k.name === key)}
													disabled={action.busy}
													onCheckedChange={(checked) =>
														setSelected((old) => [
															...old.filter((k) => k.section !== group || k.name !== key),
															...(checked ? [{ section: group, name: key }] : []),
														])
													}
												/>
												<Text>{key}</Text>
											</AppView>
										) : (
											<>
												<WebText recipe={vaultDetailClasses.keyName} numberOfLines={1}>
													{group && group !== "(default)" ? `${group}/` : ""}
													{key}
												</WebText>
												<WebText recipe={vaultDetailClasses.protectedValue}>••••••</WebText>
												{writable ? (
													<Button
														variant="ghost"
														size="icon-sm"
														accessibilityLabel={`${t("vault.deleteKey")}: ${key}`}
														disabled={action.busy}
														onPress={() => {
															if (!identity) return;
															confirm(
																t("vault.deleteKey"),
																`${key}\n\n${t("vault.deleteWarning")}`,
																async (isCurrent) => {
																	await read((s) =>
																		vault.deleteItems(
																			identity,
																			{
																				section: group === "(default)" ? "" : group,
																				fields: [key],
																			},
																			true,
																			s,
																		),
																	);
																	if (isCurrent()) await refresh();
																},
																true,
															);
														}}
													>
														<Icon as={Trash2} />
													</Button>
												) : null}
											</>
										)}
									</WebView>
								))}
							</WebView>
						)}
					</WebView>
					<WebView recipe={vaultDetailClasses.section}>
						<WebView recipe={vaultDetailClasses.headingRow}>
							<WebText recipe={vaultDetailClasses.heading}>{t("projects.title")}</WebText>
							<Badge variant="secondary">
								<Text>{current.project_ids.length}</Text>
							</Badge>
						</WebView>
						<WebText recipe={vaultDetailClasses.subtitle}>
							{t("libraryPort.vaultProjectsDescription")}
						</WebText>
						{writable ? (
							<WebView recipe={vaultDetailClasses.section}>
								<ChoiceSelect
									value={projectTargetId}
									onValueChange={setProjectTargetId}
									disabled={action.busy || projects.isError || projects.isFetching}
									options={[
										{ value: "", label: t("vault.attachTarget") },
										...attachableProjects.map((project) => ({
											value: project.id,
											label: project.name,
										})),
									]}
								/>
								{projects.isError ? (
									<ResourceError missing={false} onRetry={() => void projects.refetch()} />
								) : null}
								<Button
									variant="outline"
									size="sm"
									disabled={
										action.busy || projects.isError || projects.isFetching || !projectTarget
									}
									onPress={() => {
										if (!current || !projectTarget) return;
										confirm(
											t("vault.attach"),
											`${projectTarget.name}\n\n${t("vault.attachWarning")}`,
											async (isCurrent) => {
												await read((signal) => vault.attach(current, projectTarget.id, signal));
												if (isCurrent()) {
													setProjectTargetId("");
													await refresh();
												}
											},
										);
									}}
								>
									<Text>{t("vault.attach")}</Text>
								</Button>
							</WebView>
						) : null}
						{current.project_ids.map((projectId) => (
							<WebView key={projectId} recipe={vaultDetailClasses.projectCard}>
								<WebView recipe={projectDetailClasses.agentIdentity}>
									<WebText recipe={projectDetailClasses.heading}>
										{projects.data?.find((p) => p.id === projectId)?.name ?? projectId}
									</WebText>
									<WebText recipe={projectDetailClasses.description} numberOfLines={1}>
										{projects.data?.find((p) => p.id === projectId)?.description}
									</WebText>
								</WebView>
								{writable ? (
									<Button
										variant="outline"
										size="sm"
										disabled={action.busy}
										onPress={() => {
											if (!identity) return;
											confirm(
												t("vault.detach"),
												t("vault.detachWarning"),
												async (isCurrent) => {
													await read((s) => vault.detach(identity, projectId, s));
													if (isCurrent()) await refresh();
												},
												true,
											);
										}}
									>
										<Text>{t("vault.detach")}</Text>
									</Button>
								) : null}
							</WebView>
						))}
					</WebView>
					<Dialog
						open={addOpen}
						onOpenChange={(v) => {
							if (!action.busy) {
								setAddOpen(v);
								if (!v) setDraft("");
							}
						}}
					>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>{t("libraryPort.addKeys")}</DialogTitle>
							</DialogHeader>
							<WebView recipe={vaultDetailClasses.section}>
								<Input
									accessibilityLabel={t("vault.section")}
									placeholder={t("vault.section")}
									value={section}
									maxLength={200}
									onChangeText={setSection}
									editable={!action.busy}
									autoCapitalize="none"
									autoCorrect={false}
								/>
								<Input
									accessibilityLabel={t("vault.importText")}
									placeholder={t("vault.importText")}
									value={draft}
									onChangeText={setDraft}
									editable={!action.busy}
									multiline
									maxLength={1048576}
									autoCapitalize="none"
									autoCorrect={false}
									autoComplete="off"
									textContentType="none"
								/>
								<AppView className="flex-row items-center gap-2">
									<Switch checked={replace} onCheckedChange={setReplace} disabled={action.busy} />
									<Text>{t("vault.replace")}</Text>
								</AppView>
								{draft ? (
									<>
										<AppText>{t("vault.preview")}</AppText>
										{preview.parsed.errors.length ||
										!validSection ||
										preview.importableRows.length > 200 ||
										preview.importableRows.some((row) => row.key.length > 200) ? (
											<AppText accessibilityRole="alert">{t("vault.invalidImport")}</AppText>
										) : (
											preview.preview.map((row) => (
												<AppText key={row.key}>
													{row.key} ·{" "}
													{t(
														row.action === "create"
															? "vault.createKey"
															: row.action === "update"
																? "vault.updateKey"
																: "vault.skipKey",
													)}
												</AppText>
											))
										)}
										<Button
											variant="outline"
											size="sm"
											onPress={() => setDraft("")}
											disabled={action.busy}
										>
											<Text>{t("vault.clear")}</Text>
										</Button>
									</>
								) : null}
								<Button
									variant="default"
									size="sm"
									disabled={action.busy || !validImport}
									onPress={importKeys}
								>
									<Text>{t("vault.import")}</Text>
								</Button>
								<Button variant="outline" onPress={() => setRequestOpen(true)}>
									<Text>{t("vault.requestCreate")}</Text>
								</Button>
							</WebView>
						</DialogContent>
					</Dialog>
					<Dialog
						open={transferOpen}
						onOpenChange={(v) => {
							if (!action.busy) setTransferOpen(v);
						}}
					>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>{t("libraryPort.transferKeys")}</DialogTitle>
							</DialogHeader>
							<WebView recipe={vaultDetailClasses.section}>
								<AppText>{t("vault.copyTarget")}</AppText>
								<ChoiceSelect
									value={targetId}
									onValueChange={setTargetId}
									disabled={action.busy}
									options={[
										{ value: "", label: t("vault.chooseTarget") },
										...destinations.map((v) => ({ value: v.id, label: `${v.name} (${v.slug})` })),
									]}
								/>
								{targets.isError ? (
									<ResourceError missing={false} onRetry={() => void targets.refetch()} />
								) : null}
								{targets.hasNextPage ? (
									<Button
										variant="outline"
										size="sm"
										disabled={targets.isFetching}
										onPress={() => void targets.fetchNextPage()}
									>
										<Text>{t("vault.loadTargets")}</Text>
									</Button>
								) : null}
								<AppText>
									{t("vault.selectedCount")}: {selected.length}
								</AppText>
								<Button
									variant="outline"
									size="sm"
									disabled={action.busy || !selected.length}
									onPress={() => setSelected([])}
								>
									<Text>{t("vault.clearSelection")}</Text>
								</Button>
								{(["copy", "move"] as const).map((mode) => (
									<Button
										variant="outline"
										size="sm"
										key={mode}
										disabled={
											action.busy ||
											!destination ||
											targets.isError ||
											!selected.length ||
											selected.some((key) => !sections.data?.[key.section]?.includes(key.name))
										}
										onPress={() => transfer(mode)}
									>
										<Text>{t(mode === "copy" ? "vault.copySelected" : "vault.moveSelected")}</Text>
									</Button>
								))}
							</WebView>
						</DialogContent>
					</Dialog>
					<Dialog open={requestOpen} onOpenChange={setRequestOpen}>
						<DialogContent>
							<VaultRequests current={current} />
						</DialogContent>
					</Dialog>
					{identity && (writable || splitResult) ? (
						<Dialog
							open={splitOpen}
							onOpenChange={(v) => {
								if (!action.busy) setSplitOpen(v);
							}}
						>
							<Button variant="outline" size="sm" onPress={() => setSplitOpen(true)}>
								<Text>{t("vault.splitTitle")}</Text>
							</Button>
							<DialogContent>
								<VaultSplit
									source={identity}
									keys={keyRows}
									disabled={action.busy}
									result={splitResult}
									onSubmit={split}
									onReset={() => setSplitResult(undefined)}
								/>
							</DialogContent>
						</Dialog>
					) : null}
				</>
			) : null}
			{action.error ? <ApiErrorPanel error={action.error} /> : null}
			{saved ? <Text>{t("vault.saved")}</Text> : null}
			{transferResult ? (
				<Text>
					{t("vault.copiedCount")}: {transferResult.copied}
					{transferResult.failed.length
						? ` · ${t("vault.copyUnconfirmed")}: ${transferResult.failed.join(", ")}`
						: ""}
					{transferResult.sourceRemoveFailed.length
						? ` · ${t("vault.cleanupUnconfirmed")}: ${transferResult.sourceRemoveFailed.join(", ")}`
						: ""}
				</Text>
			) : null}
		</LibraryPage>
	);
}
