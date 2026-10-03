import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { ErrorState, LoadingScreen } from "../ui/feedback";
import { NativeButton, NativePicker } from "../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../ui/primitives";

export function MemorySettings() {
	const scope = useAccountScope();
	return <MemorySettingsView key={`${scope.accountKey}:${scope.generation}`} />;
}

function MemorySettingsView() {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { account } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [provider, setProvider] = useState<"builtin" | "mem0" | null>(null);
	const [secret, setSecret] = useState("");
	const [saved, setSaved] = useState(false);
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") setSecret("");
		});
		return () => listener.remove();
	}, []);
	const settings = useQuery({
		queryKey: accountQueryKey(scope, "memory-settings"),
		queryFn: ({ signal }) =>
			read(async (requestSignal) => {
				const result = await account.getSettings(requestSignal);
				return {
					provider: result.memory_provider === "mem0" ? ("mem0" as const) : ("builtin" as const),
					configured: typeof result.mem0_api_key === "string" && result.mem0_api_key.length > 0,
				};
			}, signal),
		enabled: scope.isReady,
		retry: false,
	});
	const save = () =>
		action.run(async (isCurrent) => {
			if (!settings.data) return;
			const memoryProvider = provider ?? settings.data.provider;
			const key = secret.trim();
			if (key === "••••••••") return;
			await read((signal) =>
				account.updateSettings(
					{
						settings: {
							memory_provider: memoryProvider,
							...(key ? { mem0_api_key: key } : {}),
						},
					},
					signal,
				),
			);
			if (!isCurrent()) return;
			setSecret("");
			setProvider(null);
			setSaved(true);
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "memory-settings") });
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "cloud-memories") });
		});
	if (settings.isPending) return <LoadingScreen />;
	if (settings.isError) return <ErrorState onRetry={() => void settings.refetch()} />;
	return (
		<AppView className="gap-3 rounded-2xl bg-surface p-4">
			<AppText accessibilityRole="header">{t("memories.settingsTitle")}</AppText>
			<AppText>{t("memories.settingsScope")}</AppText>
			<NativePicker
				value={provider ?? settings.data.provider}
				disabled={action.busy}
				options={[
					{ value: "builtin", label: t("memories.builtin") },
					{ value: "mem0", label: "Mem0" },
				]}
				onValueChange={(value) => {
					setProvider(value);
					setSaved(false);
				}}
			/>
			<AppText>
				{t(settings.data.configured ? "memories.keyConfigured" : "memories.keyMissing")}
			</AppText>
			<AppTextInput
				secureTextEntry
				autoCapitalize="none"
				autoCorrect={false}
				value={secret}
				accessibilityLabel={t("memories.mem0Key")}
				placeholder={t("memories.mem0Key")}
				editable={!action.busy}
				onChangeText={(value) => {
					setSecret(value);
					setSaved(false);
				}}
				className="rounded-xl bg-background p-3 text-foreground"
			/>
			{action.error ? (
				<AppText accessibilityRole="alert">{t("error.genericMessage")}</AppText>
			) : null}
			{saved ? <AppText accessibilityLiveRegion="polite">{t("memories.saved")}</AppText> : null}
			<NativeButton
				label={t("memories.save")}
				disabled={action.busy || (!provider && !secret.trim())}
				onPress={() => void save()}
			/>
		</AppView>
	);
}
