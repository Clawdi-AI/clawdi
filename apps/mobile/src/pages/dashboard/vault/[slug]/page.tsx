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
	vaultDetailClasses,
} from "@clawdi/shared/ui";
import {
	fetchAllPages,
	vaultKeyFormCopy as formCopy,
	identityFor,
	splitVaultTitle,
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
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import ArrowRight from "lucide-react-native/icons/arrow-right";
import Check from "lucide-react-native/icons/check";
import AlertCircle from "lucide-react-native/icons/circle-alert";
import ListChecks from "lucide-react-native/icons/list-checks";
import Plus from "lucide-react-native/icons/plus";
import Trash2 from "lucide-react-native/icons/trash";
import { type ReactElement, useCallback, useState } from "react";
import { AppState } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { ChoiceSelect } from "@/components/detail/choice-select";
import { LibraryPage } from "@/components/detail/layout";
import { EntityCardSkeleton } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { useCloudProjects } from "@/components/projects/projects-surface";
import { ResourceError } from "@/components/resource-error";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { NativeList } from "@/components/ui/native-list";
import { SheetPage } from "@/components/ui/sheet-page";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { AppView } from "@/components/ui/view";
import { WebText, WebView, webBoth, webView } from "@/components/ui/web-layout";
import { VaultRequests } from "@/components/vault/secret-requests";
import { VaultSplit } from "@/components/vault/split-vault-dialog";
import { useVaultCatalog } from "@/components/vault/vaults-surface";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useHeaderSearch } from "@/platform/navigation/native-header";
import { useSheet } from "@/platform/navigation/use-sheet";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

type VaultForm = "add-keys" | "transfer" | "split" | "requests";
export function VaultDetailScreen({
	projectId: scopedProject,
	form,
}: {
	projectId?: string;
	form?: VaultForm;
} = {}) {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{
		vaultId?: string | string[];
		slug?: string | string[];
		project?: string | string[];
		projectId?: string | string[];
		keys?: string;
		mode?: string;
	}>();
	const id = scopedProject ? undefined : routeParam(params.vaultId),
		slug = routeParam(params.slug);
	const projectId = scopedProject ?? routeParam(params.project ?? params.projectId);
	const { vault } = useMobileApi(),
		read = useAccountRead();
	const lookup = useQuery({
		queryKey: accountQueryKey(scope, "vault-route", slug, projectId),
		enabled: scope.isReady && Boolean(slug) && !id,
		retry: false,
		queryFn: ({ signal }) =>
			read(async (lease) => {
				const rows = await fetchAllPages(
					(page, page_size) => vault.list({ project_id: projectId, page, page_size }, lease),
					{ resourceName: "Vault catalog" },
				);
				const matches = rows.items.filter((item) => item.slug === slug);
				if (matches.length !== 1) throw new Error("Vault unavailable");
				return matches[0];
			}, signal),
	});
	const identity = id && slug ? { id, slug } : lookup.data;
	if (slug && !id && lookup.isPending)
		return (
			<LibraryPage>
				<PageHeaderSkeleton />
			</LibraryPage>
		);
	if (lookup.isError)
		return (
			<LibraryPage>
				<ApiErrorPanel error={lookup.error} onRetry={() => void lookup.refetch()} />
			</LibraryPage>
		);
	return (
		<VaultDetail
			key={`${scope.identity}:${scope.generation}:${identity?.id}:${slug}`}
			identity={identity}
			form={form}
			selection={parseKeySelection(params.keys)}
			mode={params.mode === "move" ? "move" : "copy"}
		/>
	);
}

