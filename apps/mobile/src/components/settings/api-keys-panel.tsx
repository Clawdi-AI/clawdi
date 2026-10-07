import { apiKeysPanelClasses as styles } from "@clawdi/shared/ui";
import {
	activeApiKeys,
	describeApiKeyScopes,
	formatShortDate,
	settingsCopy,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Terminal, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { Text } from "@/components/ui/text";
import { WebText, WebView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { NativeHeader } from "@/platform/navigation/native-header";
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

/** Web's API keys panel: review and revoke existing keys; new keys are internal only. */
export function ApiKeysPanel() {
	const scope = useAccountScope();
	return <ApiKeysView key={`${scope.accountKey}:${scope.generation}`} />;
}

function KeysRetiredNote() {
	return (
		<Text>
			{settingsCopy.keysRetiredBefore}
			<WebText recipe={styles.command}>{settingsCopy.loginCommand}</WebText>
			{settingsCopy.keysRetiredBetween}
			<WebText recipe={styles.command}>{settingsCopy.noOpenFlag}</WebText>
			{settingsCopy.keysRetiredAfter}
		</Text>
	);
}

function ApiKeysView() {
	const t = useI18n();
	const scope = useAccountScope();
	const cache = useQueryClient();
	const { account } = useMobileApi();
	const read = useAccountRead();
	const keys = useApiKeys();
	const action = useAuthAction(scope.identity);
	const capture = useForegroundLease();
	const [target, setTarget] = useState<{ id: string; label: string } | null>(null);
	const active = activeApiKeys(keys.data);
	const isEmpty = !keys.isPending && !keys.isError && active.length === 0;
	return (
		<>
			<NativeHeader title={settingsCopy.apiKeys} />
			<NativeList
				data={active}
				keyExtractor={(key) => key.id}
				refreshing={keys.isRefetching}
				onRefresh={() => void keys.refetch()}
				header={
					<WebView testID="api-keys-header" recipe={styles.panel}>
						<WebText recipe={styles.factLabel}>{settingsCopy.apiKeysDescription}</WebText>
						{isEmpty ? null : (
							<Alert icon={Terminal}>
								<KeysRetiredNote />
							</Alert>
						)}
						{action.error ? <ApiErrorPanel error={t("account.actionFailed")} /> : null}
					</WebView>
				}
				empty={
					keys.isPending ? (
						<RouteLoadingSkeleton />
					) : keys.isError ? (
						<ApiErrorPanel error={keys.error} onRetry={() => void keys.refetch()} />
					) : (
						<EmptyState title={settingsCopy.emptyKeys} description={<KeysRetiredNote />} />
					)
				}
				footer={
					keys.isError && keys.data ? (
						<ApiErrorPanel error={keys.error} onRetry={() => void keys.refetch()} />
					) : null
				}
				renderItem={({ item: key }) => (
					<WebView testID={`api-key-${key.id}`} recipe={styles.card}>
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
								<WebView key={fact.label} recipe={styles.factBody} className="w-1/2">
									<WebText recipe={styles.factLabel}>{fact.label}</WebText>
									<WebText recipe={styles.factValue}>
										{fact.value ? formatShortDate(fact.value) : settingsCopy.never}
									</WebText>
								</WebView>
							))}
							<WebView recipe={styles.factWide} className="w-full">
								<WebText recipe={styles.factLabel}>{settingsCopy.permissions}</WebText>
								<WebText recipe={styles.permissionsValue}>
									{describeApiKeyScopes(key.scopes)}
								</WebText>
							</WebView>
						</WebView>
					</WebView>
				)}
			/>
			<ConfirmAction
				open={target !== null}
				onOpenChange={(open) => {
					if (!open) setTarget(null);
				}}
				title={settingsCopy.revokeTitle.replace(
					"{label}",
					() => target?.label ?? t("account.apiKey"),
				)}
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
