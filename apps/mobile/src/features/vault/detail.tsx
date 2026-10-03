import { ApiClientError, buildKeyImportPreview, type VaultIdentity } from "@clawdi/shared/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, AppState } from "react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { NativeButton, NativePicker, NativeSwitch } from "../../ui/native-controls";
import { AppScrollView, AppText, AppTextInput, AppView } from "../../ui/primitives";
import { ReadScreen } from "../../ui/read-screen";
import { BackButton } from "../cloud-inventory";
import { useCloudProjects } from "../projects";
import { routeParam } from "../read-helpers";
import { ResourceError } from "../resource-error";
import { useVaultCatalog } from "./catalog";
import { VaultRequests } from "./requests";

export function VaultDetailScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ vaultId?: string | string[]; slug?: string | string[] }>();
	const id = routeParam(params.vaultId);
	const slug = routeParam(params.slug);
	return (
		<VaultDetail
			key={`${scope.identity}:${scope.generation}:${id}:${slug}`}
			identity={id && slug ? { id, slug } : undefined}
		/>
	);
}

function VaultDetail({ identity }: { identity?: VaultIdentity }) {
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
						await perform(() => isCurrent() && visible());
						if (isCurrent() && visible()) setSaved(true);
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
	return (
		<ReadScreen>
			<AppScrollView
				contentContainerStyle={{ padding: 24, gap: 16 }}
				keyboardShouldPersistTaps="handled"
			>
				<BackButton />
				<AppText accessibilityRole="header" className="text-3xl font-semibold text-foreground">
					{current?.name ?? t("vault.title")}
				</AppText>
				<AppText className="text-muted">{t("vault.description")}</AppText>
				{!identity || detail.isError ? (
					<ResourceError
						missing={
							!identity || (detail.error instanceof ApiClientError && detail.error.status === 404)
						}
						onRetry={detail.isFetching ? undefined : () => void detail.refetch()}
					/>
				) : null}
				{detail.isPending && identity ? <AppText>{t("loading.app")}</AppText> : null}
				{current && !detail.isError ? (
					<>
						<AppText className="text-muted">
							{current.slug} · {t(current.is_owner ? "vault.owner" : "vault.shared")}
						</AppText>
						{current.is_owner ? <VaultRequests current={current} /> : null}
						<NativeButton
							label={t("vault.refresh")}
							disabled={detail.isFetching || sections.isFetching || action.busy}
							onPress={() => void refresh()}
						/>
						{sections.isPending ? <AppText>{t("loading.app")}</AppText> : null}
						{sections.isError ? (
							<ResourceError
								missing={sections.error instanceof ApiClientError && sections.error.status === 404}
								onRetry={sections.isFetching ? undefined : () => void sections.refetch()}
							/>
						) : null}
						{sections.isSuccess && !Object.keys(sections.data).length ? (
							<AppText>{t("vault.noKeys")}</AppText>
						) : null}
						{sections.isSuccess
							? Object.entries(sections.data).map(([group, keys]) => (
									<AppView key={group} className="gap-2 rounded-xl bg-surface p-4">
										<AppText className="font-semibold text-foreground">
											{group === "(default)" ? t("vault.defaultSection") : group}
										</AppText>
										{keys.map((key) => (
											<AppView key={key} className="gap-1">
												<AppText className="text-foreground">{key}</AppText>
												{writable ? (
													<NativeButton
														label={`${t("vault.deleteKey")}: ${key}`}
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
													/>
												) : null}
											</AppView>
										))}
									</AppView>
								))
							: null}
						<AppText className="text-lg font-semibold text-foreground">
							{t("vault.projects")}
						</AppText>
						{!current.project_ids.length ? <AppText>{t("vault.unattached")}</AppText> : null}
						{current.project_ids.map((projectId) => (
							<AppView key={projectId} className="gap-2">
								<AppText className="text-foreground">
									{projects.data?.find((p) => p.id === projectId)?.name ?? projectId}
								</AppText>
								{writable ? (
									<NativeButton
										label={t("vault.detach")}
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
									/>
								) : null}
							</AppView>
						))}
						{writable ? (
							<AppView className="gap-3">
								<NativePicker
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
								<NativeButton
									label={t("vault.attach")}
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
								/>
								<AppTextInput
									accessibilityLabel={t("vault.section")}
									placeholder={t("vault.section")}
									value={section}
									maxLength={200}
									onChangeText={setSection}
									editable={!action.busy}
									autoCapitalize="none"
									autoCorrect={false}
									className="rounded-xl bg-surface p-3 text-foreground"
								/>
								<AppTextInput
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
									className="min-h-32 rounded-xl bg-surface p-3 text-foreground"
								/>
								<NativeSwitch
									label={t("vault.replace")}
									value={replace}
									onValueChange={setReplace}
									disabled={action.busy}
								/>
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
										<NativeButton
											label={t("vault.clear")}
											onPress={() => setDraft("")}
											disabled={action.busy}
										/>
									</>
								) : null}
								<NativeButton
									label={t("vault.import")}
									disabled={action.busy || !validImport}
									onPress={importKeys}
								/>
								<AppText>{t("vault.copyTarget")}</AppText>
								<NativePicker
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
									<NativeButton
										label={t("vault.loadTargets")}
										disabled={targets.isFetching}
										onPress={() => void targets.fetchNextPage()}
									/>
								) : null}
								<NativeButton
									label={t("vault.copy")}
									disabled={
										action.busy ||
										!destination ||
										targets.isError ||
										!validSection ||
										existing.size === 0 ||
										existing.size > 200
									}
									onPress={() => {
										if (!identity || !destination) return;
										confirm(
											t("vault.copy"),
											`${destination.name}\n\n${t("vault.copyWarning")}`,
											async (isCurrent) => {
												await read((s) =>
													vault.copyItems(
														identity,
														destination,
														{ section: normalizedSection, fields: [...existing] },
														s,
													),
												);
												if (isCurrent()) await refresh();
											},
										);
									}}
								/>
								<NativeButton label={t("vault.remove")} disabled={action.busy} onPress={remove} />
							</AppView>
						) : null}
					</>
				) : null}
				{action.error ? <AppText accessibilityRole="alert">{t("vault.failed")}</AppText> : null}
				{saved ? <AppText accessibilityRole="alert">{t("vault.saved")}</AppText> : null}
			</AppScrollView>
		</ReadScreen>
	);
}
