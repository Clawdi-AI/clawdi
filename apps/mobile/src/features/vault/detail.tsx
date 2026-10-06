import {
	ApiClientError,
	buildKeyImportPreview,
	slugFromVaultName,
	splitVaultKeys,
	transferVaultKeys,
	type VaultIdentity,
	type VaultKeySelection,
	type VaultPrefixGroup,
	type VaultSplitResult,
	validVaultSplit,
} from "@clawdi/shared/api";
import {
	addKeysDialogClasses,
	copyKeysDialogClasses,
	projectDetailClasses,
	splitVaultDialogClasses,
	vaultDetailClasses,
} from "@clawdi/shared/ui";
import {
	vaultKeyFormCopy as formCopy,
	getProjectResourceDefinition,
	identityFor,
	transferVaultKeysLabel,
	transferVaultKeysTitle,
	vaultImportActionLabel,
	vaultImportConflictHint,
	vaultImportDetectedCount,
	vaultImportMore,
	vaultImportSummaryLabel,
	vaultMoveWarning,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { AlertCircle, ArrowRight, Check, ListChecks, Plus, Trash2 } from "lucide-react-native";
import { useCallback, useState } from "react";
import { AppState } from "react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { Alert } from "../../ui/alert";
import { ApiErrorPanel } from "../../ui/api-error-panel";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { ChoiceSelect } from "../../ui/detail/choice-select";
import { DetailBackLink, LibraryPage } from "../../ui/detail/layout";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../ui/dialog";
import { EntityCardSkeleton } from "../../ui/entity-card";
import { Icon } from "../../ui/icon";
import { IconChip } from "../../ui/icon-chip";
import { Input, Label } from "../../ui/input";
import { PageHeader, PageHeaderSkeleton } from "../../ui/page-header";
import { AppView } from "../../ui/primitives";
import { SearchInput } from "../../ui/search-input";
import { Switch } from "../../ui/switch";
import { Text } from "../../ui/text";
import { useConfirmation } from "../../ui/use-confirmation";
import { WebText, WebView, webBoth, webText, webView } from "../../ui/web-layout";
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
	const confirmationDialog = useConfirmation();
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
	const [showSection, setShowSection] = useState(false);
	const [targetId, setTargetId] = useState("");
	const [transferMode, setTransferMode] = useState<"copy" | "move">("copy");
	const [newVaultName, setNewVaultName] = useState("");
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
	const newVaultSlug = slugFromVaultName(newVaultName);
	const newVaultTaken = (targets.data?.pages.flatMap((page) => page.items) ?? []).some(
		(item) => item.slug === newVaultSlug,
	);
	const creatingDestination = targetId === "__new__";
	const canTransfer = Boolean(
		destination ||
			(creatingDestination &&
				newVaultName.trim() &&
				newVaultSlug &&
				!newVaultTaken &&
				!targets.hasNextPage &&
				!targets.isFetching),
	);
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
		confirmLabel = title,
	) => {
		const visible = capture();
		if (!writable || action.busy || !visible()) return;
		const signal = scope.signal;
		confirmationDialog.show(title, warning, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: confirmLabel,
				style: destructive ? "destructive" : "default",
				onPress: () => {
					if (signal.aborted || !scope.isCurrent() || !visible()) return;
					return action.run(async (isCurrent) => {
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
			`Delete ${current?.name ?? identity.slug}?`,
			formCopy.deleteVaultDescription,
			async (isCurrent) => {
				await read((s) => vault.remove(identity, s));
				if (!isCurrent()) return;
				await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "vault-catalog") });
				if (isCurrent()) router.replace("/vault");
			},
			true,
			true,
			formCopy.deleteVault,
		);
	};
	const transfer = (mode: "copy" | "move") => {
		if (!identity || !canTransfer || !selected.length || targets.isError) return;
		const source = identity;
		const target = destination;
		const targetName = creatingDestination ? newVaultName.trim() : target?.name;
		const targetSlug = newVaultSlug;
		const keys = selected.filter((key) => sections.data?.[key.section]?.includes(key.name));
		if (keys.length !== selected.length) return;
		confirm(
			t(mode === "move" ? "vault.moveSelected" : "vault.copySelected"),
			`${keys.length} → ${targetName}\n\n${t(mode === "move" ? "vault.moveWarning" : "vault.selectedCopyWarning")}`,
			async (isCurrent) => {
				const resolvedTarget =
					target ??
					(await read((signal) =>
						vault.create({ name: targetName ?? "", slug: targetSlug }, signal),
					));
				if (!isCurrent()) return;
				if (!resolvedTarget.id || !resolvedTarget.slug || resolvedTarget.id === source.id)
					throw new Error("Invalid destination");
				const result = await transferVaultKeys(keys, mode, {
					copy: (section, fields) =>
						read((signal) => vault.copyItems(source, resolvedTarget, { section, fields }, signal)),
					remove: (section, fields) =>
						read((signal) => vault.deleteItems(source, { section, fields }, true, signal)),
					isCurrent,
				});
				if (!isCurrent()) return;
				setTransferResult(result);
				setTransferOpen(false);
				setNewVaultName("");
				setSelected([]);
				await Promise.all([
					refresh(),
					cache.invalidateQueries({
						queryKey: accountQueryKey(scope, "vault-sections", resolvedTarget.id),
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
									{selected.length
										? (["copy", "move"] as const).map((mode) => (
												<Button
													key={mode}
													className={webBoth(vaultDetailClasses.control)}
													variant="outline"
													size="sm"
													onPress={() => {
														setTransferMode(mode);
														setTargetId(destinations[0]?.id ?? "__new__");
														setNewVaultName("");
														setTransferOpen(true);
													}}
												>
													<Text>{transferVaultKeysLabel(mode, selected.length)}</Text>
												</Button>
											))
										: null}
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
																`Delete ${key}?`,
																formCopy.deleteKeyDescription,
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
																true,
																formCopy.deleteKey,
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
								if (!v) {
									setDraft("");
									setReplace(false);
								}
							}
						}}
					>
						<DialogContent
							className={webView(addKeysDialogClasses.dialog)}
							showCloseButton={!action.busy}
						>
							<DialogHeader>
								<DialogTitle>{formCopy.addTitle}</DialogTitle>
								<DialogDescription>
									{`${formCopy.addDescriptionBefore}${formCopy.format}${formCopy.addDescriptionAfter}`}
								</DialogDescription>
							</DialogHeader>
							<WebView recipe={addKeysDialogClasses.body}>
								<Input
									accessibilityLabel={t("vault.importText")}
									placeholder={formCopy.placeholder}
									className={webBoth(addKeysDialogClasses.paste)}
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
								<Button variant="ghost" size="sm" onPress={() => setShowSection(!showSection)}>
									<Text>{t("vault.section")}</Text>
								</Button>
								{showSection ? (
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
								) : null}
								{preview.parsed.errors.length ? (
									<Alert variant="destructive" icon={AlertCircle} title={formCopy.invalid}>
										<WebView recipe={addKeysDialogClasses.errors}>
											{preview.parsed.errors.map((error, index) => (
												<Text key={`${index}-${error}`}>• {error}</Text>
											))}
										</WebView>
									</Alert>
								) : null}
								{preview.conflicts.length > 0 && !preview.parsed.errors.length ? (
									<WebView recipe={addKeysDialogClasses.conflicts} className="flex-row">
										<Checkbox
											checked={replace}
											onCheckedChange={setReplace}
											disabled={action.busy}
											accessibilityLabel={formCopy.overwrite}
											className={webView(addKeysDialogClasses.checkbox)}
										/>
										<WebView recipe={addKeysDialogClasses.newField} className="flex-1">
											<Label className={webBoth(addKeysDialogClasses.label)}>
												{formCopy.overwrite}
											</Label>
											<WebText recipe={addKeysDialogClasses.meta}>
												{vaultImportConflictHint(preview.conflicts.length)}
											</WebText>
										</WebView>
									</WebView>
								) : null}
								{draft &&
								(!validSection ||
									preview.importableRows.length > 200 ||
									preview.importableRows.some((row) => row.key.length > 200)) ? (
									<Text accessibilityRole="alert">{t("vault.invalidImport")}</Text>
								) : null}
								{preview.preview.length > 0 && !preview.parsed.errors.length ? (
									<WebView recipe={addKeysDialogClasses.preview}>
										<WebView recipe={addKeysDialogClasses.previewHeader} className="flex-row">
											<WebText recipe={addKeysDialogClasses.previewTitle}>
												{formCopy.preview}
											</WebText>
											<WebView recipe={addKeysDialogClasses.badges} className="flex-row">
												<Badge variant="secondary">
													<Text>{vaultImportSummaryLabel("new", preview.summary.created)}</Text>
												</Badge>
												{preview.conflicts.length ? (
													<Badge variant="outline">
														<Text>
															{replace
																? vaultImportSummaryLabel("update", preview.summary.updated)
																: vaultImportSummaryLabel("skip", preview.summary.skipped)}
														</Text>
													</Badge>
												) : null}
											</WebView>
										</WebView>
										<WebView recipe={addKeysDialogClasses.previewList}>
											{preview.preview.slice(0, 10).map((row) => (
												<WebView
													key={row.key}
													recipe={addKeysDialogClasses.previewRow}
													className="flex-row justify-between"
												>
													<WebText recipe={addKeysDialogClasses.key}>{row.key}</WebText>
													<Badge variant={row.action === "create" ? "secondary" : "outline"}>
														<Text>{vaultImportActionLabel(row.action)}</Text>
													</Badge>
												</WebView>
											))}
											{preview.preview.length > 10 ? (
												<WebText recipe={addKeysDialogClasses.more}>
													{vaultImportMore(preview.preview.length - 10)}
												</WebText>
											) : null}
										</WebView>
									</WebView>
								) : null}
								{draft ? (
									<Button
										variant="ghost"
										size="sm"
										disabled={action.busy}
										onPress={() => setDraft("")}
									>
										<Text>{t("vault.clear")}</Text>
									</Button>
								) : null}
								<WebText recipe={addKeysDialogClasses.count}>
									{vaultImportDetectedCount(preview.parsed.entries.length, preview.summary.skipped)}
								</WebText>
								<DialogFooter>
									<Button
										variant="ghost"
										disabled={action.busy}
										onPress={() => {
											setAddOpen(false);
											setDraft("");
											setReplace(false);
										}}
									>
										<Text>{t("account.cancel")}</Text>
									</Button>
									<Button
										variant="default"
										size="sm"
										disabled={action.busy || !validImport}
										onPress={importKeys}
									>
										<Icon as={Check} className={webBoth(addKeysDialogClasses.iconSmall)} />
										<Text>
											{formCopy.save} {preview.importableRows.length || ""}
										</Text>
									</Button>
								</DialogFooter>
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
						<DialogContent className={webView(copyKeysDialogClasses.dialog)}>
							<DialogHeader>
								<DialogTitle>{transferVaultKeysTitle(transferMode, selected.length)}</DialogTitle>
								<DialogDescription>
									{transferMode === "move" ? formCopy.moveDescription : formCopy.copyDescription}
								</DialogDescription>
							</DialogHeader>
							<WebView recipe={copyKeysDialogClasses.body}>
								<Label>{formCopy.destination}</Label>
								<ChoiceSelect
									triggerClassName={webView(copyKeysDialogClasses.trigger)}
									value={targetId}
									onValueChange={setTargetId}
									disabled={action.busy}
									options={[
										{ value: "", label: formCopy.chooseVault },
										...destinations.map((v) => ({ value: v.id, label: v.name })),
										{ value: "__new__", label: formCopy.createVault },
									]}
								/>
								{creatingDestination ? (
									<WebView recipe={copyKeysDialogClasses.newField}>
										<Input
											accessibilityLabel={formCopy.newVaultPlaceholder}
											placeholder={formCopy.newVaultPlaceholder}
											value={newVaultName}
											onChangeText={setNewVaultName}
											editable={!action.busy}
											maxLength={200}
										/>
										{newVaultTaken ? (
											<WebText recipe={copyKeysDialogClasses.newError}>
												{formCopy.newVaultTaken}
											</WebText>
										) : null}
									</WebView>
								) : null}
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
								{transferMode === "move" && current.project_ids.length > 1 ? (
									<WebText recipe={copyKeysDialogClasses.warning}>
										{vaultMoveWarning(current.name, current.project_ids.length)}
									</WebText>
								) : null}
								{transferMode === "copy" ? (
									<WebText recipe={copyKeysDialogClasses.hint}>
										{formCopy.referenceBefore}
										<WebText recipe={copyKeysDialogClasses.emphasis}>
											{formCopy.referenceAction}
										</WebText>
										{formCopy.referenceAfter}
									</WebText>
								) : null}
								<Button
									className={webView(copyKeysDialogClasses.trigger)}
									disabled={
										action.busy ||
										!canTransfer ||
										targets.isError ||
										!selected.length ||
										selected.some((key) => !sections.data?.[key.section]?.includes(key.name))
									}
									onPress={() => transfer(transferMode)}
								>
									<Icon as={ArrowRight} className={webBoth(copyKeysDialogClasses.icon)} />
									<Text>{transferVaultKeysLabel(transferMode, selected.length)}</Text>
								</Button>
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
							<DialogContent className={webView(splitVaultDialogClasses.dialog)}>
								<VaultSplit
									source={identity}
									sourceName={current.name}
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
			{confirmationDialog.dialog}
		</LibraryPage>
	);
}