function parseKeySelection(value?: string): VaultKeySelection[] {
	if (!value || value.length > 100000) return [];
	try {
		const rows: unknown = JSON.parse(value);
		if (!Array.isArray(rows) || rows.length > 200) return [];
		const selection: VaultKeySelection[] = [];
		const seen = new Set<string>();
		for (const row of rows) {
			if (
				!row ||
				typeof row !== "object" ||
				!("section" in row) ||
				!("name" in row) ||
				typeof row.section !== "string" ||
				typeof row.name !== "string" ||
				row.section.length > 200 ||
				!row.name.length ||
				row.name.length > 200
			)
				return [];
			const key = JSON.stringify([row.section, row.name]);
			if (!seen.has(key)) selection.push({ section: row.section, name: row.name });
			seen.add(key);
		}
		return selection;
	} catch {
		return [];
	}
}
function VaultDetail({
	identity,
	form,
	selection,
	mode,
}: {
	identity?: VaultIdentity;
	form?: VaultForm;
	selection: VaultKeySelection[];
	mode: "copy" | "move";
}) {
	const [keySearch, setKeySearch] = useState("");
	const [selectMode, setSelectMode] = useState(false);
	const t = useI18n();
	const confirmationDialog = useConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { vault } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const projects = useCloudProjects();
	const [closeError, setCloseError] = useState<unknown>();
	const sheet = useSheet<boolean>({ fallback: "/vault", busy: action.busy });
	const openForm = (next: VaultForm, transferMode: "copy" | "move" = "copy") => {
		if (identity)
			router.push({
				pathname:
					next === "add-keys"
						? "/vault/[slug]/add-keys"
						: next === "split"
							? "/vault/[slug]/split"
							: next === "requests"
								? "/vault/[slug]/requests"
								: "/vault/[slug]/transfer",
				params: {
					slug: identity.slug,
					vaultId: identity.id,
					mode: transferMode,
					keys: next === "transfer" ? JSON.stringify(selected) : undefined,
				},
			});
	};
	const targets = useVaultCatalog();
	const [section, setSection] = useState("");
	const [draft, setDraft] = useState("");
	const [replace, setReplace] = useState(false);
	const [showSection, setShowSection] = useState(false);
	const [targetId, setTargetId] = useState("");
	const transferMode = mode;
	const [newVaultName, setNewVaultName] = useState("");
	const [projectTargetId, setProjectTargetId] = useState("");
	const [saved, setSaved] = useState(false);
	const [selected, setSelected] = useState<VaultKeySelection[]>(selection);
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
					return action.runOrThrow(async (isCurrent) => {
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
		// Like Web's Add keys dialog, a successful save closes the sheet onto the updated Vault.
		confirm(
			t("vault.import"),
			t("vault.importWarning"),
			async (isCurrent) => {
				setDraft("");
				await read((s) =>
					vault.upsert(identity, { section: normalizedSection, fields: preview.fields }, s),
				);
				if (isCurrent()) await refresh();
				if (isCurrent()) await sheet.close(true);
			},
			false,
			false,
		);
	};
	const remove = () => {
		if (!identity) return;
		confirm(
			t("vault.deleteTitle", { name: current?.name ?? identity.slug }),
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

	const searchOptions = useHeaderSearch({
		value: keySearch,
		onChange: setKeySearch,
		placeholder: t("libraryPort.searchKeys"),
	});
	if (form === "requests" && current) return <VaultRequests current={current} />;
	if (form)
		return (
			<SheetPage
				title={
					form === "add-keys"
						? formCopy.addTitle
						: form === "transfer"
							? transferVaultKeysTitle(transferMode, selected.length)
							: form === "split"
								? splitVaultTitle(current?.name ?? "")
								: t("vault.requestCreate")
				}
				description={
					form === "add-keys"
						? `${formCopy.addDescriptionBefore}${formCopy.format}${formCopy.addDescriptionAfter}`
						: form === "transfer"
							? transferMode === "move"
								? formCopy.moveDescription
								: formCopy.copyDescription
							: undefined
				}
				fallback="/vault"
				busy={action.busy}
				sheet={sheet}
			>
				{!current || detail.isError ? (
					<ResourceError missing={!identity} onRetry={() => void detail.refetch()} />
				) : !writable && !splitResult ? (
					<ResourceError missing={false} onRetry={() => void sections.refetch()} />
				) : form === "add-keys" ? (
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
									<Label
										className={webBoth(addKeysDialogClasses.label)}
										accessibilityElementsHidden
										importantForAccessibility="no"
										onPress={action.busy ? undefined : () => setReplace(!replace)}
									>
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
									<WebText recipe={addKeysDialogClasses.previewTitle}>{formCopy.preview}</WebText>
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
							<Button variant="ghost" size="sm" disabled={action.busy} onPress={() => setDraft("")}>
								<Text>{t("vault.clear")}</Text>
							</Button>
						) : null}
						<WebText recipe={addKeysDialogClasses.count}>
							{vaultImportDetectedCount(preview.parsed.entries.length, preview.summary.skipped)}
						</WebText>
						<WebView recipe={addKeysDialogClasses.footer}>
							<Button
								variant="ghost"
								disabled={action.busy}
								onPress={() => {
									void sheet.close().catch(setCloseError);
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
						</WebView>
						<Button variant="outline" onPress={() => openForm("requests")}>
							<Text>{t("vault.requestCreate")}</Text>
						</Button>
					</WebView>
				) : form === "transfer" ? (
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
				) : identity ? (
					<VaultSplit
						source={identity}
						sourceName={current.name}
						keys={keyRows}
						disabled={action.busy}
						result={splitResult}
						onSubmit={split}
						onReset={() => setSplitResult(undefined)}
					/>
				) : null}
				{action.error || closeError ? <ApiErrorPanel error={action.error ?? closeError} /> : null}
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
			</SheetPage>
		);
	const keyCells: ReactElement[] = !detail.isError
		? filteredKeys.map(({ section: group, name: key }) => (
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
											t("vault.deleteTitle", { name: key }),
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
			))
		: [];
	const projectCells =
		current && !detail.isError
			? current.project_ids.map((projectId) => (
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
				))
			: [];
	const cells = [
		...keyCells,
		...(current
			? [
					<WebView recipe={vaultDetailClasses.section} key="projects">
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
						</WebView>
					</WebView>,
				]
			: []),
		...projectCells,
	];
	return (
		<SafeAreaScreen>
			<Stack.Screen options={{ headerSearchBarOptions: searchOptions }} />
			<NativeList
				data={cells}
				keyExtractor={(cell, index) => String(cell.key ?? index)}
				renderItem={({ item }) => item}
				refreshing={detail.isRefetching || sections.isRefetching}
				onRefresh={() => void refresh().catch(setCloseError)}
				header={
					<>
						{!identity || detail.isError ? (
							<ResourceError
								missing={
									!identity ||
									(detail.error instanceof ApiClientError && detail.error.status === 404)
								}
								onRetry={() => void detail.refetch()}
							/>
						) : detail.isPending ? (
							<PageHeaderSkeleton icon />
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
									headerActions={
										writable
											? [
													{
														id: "delete",
														label: t("libraryPort.delete"),
														destructive: true,
														onPress: remove,
														disabled: action.busy,
													},
												]
											: undefined
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
													onPress={() => openForm("add-keys")}
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
																	openForm("transfer", mode);
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
										<WebView recipe={vaultDetailClasses.keyGrid}></WebView>
									)}
								</WebView>
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
						{writable ? (
							<Button variant="outline" size="sm" onPress={() => openForm("split")}>
								<Text>{t("vault.splitTitle")}</Text>
							</Button>
						) : null}
					</>
				}
			/>
			{confirmationDialog.dialog}
		</SafeAreaScreen>
	);
}
export function VaultAddKeysPage() {
	return <VaultDetailScreen form="add-keys" />;
}
export function VaultTransferPage() {
	return <VaultDetailScreen form="transfer" />;
}
export function VaultSplitPage() {
	return <VaultDetailScreen form="split" />;
}
export function VaultRequestsPage() {
	return <VaultDetailScreen form="requests" />;
}
