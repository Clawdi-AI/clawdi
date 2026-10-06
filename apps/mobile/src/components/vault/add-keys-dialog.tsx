import { buildKeyImportPreview, slugFromVaultName, type VaultIdentity } from "@clawdi/shared/api";
import { addKeysDialogClasses } from "@clawdi/shared/ui";
import {
	ADD_KEYS_COPY,
	addKeysActionCopy,
	addKeysConflictCopy,
	addKeysDetectedCopy,
	addKeysReadyCopy,
	addKeysSummaryCopy,
	identityFor,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { AlertCircle, Check } from "lucide-react-native";
import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useMobileApi } from "@/components/api-provider";
import { ChoiceSelect } from "@/components/detail/choice-select";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
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
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { AppScrollView } from "@/components/ui/view";
import { WebText, WebView, webBoth } from "@/components/ui/web-layout";
import { useCompleteVaultCatalog } from "@/components/vault/project-vault-catalog";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useForegroundLease } from "@/platform/use-foreground-lease";

const NEW_VAULT = "__new__";

/** Global Web composer with an explicit stable destination and native secret lifecycle. */
export function AddKeysDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useI18n(),
		scope = useAccountScope(),
		read = useAccountRead(),
		capture = useForegroundLease();
	const { vault } = useMobileApi(),
		cache = useQueryClient();
	const catalog = useCompleteVaultCatalog(undefined, open);
	const [saving, setSaving] = useState(false);
	const [choice, setChoice] = useState(""),
		[name, setName] = useState(""),
		[text, setText] = useState(""),
		[overwrite, setOverwrite] = useState(false),
		[confirmOpen, setConfirmOpen] = useState(false);
	const confirmationLease = useRef<() => boolean>(() => false);
	const reset = useCallback(() => {
		setText("");
		setName("");
		setChoice("");
		setOverwrite(false);
		setConfirmOpen(false);
	}, []);
	useFocusEffect(
		useCallback(() => {
			const subscription = AppState.addEventListener("change", (state) => {
				if (state !== "active") {
					reset();
					onOpenChange(false);
				}
			});
			return () => {
				subscription.remove();
				reset();
			};
		}, [reset, onOpenChange]),
	);
	const ownVaults = (catalog.data?.items ?? []).filter((v) => v.is_owner !== false);
	const effectiveChoice = choice || ownVaults[0]?.id || NEW_VAULT;
	const selected = ownVaults.find((v) => v.id === effectiveChoice);
	const newVault = effectiveChoice === NEW_VAULT,
		slug = slugFromVaultName(name);
	const taken = newVault && !!slug && ownVaults.some((v) => v.slug === slug);
	const sections = useQuery({
		queryKey: accountQueryKey(scope, "vault-sections", selected?.id, selected?.slug),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!selected) throw new Error("Vault unavailable");
				return vault.sections(selected, s);
			}, signal),
		enabled: open && scope.isReady && !!selected,
		retry: false,
	});
	const preview = buildKeyImportPreview(
		text,
		new Set(sections.data?.["(default)"] ?? []),
		overwrite,
	);
	const valid =
		!!catalog.data &&
		!catalog.error &&
		!catalog.isFetching &&
		!preview.parsed.errors.length &&
		preview.importableRows.length > 0 &&
		preview.importableRows.length <= 200 &&
		preview.importableRows.every((row) => row.key.length <= 200) &&
		(newVault
			? !!name.trim() && !!slug && !taken
			: !!selected && sections.isSuccess && !sections.error && !sections.isFetching);
	const close = () => {
		if (!saving) {
			reset();
			onOpenChange(false);
		}
	};
	return (
		<>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next) close();
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("libraryPort.addKeys")}</DialogTitle>
						<DialogDescription>
							<Text>
								{ADD_KEYS_COPY.pasteBefore}{" "}
								<WebText recipe={addKeysDialogClasses.mono}>{ADD_KEYS_COPY.assignment}</WebText>{" "}
								{ADD_KEYS_COPY.pasteAfter}
							</Text>
						</DialogDescription>
					</DialogHeader>
					<WebView recipe={addKeysDialogClasses.body}>
						<Input
							value={text}
							onChangeText={setText}
							placeholder={ADD_KEYS_COPY.placeholder}
							accessibilityLabel={t("vault.importText")}
							multiline
							className={webBoth(addKeysDialogClasses.paste)}
							editable={!saving}
							maxLength={1048576}
							autoCapitalize="none"
							autoCorrect={false}
							autoComplete="off"
							textContentType="none"
						/>
						<WebView recipe={addKeysDialogClasses.destinationGrid}>
							<WebView recipe={addKeysDialogClasses.field}>
								<Label>{ADD_KEYS_COPY.into}</Label>
								<ChoiceSelect
									className={webBoth(addKeysDialogClasses.trigger)}
									value={effectiveChoice}
									displayValue={newVault ? ADD_KEYS_COPY.create : selected?.name}
									onValueChange={(next) => {
										setChoice(next);
										setOverwrite(false);
									}}
									disabled={saving || catalog.isFetching || !!catalog.error}
									options={[
										...ownVaults.map((v) => ({
											value: v.id,
											label: `${identityFor(v.name).emoji} ${v.name}`,
										})),
										{ value: NEW_VAULT, label: ADD_KEYS_COPY.create },
									]}
								/>
							</WebView>
							{newVault ? (
								<WebView recipe={addKeysDialogClasses.newField}>
									<Input
										value={name}
										onChangeText={setName}
										placeholder={ADD_KEYS_COPY.name}
										maxLength={200}
										editable={!saving}
									/>
									{taken ? (
										<WebText recipe={addKeysDialogClasses.error}>{ADD_KEYS_COPY.taken}</WebText>
									) : null}
								</WebView>
							) : null}
						</WebView>
						{catalog.error ? (
							<ApiErrorPanel
								error={catalog.error}
								onRetry={() => void catalog.refetch()}
								title="Couldn't load destinations"
							/>
						) : null}
						{!newVault && sections.error ? (
							<ApiErrorPanel
								error={sections.error}
								onRetry={() => void sections.refetch()}
								title="Couldn't check existing keys"
							/>
						) : null}
						{preview.parsed.errors.length ? (
							<Alert variant="destructive" icon={AlertCircle} title={ADD_KEYS_COPY.invalid}>
								<WebView recipe={addKeysDialogClasses.errors}>
									{preview.parsed.errors.map((error, index) => (
										<Text key={`${index}:${error}`}>• {error}</Text>
									))}
								</WebView>
							</Alert>
						) : null}
						{preview.conflicts.length && !preview.parsed.errors.length ? (
							<WebView recipe={addKeysDialogClasses.conflicts} className="flex-row">
								<Switch checked={overwrite} onCheckedChange={setOverwrite} disabled={saving} />
								<WebView recipe={addKeysDialogClasses.newField} className="flex-1">
									<Label>{ADD_KEYS_COPY.overwrite}</Label>
									<WebText recipe={addKeysDialogClasses.meta}>
										{addKeysConflictCopy(preview.conflicts.length)}
									</WebText>
								</WebView>
							</WebView>
						) : null}
						{preview.preview.length && !preview.parsed.errors.length ? (
							<WebView recipe={addKeysDialogClasses.preview}>
								<WebView recipe={addKeysDialogClasses.previewHeader} className="flex-row">
									<WebText recipe={addKeysDialogClasses.previewTitle}>
										{ADD_KEYS_COPY.preview}
									</WebText>
									<WebView recipe={addKeysDialogClasses.badges} className="flex-row">
										<Badge variant="secondary">
											<Text>{addKeysSummaryCopy(preview.summary.created, "create")}</Text>
										</Badge>
										{preview.conflicts.length > 0 ? (
											<Badge variant="outline">
												<Text>
													{overwrite
														? addKeysSummaryCopy(preview.summary.updated, "update")
														: addKeysSummaryCopy(preview.summary.skipped, "skip")}
												</Text>
											</Badge>
										) : null}
									</WebView>
								</WebView>
								<AppScrollView className={webBoth(addKeysDialogClasses.previewList)}>
									{preview.preview.slice(0, 10).map((row) => (
										<WebView
											key={row.key}
											recipe={addKeysDialogClasses.previewRow}
											className="flex-row"
										>
											<WebText
												recipe={addKeysDialogClasses.key}
												className="flex-1"
												numberOfLines={1}
											>
												{row.key}
											</WebText>
											<Badge variant={row.action === "create" ? "secondary" : "outline"}>
												<Text>{addKeysActionCopy(row.action)}</Text>
											</Badge>
										</WebView>
									))}
									{preview.preview.length > 10 ? (
										<WebText recipe={addKeysDialogClasses.more}>
											{addKeysReadyCopy(preview.preview.length - 10)}
										</WebText>
									) : null}
								</AppScrollView>
							</WebView>
						) : null}

						<WebView recipe={addKeysDialogClasses.footer}>
							<WebText recipe={addKeysDialogClasses.count}>
								{addKeysDetectedCopy(preview.parsed.entries.length, preview.summary.skipped)}
							</WebText>
							<DialogFooter>
								<Button variant="ghost" disabled={saving} onPress={close}>
									<Text>{t("libraryPort.cancel")}</Text>
								</Button>
								<Button
									disabled={!valid || saving}
									onPress={() => {
										confirmationLease.current = capture();
										setConfirmOpen(true);
									}}
								>
									<Icon as={Check} className={webBoth(addKeysDialogClasses.iconSmall)} />
									<Text>
										{ADD_KEYS_COPY.save} {preview.importableRows.length || ""}
									</Text>
								</Button>
							</DialogFooter>
						</WebView>
					</WebView>
				</DialogContent>
			</Dialog>
			<ConfirmAction
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={t("vault.import")}
				description={t("vault.importWarning")}
				confirmLabel={ADD_KEYS_COPY.save}
				onConfirm={async () => {
					setSaving(true);
					try {
						if (!valid || !confirmationLease.current() || !scope.isCurrent())
							throw new Error("Vault unavailable");
						let target: VaultIdentity | undefined = selected;
						if (newVault) target = await read((s) => vault.create({ name: name.trim(), slug }, s));
						else if (target) {
							const identity = target;
							const fresh = await read((s) => vault.get(identity, s));
							if (!fresh.is_owner || fresh.id !== target.id) throw new Error("Vault unavailable");
						}
						if (!target || !scope.isCurrent() || !confirmationLease.current())
							throw new Error("Vault unavailable");
						const destination = target;
						const freshSections = await read((s) => vault.sections(destination, s));
						const freshPreview = buildKeyImportPreview(
							text,
							new Set(freshSections["(default)"] ?? []),
							overwrite,
						);
						if (
							!freshPreview.importableRows.length ||
							freshPreview.importableRows.length > 200 ||
							freshPreview.importableRows.some((row) => row.key.length > 200) ||
							freshPreview.parsed.errors.length ||
							!confirmationLease.current()
						)
							throw new Error("Refresh keys and try again.");
						const fields = freshPreview.fields;
						setText("");
						await read((s) => vault.upsert(destination, { section: "", fields }, s));
						if (!scope.isCurrent()) return;
						await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
						if (confirmationLease.current()) {
							reset();
							onOpenChange(false);
						}
					} finally {
						if (scope.isCurrent()) setSaving(false);
					}
				}}
			/>
		</>
	);
}
