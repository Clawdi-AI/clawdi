import { apiKeysPanelClasses as styles } from "@clawdi/shared/ui";
import { activeApiKeys, formatShortDate, settingsCopy } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { Laptop, Plus, ShieldCheck, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { NativeList } from "@/components/ui/native-list";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text } from "@/components/ui/text";
import { WebText, WebView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { NativeHeader } from "@/platform/navigation/native-header";
import { useSheet } from "@/platform/navigation/use-sheet";
import { useForegroundLease } from "@/platform/use-foreground-lease";

function useApiKeys() {
	const scope = useAccountScope();
	const { account } = useMobileApi();
	const read = useAccountRead();
	return useQuery({
		queryKey: accountQueryKey(scope, "account-api-keys"),
		queryFn: ({ signal }) => read((lease) => account.listApiKeys(lease), signal),
		enabled: scope.isReady,
		retry: false,
	});
}
export function ApiKeysPanel() {
	const scope = useAccountScope();
	return <ApiKeysView key={`${scope.accountKey}:${scope.generation}`} />;
}
function ApiKeysView() {
	const t = useI18n();
	const router = useRouter();
	const scope = useAccountScope();
	const cache = useQueryClient();
	const { account } = useMobileApi();
	const read = useAccountRead();
	const keys = useApiKeys();
	const action = useAuthAction(scope.identity);
	const capture = useForegroundLease();
	const [target, setTarget] = useState<{ id: string; label: string } | null>(null);
	const openCreate = () => router.push("/settings/api-keys/new");
	return (
		<>
			<NativeHeader
				title={settingsCopy.apiKeys}
				actions={[
					{
						id: "create",
						label: settingsCopy.createKey,
						disabled: action.busy || !scope.isReady,
						onPress: openCreate,
					},
				]}
			/>
			<NativeList
				data={activeApiKeys(keys.data)}
				keyExtractor={(key) => key.id}
				refreshing={keys.isRefetching}
				onRefresh={() => void keys.refetch()}
				header={
					<WebView recipe={styles.panel}>
						<WebText recipe={styles.description}>{settingsCopy.apiKeysDescription}</WebText>
						<WebView recipe={styles.notice} className="flex-row">
							<Icon as={Laptop} className={styles.noticeIcon} />
							<Text className="flex-1 text-sm text-muted-foreground">
								<WebText recipe={styles.strong}>{settingsCopy.laptopTitle}</WebText>{" "}
								{t("settingsParity.laptopBefore")}
								<WebText recipe={styles.command}>{settingsCopy.laptopCommand}</WebText>
								{t("settingsParity.laptopAfter")}
							</Text>
						</WebView>
						{action.error ? <ApiErrorPanel error={t("account.actionFailed")} /> : null}
					</WebView>
				}
				empty={
					keys.isPending ? (
						<RouteLoadingSkeleton />
					) : keys.isError ? (
						<ApiErrorPanel error={keys.error} onRetry={() => void keys.refetch()} />
					) : (
						<EmptyState
							title={settingsCopy.emptyKeys}
							description={t("settingsParity.emptyKeysDescription")}
							action={
								<Button onPress={openCreate}>
									<Icon as={Plus} />
									<Text>{settingsCopy.createKey}</Text>
								</Button>
							}
						/>
					)
				}
				footer={
					keys.isError && keys.data ? (
						<ApiErrorPanel error={keys.error} onRetry={() => void keys.refetch()} />
					) : null
				}
				renderItem={({ item: key }) => (
					<WebView recipe={styles.card}>
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
								disabled={action.busy}
								onPress={() => setTarget(key)}
								textClassName={styles.revoke}
							>
								<Icon as={Trash2} />
								<Text>{settingsCopy.revoke}</Text>
							</Button>
						</WebView>
						<WebView recipe={styles.facts} className="flex-row flex-wrap">
							{[
								{ label: settingsCopy.created, value: key.created_at },
								{ label: settingsCopy.lastUsed, value: key.last_used_at },
								...(key.expires_at ? [{ label: settingsCopy.expires, value: key.expires_at }] : []),
							].map((fact) => (
								<WebView key={fact.label} recipe={styles.factBody} className="flex-1">
									<WebText recipe={styles.muted}>{fact.label}</WebText>
									<WebText recipe={styles.description}>
										{fact.value ? formatShortDate(fact.value) : settingsCopy.never}
									</WebText>
								</WebView>
							))}
						</WebView>
					</WebView>
				)}
			/>
			<ConfirmAction
				open={target !== null}
				onOpenChange={(open) => {
					if (!open) setTarget(null);
				}}
				title={settingsCopy.revokeTitle.replace("{label}", target?.label ?? "API key")}
				description={settingsCopy.revokeDescription}
				destructive
				confirmLabel={settingsCopy.revokeKey}
				onConfirm={() =>
					action.runOrThrow(async (current) => {
						const visible = capture();
						if (!target || !scope.isCurrent() || !visible()) return;
						await read((signal) => account.revokeApiKey(target.id, signal));
						if (current() && visible())
							await cache.invalidateQueries({
								queryKey: accountQueryKey(scope, "account-api-keys"),
							});
					})
				}
			/>
		</>
	);
}

export function ApiKeyCreateScreen() {
	const scope = useAccountScope();
	return <ApiKeyCreateView key={`${scope.accountKey}:${scope.generation}`} />;
}
function ApiKeyCreateView() {
	const t = useI18n();
	const scope = useAccountScope();
	const cache = useQueryClient();
	const { account } = useMobileApi();
	const read = useAccountRead();
	const action = useAuthAction(scope.identity);
	const capture = useForegroundLease();
	const [label, setLabel] = useState("");
	const [rawKey, setRawKey] = useState<string | null>(null);
	const [acknowledged, setAcknowledged] = useState(false);
	const sheet = useSheet<boolean>({
		fallback: "/settings/api-keys",
		busy: action.busy || Boolean(rawKey && !acknowledged),
	});
	const clear = useCallback(() => {
		setRawKey(null);
		setAcknowledged(false);
	}, []);
	useFocusEffect(useCallback(() => clear, [clear]));
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") clear();
		});
		return () => listener.remove();
	}, [clear]);
	return (
		<SheetPage
			title={t(rawKey ? "settingsParity.saveKey" : "settingsParity.createKey")}
			description={t(
				rawKey ? "settingsParity.saveKeyDescription" : "settingsParity.createDescription",
			)}
			fallback="/settings/api-keys"
			busy={action.busy || Boolean(rawKey && !acknowledged)}
			sheet={sheet}
		>
			<WebView recipe={styles.form}>
				{rawKey ? (
					<>
						<WebView recipe={styles.createdAlert}>
							<Icon as={ShieldCheck} />
							<WebText recipe={styles.strong}>{settingsCopy.keyCreated}</WebText>
							<WebText recipe={styles.description}>{settingsCopy.storeKey}</WebText>
						</WebView>
						<WebView recipe={styles.secretBox}>
							<WebText selectable recipe={styles.secret}>
								{rawKey}
							</WebText>
						</WebView>
						<WebView recipe={styles.acknowledgement} className="flex-row">
							<Checkbox checked={acknowledged} onCheckedChange={setAcknowledged} />
							<WebText recipe={styles.acknowledgementLabel} className="flex-1">
								{settingsCopy.acknowledgeKey}
							</WebText>
						</WebView>
						<Button
							disabled={!acknowledged || action.busy}
							onPress={() =>
								void action.run(async () => {
									if (!acknowledged) return;
									await sheet.close(true);
									clear();
								})
							}
						>
							<Text>{settingsCopy.done}</Text>
						</Button>
					</>
				) : (
					<>
						<WebView recipe={styles.field}>
							<Label>{settingsCopy.keyName}</Label>
							<Input
								maxLength={200}
								accessibilityLabel={settingsCopy.keyName}
								placeholder={settingsCopy.keyPlaceholder}
								value={label}
								onChangeText={setLabel}
								editable={!action.busy}
							/>
							<WebText recipe={styles.description}>{settingsCopy.keyNameHelp}</WebText>
						</WebView>
						<Button
							disabled={action.busy || !scope.isReady || !label.trim()}
							onPress={() =>
								void action.run(async (current) => {
									if (!label.trim() || label.trim().length > 200 || rawKey) return;
									const visible = capture();
									if (!visible()) return;
									const created = await read((signal) =>
										account.createApiKey({ label: label.trim() }, signal),
									);
									if (!current()) return;
									if (visible()) {
										setRawKey(created.raw_key);
										setAcknowledged(false);
									}
									setLabel("");
									await cache.invalidateQueries({
										queryKey: accountQueryKey(scope, "account-api-keys"),
									});
								})
							}
						>
							<Icon as={Plus} />
							<Text>{settingsCopy.createKey}</Text>
						</Button>
					</>
				)}
				{action.error ? <ApiErrorPanel error={t("account.actionFailed")} /> : null}
			</WebView>
		</SheetPage>
	);
}
