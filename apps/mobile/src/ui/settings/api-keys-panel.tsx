import { apiKeysPanelClasses as styles } from "@clawdi/shared/ui";
import { activeApiKeys, formatShortDate } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { Laptop, Plus, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useCurrentUser } from "../../auth/auth-client";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../alert-dialog";
import { ApiErrorPanel } from "../api-error-panel";
import { Button } from "../button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../dialog";
import { EmptyState } from "../empty-state";
import { Icon } from "../icon";
import { Input, Label } from "../input";
import { RouteLoadingSkeleton } from "../route-loading-skeleton";
import { Switch } from "../switch";
import { Text } from "../text";
import { WebText, WebView } from "../web-layout";
import { SettingsPanelHeader } from "./section";

export function ApiKeysPanel() {
	const scope = useAccountScope();
	return <ApiKeysView key={`${scope.accountKey}:${scope.generation}`} />;
}

function ApiKeysView() {
	const t = useI18n();
	const { isLoaded } = useCurrentUser();
	const scope = useAccountScope();
	const queryClient = useQueryClient();
	const { account } = useMobileApi();
	const read = useAccountRead();
	const keys = useQuery({
		queryKey: accountQueryKey(scope, "account-api-keys"),
		queryFn: ({ signal }) => read((readSignal) => account.listApiKeys(readSignal), signal),
		enabled: scope.isReady,
		retry: false,
	});
	const { busy, error, run } = useAuthAction(scope.identity);
	const [keyLabel, setKeyLabel] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const [revokeTarget, setRevokeTarget] = useState<{ id: string; label: string } | null>(null);
	const [rawKey, setRawKey] = useState<string | null>(null);
	const capture = useForegroundLease();
	useFocusEffect(
		useCallback(
			() => () => {
				setRawKey(null);
				setRevokeTarget(null);
			},
			[],
		),
	);
	useEffect(() => {
		const subscription = AppState.addEventListener("change", (state) => {
			if (state !== "active") {
				setRawKey(null);
				setRevokeTarget(null);
			}
		});
		return () => subscription.remove();
	}, []);
	const onCreateKey = () =>
		run(async (isCurrent) => {
			if (!keyLabel.trim() || keyLabel.trim().length > 200 || rawKey) return;
			const visible = capture();
			if (!visible()) return;
			const created = await read(
				(signal) => account.createApiKey({ label: keyLabel.trim() }, signal),
				scope.signal,
			);
			if (!isCurrent()) return;
			if (visible()) {
				setRawKey(created.raw_key);
				setAcknowledged(false);
			}
			setKeyLabel("");
			await queryClient.invalidateQueries({ queryKey: accountQueryKey(scope, "account-api-keys") });
		});
	const onRevokeKey = (keyId: string) =>
		run(async (isCurrent) => {
			if (!scope.isCurrent() || !capture()()) return;
			await read((signal) => account.revokeApiKey(keyId, signal), scope.signal);
			if (!isCurrent()) return;
			setRevokeTarget(null);
			await queryClient.invalidateQueries({ queryKey: accountQueryKey(scope, "account-api-keys") });
		});
	if (!isLoaded) return <RouteLoadingSkeleton />;

	const items = activeApiKeys(keys.data);
	const openCreate = () => {
		if (!rawKey) {
			setKeyLabel("");
			setAcknowledged(false);
			setCreateOpen(true);
		}
	};
	return (
		<WebView recipe={styles.panel}>
			<SettingsPanelHeader
				title={t("settingsParity.apiKeys")}
				description={t("settingsParity.apiKeysDescription")}
				actions={
					<Button onPress={openCreate}>
						<Icon as={Plus} />
						<Text>{t("settingsParity.createKey")}</Text>
					</Button>
				}
			/>
			<WebView recipe={styles.notice} className="flex-row">
				<Icon as={Laptop} className={styles.noticeIcon} />
				<Text className="flex-1 text-sm text-muted-foreground">
					<WebText recipe={styles.strong}>{t("settingsParity.laptopTitle")}</WebText>{" "}
					{t("settingsParity.laptopBefore")}
					<WebText recipe={styles.command}>{t("settingsParity.laptopCommand")}</WebText>
					{t("settingsParity.laptopAfter")}
				</Text>
			</WebView>
			{keys.isPending ? (
				<RouteLoadingSkeleton />
			) : keys.isError ? (
				<ApiErrorPanel error={keys.error} onRetry={() => void keys.refetch()} />
			) : items.length ? (
				<WebView recipe={styles.cards}>
					{items.map((key) => (
						<WebView key={key.id} recipe={styles.card}>
							<WebView recipe={styles.cardHeader} className="flex-row">
								<WebView recipe={styles.factBody} className="flex-1">
									<WebText recipe={styles.cardName}>{key.label}</WebText>
									<WebView recipe={styles.cardPrefix}>
										<WebText recipe={styles.keyPrefix}>{key.key_prefix}…</WebText>
									</WebView>
								</WebView>
								<Button
									variant="ghost"
									size="sm"
									disabled={busy}
									onPress={() => setRevokeTarget({ id: key.id, label: key.label })}
									textClassName={styles.revoke}
								>
									<Icon as={Trash2} />
									<Text>{t("settingsParity.revoke")}</Text>
								</Button>
							</WebView>
							<WebView recipe={styles.facts} className="flex-row flex-wrap">
								{[
									{ label: t("settingsParity.created"), value: key.created_at },
									{ label: t("settingsParity.lastUsed"), value: key.last_used_at },
									...(key.expires_at
										? [{ label: t("settingsParity.expires"), value: key.expires_at }]
										: []),
								].map((fact) => (
									<WebView key={fact.label} recipe={styles.factBody} className="flex-1">
										<WebText recipe={styles.description}>{fact.label}</WebText>
										<WebText recipe={styles.description}>
											{fact.value ? formatShortDate(fact.value) : t("settingsParity.never")}
										</WebText>
									</WebView>
								))}
							</WebView>
						</WebView>
					))}
				</WebView>
			) : (
				<EmptyState
					title={t("settingsParity.emptyKeys")}
					description={t("settingsParity.emptyKeysDescription")}
					action={
						<Button onPress={openCreate}>
							<Text>{t("settingsParity.createKey")}</Text>
						</Button>
					}
				/>
			)}
			<AlertDialog
				open={revokeTarget !== null}
				onOpenChange={(open) => {
					if (!busy && !open) setRevokeTarget(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("settingsParity.revokeTitle").replace("{label}", revokeTarget?.label ?? "API key")}
						</AlertDialogTitle>
						<AlertDialogDescription>{t("settingsParity.revokeDescription")}</AlertDialogDescription>
					</AlertDialogHeader>
					{error ? (
						<WebText accessibilityRole="alert" recipe={styles.error}>
							{t("account.actionFailed")}
						</WebText>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>{t("account.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={busy || !revokeTarget}
							onPress={() => {
								if (revokeTarget) void onRevokeKey(revokeTarget.id);
							}}
						>
							<Text>{t("settingsParity.revokeKey")}</Text>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<Dialog
				open={createOpen}
				onOpenChange={(open) => {
					if (!busy && !rawKey) setCreateOpen(open);
				}}
			>
				<DialogContent showCloseButton={!busy && !rawKey}>
					<DialogHeader>
						<DialogTitle>
							{t(rawKey ? "settingsParity.saveKey" : "settingsParity.createKey")}
						</DialogTitle>
						<DialogDescription>
							{t(rawKey ? "settingsParity.saveKeyDescription" : "settingsParity.createDescription")}
						</DialogDescription>
					</DialogHeader>
					{rawKey ? (
						<WebView recipe={styles.form}>
							<WebView recipe={styles.secretBox}>
								<WebText selectable recipe={styles.secret}>
									{rawKey}
								</WebText>
							</WebView>
							<WebView recipe={styles.acknowledgement} className="flex-row">
								<Switch checked={acknowledged} onCheckedChange={setAcknowledged} />
								<WebText recipe={styles.acknowledgementLabel} className="flex-1">
									{t("settingsParity.acknowledgeKey")}
								</WebText>
							</WebView>
							<Button
								disabled={!acknowledged}
								onPress={() => {
									setRawKey(null);
									setCreateOpen(false);
								}}
							>
								<Text>{t("account.dismissKey")}</Text>
							</Button>
						</WebView>
					) : (
						<WebView recipe={styles.field}>
							<Label>{t("settingsParity.keyName")}</Label>
							<Input
								maxLength={200}
								accessibilityLabel={t("settingsParity.keyName")}
								placeholder={t("settingsParity.keyPlaceholder")}
								value={keyLabel}
								onChangeText={setKeyLabel}
								editable={!busy}
							/>
							{error ? (
								<WebText accessibilityRole="alert" recipe={styles.error}>
									{t("account.actionFailed")}
								</WebText>
							) : null}
							<DialogFooter>
								<Button variant="outline" disabled={busy} onPress={() => setCreateOpen(false)}>
									<Text>{t("account.cancel")}</Text>
								</Button>
								<Button
									disabled={busy || !scope.isReady || !keyLabel.trim() || Boolean(rawKey)}
									onPress={() => void onCreateKey()}
								>
									<Text>{t("settingsParity.createKey")}</Text>
								</Button>
							</DialogFooter>
						</WebView>
					)}
				</DialogContent>
			</Dialog>
			{error && !createOpen ? (
				<WebText accessibilityRole="alert" recipe={styles.error}>
					{t("account.actionFailed")}
				</WebText>
			) : null}
		</WebView>
	);
}
