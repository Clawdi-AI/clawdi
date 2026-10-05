import { AI_PROVIDER_API_MODES, nativeAiProvider } from "@clawdi/shared";
import {
	API_MODE_LABEL,
	type ApiMode,
	authFor,
	derivedProviderFields,
	providerEditOperation,
	providerPresetById,
	providerPresetForSavedProvider,
	type SavedAiProvider,
} from "@clawdi/shared/api";
import { randomUUID } from "expo-crypto";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton, NativePicker } from "../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../ui/primitives";

export function ProviderEdit({
	provider,
	refresh,
}: {
	provider: SavedAiProvider;
	refresh: () => Promise<void>;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { aiProviders } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const capture = useForegroundLease();
	const oauth = provider.auth.type === "agent_profile" || provider.auth.type === "oauth_profile";
	const preset =
		providerPresetById(provider.native_provider) ??
		providerPresetForSavedProvider({ baseUrl: provider.base_url });
	const defaults = derivedProviderFields(provider.type, oauth ? "oauth" : "api_key", preset);
	const [open, setOpen] = useState(false);
	const [label, setLabel] = useState(provider.label ?? "");
	const [baseUrl, setBaseUrl] = useState(provider.base_url);
	const [apiMode, setApiMode] = useState<ApiMode>(provider.api_mode ?? defaults.apiMode);
	const [region, setRegion] = useState(provider.native_variant ?? null);
	const [secret, setSecret] = useState("");
	const [locked, setLocked] = useState(false);
	const [uncertain, setUncertain] = useState(false);
	const attempt = useRef<{
		operation: ReturnType<typeof providerEditOperation>;
		key: string;
	} | null>(null);
	const clear = useCallback(() => {
		attempt.current = null;
		setSecret("");
		setLocked(false);
		setOpen(false);
	}, []);
	useFocusEffect(useCallback(() => clear, [clear]));
	useEffect(() => {
		const subscription = AppState.addEventListener("change", (state) => {
			if (state !== "active") clear();
		});
		return () => subscription.remove();
	}, [clear]);
	const native = provider.configuration_mode === "native";
	const route = native
		? nativeAiProvider(provider.native_provider ?? provider.type, region)
		: undefined;
	const save = () =>
		action.run(async (current) => {
			const visible = capture();
			if (!visible()) return;
			let saved = attempt.current;
			if (!saved) {
				const endpoint = !oauth && route ? route.base_url : baseUrl.trim();
				const url = new URL(endpoint);
				if (
					(url.protocol !== "http:" && url.protocol !== "https:") ||
					url.username ||
					url.password ||
					url.hash
				)
					throw new Error("Invalid endpoint");
				if (native && !route && !oauth) throw new Error("Unknown native provider");
				saved = {
					key: randomUUID(),
					operation: providerEditOperation(
						provider,
						{
							provider_id: provider.provider_id,
							label: label.trim() || provider.label || null,
							type: route?.type ?? provider.type,
							configuration_mode: provider.configuration_mode ?? "catalog",
							native_provider: provider.native_provider,
							native_variant: route?.variant ?? provider.native_variant,
							base_url: endpoint,
							api_mode: !oauth && route ? route.api_mode : apiMode,
							auth: authFor(oauth ? "oauth" : "api_key"),
							managed_by: provider.managed_by,
							runtime_env_name:
								!oauth && route ? route.runtime_env_name : provider.runtime_env_name,
							...(!native ? { models: provider.models, capabilities: provider.capabilities } : {}),
						},
						oauth ? "" : secret,
					),
				};
				attempt.current = saved;
				setLocked(true);
			}
			setUncertain(true);
			const submitting = saved;
			if (submitting.operation.kind === "accept") {
				const body = submitting.operation.body;
				const result = await read((signal) => aiProviders.accept(body, submitting.key, signal));
				if (result.status !== "ready") throw new Error("Unexpected authorization");
			} else {
				const body = submitting.operation.body;
				await read((signal) => aiProviders.update(provider.provider_id, body, signal));
			}
			if (!current() || !visible()) return;
			clear();
			setUncertain(false);
			await refresh();
		});
	return (
		<AppView className="gap-3">
			{uncertain ? <AppText accessibilityRole="alert">{t("providers.uncertain")}</AppText> : null}
			{!open ? (
				<NativeButton
					label={t("providers.edit")}
					disabled={action.busy || !scope.isReady}
					onPress={() => {
						setLabel(provider.label ?? "");
						setBaseUrl(provider.base_url);
						setApiMode(provider.api_mode ?? defaults.apiMode);
						setRegion(provider.native_variant ?? null);
						action.clearError();
						setOpen(true);
					}}
				/>
			) : (
				<>
					<AppTextInput
						accessibilityLabel={t("providers.label")}
						value={label}
						onChangeText={setLabel}
						maxLength={200}
						editable={!locked && !action.busy}
						className="rounded-xl bg-background p-3 text-foreground"
					/>
					{!oauth && native && preset?.region_variants?.length ? (
						<NativePicker
							value={region ?? preset.region_variants[0]?.id ?? ""}
							options={preset.region_variants.map((variant) => ({
								value: variant.id,
								label: variant.label,
							}))}
							disabled={locked || action.busy}
							onValueChange={setRegion}
						/>
					) : null}
					{!oauth && !native ? (
						<>
							<AppTextInput
								accessibilityLabel={t("providers.endpoint")}
								value={baseUrl}
								onChangeText={setBaseUrl}
								maxLength={1000}
								autoCorrect={false}
								autoCapitalize="none"
								editable={!locked && !action.busy}
								className="rounded-xl bg-background p-3 text-foreground"
							/>
							<NativePicker
								value={apiMode}
								options={AI_PROVIDER_API_MODES.map((mode) => ({
									value: mode,
									label: API_MODE_LABEL[mode],
								}))}
								disabled={locked || action.busy}
								onValueChange={setApiMode}
							/>
						</>
					) : null}
					{!oauth ? (
						<>
							<AppText className="text-sm text-muted-foreground">
								{t("providers.keepCredential")}
							</AppText>
							<AppTextInput
								accessibilityLabel={t("providers.apiKey")}
								placeholder={t("providers.apiKey")}
								value={secret}
								onChangeText={setSecret}
								secureTextEntry
								autoCorrect={false}
								autoCapitalize="none"
								editable={!locked && !action.busy}
								className="rounded-xl bg-background p-3 text-foreground"
							/>
						</>
					) : null}
					<NativeButton
						label={t(locked ? "providers.retrySame" : "projects.save")}
						disabled={action.busy || !scope.isReady || !baseUrl.trim()}
						onPress={() => void save()}
					/>
					<NativeButton label={t("account.cancel")} disabled={action.busy} onPress={clear} />
				</>
			)}
			{action.error ? <AppText accessibilityRole="alert">{t("providers.failed")}</AppText> : null}
		</AppView>
	);
}
