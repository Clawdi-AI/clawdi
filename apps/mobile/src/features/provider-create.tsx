import { AI_PROVIDER_API_MODES, nativeAiProvider } from "@clawdi/shared";
import {
	API_MODE_LABEL,
	type ApiMode,
	type components,
	customProviderRuntimeEnv,
	PROVIDER_PRESETS,
	PROVIDER_TYPE_META,
	type ProviderTypeId,
	providerFormIdentity,
	providerPresetById,
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

type AcceptRequest = components["schemas"]["AiProviderAcceptRequest"];
const choices = [
	...Object.values(PROVIDER_TYPE_META)
		.filter((type) => !PROVIDER_PRESETS.some((preset) => preset.id === type.id))
		.map((type) => ({ id: type.id, label: type.label, type: type.id })),
	...PROVIDER_PRESETS.map((preset) => ({
		id: preset.id,
		label: preset.label,
		type: preset.provider_type,
	})),
];

export function ProviderCreate({
	providers,
	refresh,
}: {
	providers: SavedAiProvider[] | undefined;
	refresh: () => Promise<void>;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { aiProviders } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const capture = useForegroundLease();
	const [open, setOpen] = useState(false);
	const [choice, setChoice] = useState("openai");
	const [type, setType] = useState<ProviderTypeId>("openai");
	const [region, setRegion] = useState<string | null>(null);
	const [label, setLabel] = useState("");
	const [secret, setSecret] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiMode, setApiMode] = useState<ApiMode>("openai_chat");
	const [uncertain, setUncertain] = useState(false);
	const attempt = useRef<{ body: AcceptRequest; key: string } | null>(null);
	const [locked, setLocked] = useState(false);
	const clearSensitive = useCallback(() => {
		setSecret("");
		attempt.current = null;
		setLocked(false);
		setOpen(false);
	}, []);
	useFocusEffect(useCallback(() => clearSensitive, [clearSensitive]));
	useEffect(() => {
		const subscription = AppState.addEventListener("change", (state) => {
			if (state !== "active") clearSensitive();
		});
		return () => subscription.remove();
	}, [clearSensitive]);
	const preset = providerPresetById(choice);
	const route = nativeAiProvider(choice, region);
	const custom = choice === "custom_openai_compatible";
	const submit = () =>
		action.run(async (current) => {
			const visible = capture();
			if (!visible() || !providers) return;
			let saved = attempt.current;
			if (!saved) {
				if (!secret.trim() || (!route && !custom) || (custom && !label.trim())) return;
				if (custom) {
					const url = new URL(baseUrl.trim());
					if (
						(url.protocol !== "https:" && url.protocol !== "http:") ||
						url.username ||
						url.password ||
						url.hash
					)
						throw new Error("Invalid provider endpoint");
				}
				const identity = providerFormIdentity({
					type,
					authMethod: "api_key",
					labelInput: label,
					existingProviderIds: providers.map((provider) => provider.provider_id),
					preset,
				});
				saved = {
					key: randomUUID(),
					body: {
						replace: false,
						credential: { type: "api_key", value: secret.trim() },
						provider: {
							provider_id: identity.providerId,
							label: identity.label,
							type: route?.type ?? type,
							configuration_mode: custom ? "custom" : "native",
							native_provider: route?.id ?? null,
							native_variant: route?.variant ?? null,
							base_url: route?.base_url ?? baseUrl.trim(),
							api_mode: route?.api_mode ?? apiMode,
							auth: { type: "api_key", source: "managed" },
							managed_by: "user",
							runtime_env_name:
								route?.runtime_env_name ?? customProviderRuntimeEnv(identity.providerId, providers),
						},
					},
				};
				attempt.current = saved;
				setLocked(true);
			}
			setUncertain(true);
			const result = await read((signal) => aiProviders.accept(saved.body, saved.key, signal));
			if (!current() || !visible()) return;
			if (result.status !== "ready") throw new Error("Unexpected provider authorization");
			clearSensitive();
			setUncertain(false);
			setLabel("");
			await refresh();
		});
	return (
		<AppView className="gap-3">
			{uncertain ? <AppText accessibilityRole="alert">{t("providers.uncertain")}</AppText> : null}
			{!open ? (
				<NativeButton
					label={t("providers.add")}
					disabled={action.busy || !providers || !scope.isReady}
					onPress={() => {
						action.clearError();
						setOpen(true);
					}}
				/>
			) : (
				<>
					<NativePicker
						value={choice}
						options={choices.map((item) => ({ value: item.id, label: item.label }))}
						disabled={locked || action.busy}
						onValueChange={(value) => {
							const item = choices.find((entry) => entry.id === value);
							if (!item) return;
							setChoice(item.id);
							setType(item.type);
							setRegion(null);
							setSecret("");
						}}
					/>
					{preset?.region_variants?.length ? (
						<NativePicker
							value={region ?? preset.region_variants[0]?.id ?? ""}
							options={preset.region_variants.map((variant) => ({
								value: variant.id,
								label: variant.label,
							}))}
							disabled={locked || action.busy}
							onValueChange={(value) => {
								setRegion(value);
								setSecret("");
							}}
						/>
					) : null}
					<AppTextInput
						accessibilityLabel={t("providers.label")}
						placeholder={t("providers.label")}
						value={label}
						onChangeText={setLabel}
						maxLength={200}
						editable={!locked && !action.busy}
						className="rounded-xl bg-surface p-3 text-foreground"
					/>
					{custom ? (
						<>
							<AppTextInput
								accessibilityLabel={t("providers.endpoint")}
								placeholder="https://"
								value={baseUrl}
								onChangeText={setBaseUrl}
								autoCapitalize="none"
								autoCorrect={false}
								maxLength={1000}
								editable={!locked && !action.busy}
								className="rounded-xl bg-surface p-3 text-foreground"
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
					) : (
						<AppText selectable className="text-sm text-muted">
							{route?.base_url}
						</AppText>
					)}
					<AppTextInput
						accessibilityLabel={t("providers.apiKey")}
						placeholder={t("providers.apiKey")}
						value={secret}
						onChangeText={setSecret}
						secureTextEntry
						autoCapitalize="none"
						autoCorrect={false}
						editable={!locked && !action.busy}
						className="rounded-xl bg-surface p-3 text-foreground"
					/>
					<NativeButton
						label={t(locked ? "providers.retrySame" : "projects.save")}
						disabled={
							action.busy ||
							!providers ||
							!secret.trim() ||
							(custom && (!baseUrl.trim() || !label.trim()))
						}
						onPress={() => void submit()}
					/>
					<NativeButton
						label={t("account.cancel")}
						disabled={action.busy}
						onPress={clearSensitive}
					/>
				</>
			)}
			{action.error ? <AppText accessibilityRole="alert">{t("providers.failed")}</AppText> : null}
		</AppView>
	);
}
