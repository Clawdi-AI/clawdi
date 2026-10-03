import { APPEARANCE_MODES } from "@clawdi/shared/consts";
import { useClerk, useUser } from "@clerk/expo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, AppState } from "react-native";
import { useAuthAction } from "../../src/auth/use-auth-action";
import { useI18n } from "../../src/i18n";
import {
	accountQueryKey,
	useAccountRead,
	useAccountScope,
} from "../../src/platform/account-lifecycle";
import { useForegroundLease } from "../../src/platform/use-foreground-lease";
import { useMobileApi } from "../../src/providers/api-provider";
import { useAppearance } from "../../src/providers/appearance-provider";
import { ErrorState, LoadingScreen } from "../../src/ui/feedback";
import { NativeButton, NativePicker } from "../../src/ui/native-controls";
import { AppScrollView, AppText, AppTextInput, AppView } from "../../src/ui/primitives";

export default function AccountRoute() {
	const scope = useAccountScope();
	return <AccountView key={`${scope.accountKey}:${scope.generation}`} />;
}

function AccountView() {
	const t = useI18n();
	const appearance = useAppearance();
	const { isLoaded, user } = useUser();
	const { signOut } = useClerk();
	const scope = useAccountScope();
	const queryClient = useQueryClient();
	const router = useRouter();
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
	const [rawKey, setRawKey] = useState<string | null>(null);
	const capture = useForegroundLease();
	useFocusEffect(useCallback(() => () => setRawKey(null), []));
	useEffect(() => {
		const subscription = AppState.addEventListener("change", (state) => {
			if (state !== "active") setRawKey(null);
		});
		return () => subscription.remove();
	}, []);
	const email = user?.primaryEmailAddress?.emailAddress;
	const onSignOut = () =>
		run(async (isCurrent) => {
			if (!scope.sessionId || !scope.isCurrent()) return;
			await signOut({ sessionId: scope.sessionId });
			// Invalidate only the captured account; another account may now be active.
			const wasCurrent = scope.isCurrent();
			scope.abort();
			queryClient.removeQueries({
				predicate: ({ queryKey }) =>
					queryKey[0] === "account" &&
					queryKey[1] === (scope.accountKey ?? "signed-out") &&
					queryKey[2] === scope.generation,
			});
			if (isCurrent() && wasCurrent) router.replace("/(auth)/sign-in");
		});
	const onCreateKey = () =>
		run(async (isCurrent) => {
			if (!keyLabel.trim() || rawKey) return;
			const visible = capture();
			if (!visible()) return;
			const created = await read(
				(signal) => account.createApiKey({ label: keyLabel.trim() }, signal),
				scope.signal,
			);
			if (!isCurrent()) return;
			if (visible()) setRawKey(created.raw_key);
			setKeyLabel("");
			await queryClient.invalidateQueries({ queryKey: accountQueryKey(scope, "account-api-keys") });
		});
	const onRevokeKey = (keyId: string) =>
		run(async (isCurrent) => {
			await read((signal) => account.revokeApiKey(keyId, signal), scope.signal);
			if (!isCurrent()) return;
			await queryClient.invalidateQueries({ queryKey: accountQueryKey(scope, "account-api-keys") });
		});
	const confirmRevoke = (keyId: string) => {
		const signal = scope.signal;
		Alert.alert(t("account.revokeApiKey"), t("account.revokeWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("account.revokeApiKey"),
				style: "destructive",
				onPress: () => {
					if (scope.isCurrent() && !signal.aborted) void onRevokeKey(keyId);
				},
			},
		]);
	};
	if (!isLoaded) return <LoadingScreen label={t("loading.authentication")} />;
	return (
		<AppScrollView
			className="flex-1 bg-background"
			contentContainerClassName="gap-8 px-6 pb-10 pt-8"
		>
			<AppText className="text-3xl font-semibold text-foreground">{t("account.title")}</AppText>
			<AppView className="gap-2 rounded-3xl bg-surface p-5">
				<AppText className="text-sm text-muted">{t("account.signedInAs")}</AppText>
				<AppText className="text-lg font-semibold text-foreground">
					{isLoaded && email ? email : t("account.accountUnavailable")}
				</AppText>
			</AppView>
			<NativeButton label={t("navigation.billing")} onPress={() => router.push("/billing")} />
			<AppView className="gap-2 rounded-3xl bg-surface p-5">
				<AppText accessibilityRole="header">{t("appearance.title")}</AppText>
				<AppText>{t("appearance.description")}</AppText>
				<NativePicker
					value={appearance.mode}
					options={APPEARANCE_MODES.map((value) => ({ value, label: t(`appearance.${value}`) }))}
					disabled={!appearance.ready || appearance.busy}
					onValueChange={(value) => void appearance.select(value)}
				/>
				{appearance.error ? (
					<AppText accessibilityRole="alert">{t("appearance.failed")}</AppText>
				) : null}
				{!appearance.ready && appearance.error ? (
					<NativeButton label={t("appearance.retry")} onPress={appearance.reload} />
				) : null}
			</AppView>
			<NativeButton label={t("providers.title")} onPress={() => router.push("/ai-providers")} />
			<NativeButton label={t("channels.title")} onPress={() => router.push("/channels")} />
			<AppView className="gap-2 rounded-3xl bg-surface p-5">
				<AppText className="text-sm text-muted">{t("account.apiKeys")}</AppText>
				<AppTextInput
					accessibilityLabel={t("account.apiKeyLabel")}
					className="rounded-xl bg-background px-3 py-2 text-foreground"
					value={keyLabel}
					onChangeText={setKeyLabel}
					placeholder={t("account.apiKeyLabel")}
				/>
				<NativeButton
					label={t("account.createApiKey")}
					disabled={busy || !scope.isReady || !keyLabel.trim() || Boolean(rawKey)}
					onPress={() => void onCreateKey()}
				/>
				{rawKey ? (
					<AppView className="gap-2">
						<AppText>{t("account.keyShownOnce")}</AppText>
						<AppText selectable className="text-sm text-foreground">
							{rawKey}
						</AppText>
						<NativeButton label={t("account.dismissKey")} onPress={() => setRawKey(null)} />
					</AppView>
				) : null}
				{keys.isPending ? (
					<LoadingScreen />
				) : keys.isError ? (
					<ErrorState onRetry={keys.isFetching ? undefined : () => void keys.refetch()} />
				) : keys.data?.length ? (
					keys.data.map((key) => (
						<AppView className="gap-2" key={key.id}>
							<AppText className="text-sm text-foreground">
								{key.label} · {key.key_prefix}
							</AppText>
							<NativeButton
								label={t("account.revokeApiKey")}
								disabled={busy || Boolean(key.revoked_at)}
								onPress={() => confirmRevoke(key.id)}
							/>
						</AppView>
					))
				) : (
					<AppText className="text-sm text-muted">{t("account.noApiKeys")}</AppText>
				)}
			</AppView>
			{error ? (
				<AppText accessibilityRole="alert" className="text-base text-danger">
					{t("account.actionFailed")}
				</AppText>
			) : null}
			<NativeButton
				label={busy ? t("auth.working") : t("account.signOut")}
				onPress={() => void onSignOut()}
				disabled={busy || !scope.isReady || !scope.sessionId}
			/>
		</AppScrollView>
	);
}
