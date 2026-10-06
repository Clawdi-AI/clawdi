import { nativeAiProvider } from "@clawdi/shared";
import {
	type ApiMode,
	type components,
	customProviderRuntimeEnv,
	PROVIDER_TYPE_META,
	type ProviderTypeId,
	providerFormIdentity,
	providerPresetById,
	providerPresetRegion,
	type SavedAiProvider,
} from "@clawdi/shared/api";
import { providerDialogClasses as dialogStyles } from "@clawdi/shared/ui";
import {
	providerFieldsFormCopy as copy,
	type ProviderChoice,
	type ProviderGroup,
	providerCredentialLinkLabel,
} from "@clawdi/shared/view";
import { randomUUID } from "expo-crypto";
import { router, useFocusEffect } from "expo-router";
import { Plus } from "lucide-react-native";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { ActionButton, ChoiceSelect } from "@/components/dashboard/controls";
import { Icon } from "@/components/ui/icon";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text as AppText } from "@/components/ui/text";
import { WebView } from "@/components/ui/web-layout";
import { ProviderChooser } from "@/hosted/v2/ai-providers/provider-chooser";
import { ProviderFieldsForm } from "@/hosted/v2/ai-providers/provider-fields-form";
import { ProviderOAuthFlow } from "@/hosted/v2/ai-providers/provider-oauth-flow";
import {
	useProviderInventory,
	useRefreshProviders,
} from "@/hosted/v2/ai-providers/providers-hooks";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useSheet } from "@/platform/navigation/use-sheet";
import { useForegroundLease } from "@/platform/use-foreground-lease";

type AcceptRequest = components["schemas"]["AiProviderAcceptRequest"];
export function ProviderCreate({
	providers,
	renderTrigger,
}: {
	providers: SavedAiProvider[] | undefined;
	renderTrigger?: (open: () => void) => ReactNode;
}) {
	const scope = useAccountScope();
	const open = () => {
		if (scope.isReady && providers) router.push("/ai-providers/new");
	};
	return renderTrigger ? (
		renderTrigger(open)
	) : (
		<ActionButton
			label={copy.add}
			variant="default"
			icon={<Icon as={Plus} />}
			disabled={!providers || !scope.isReady}
			onPress={open}
		/>
	);
}
export function ProviderCreateScreen() {
	const scope = useAccountScope();
	return <ProviderCreateView key={`${scope.accountKey}:${scope.generation}`} />;
}
function ProviderCreateView() {
	const inventory = useProviderInventory();
	const providers = inventory.data?.providers;
	const refresh = useRefreshProviders();
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { aiProviders } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const capture = useForegroundLease();
	const [oauthBusy, setOAuthBusy] = useState(false);
	const sheet = useSheet<boolean>({ fallback: "/ai-providers", busy: action.busy || oauthBusy });
	const [step, setStep] = useState<"choose" | "configure">("choose");
	const [group, setGroup] = useState<ProviderGroup | null>(null);
	const [oauth, setOAuth] = useState(false);
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
		setStep("choose");
		setGroup(null);
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
	const identity = providerFormIdentity({
		type: oauth ? "openai" : type,
		authMethod: oauth ? "oauth" : "api_key",
		labelInput: label,
		existingProviderIds: (providers ?? []).map((provider) => provider.provider_id),
		preset: oauth ? undefined : preset,
	});
	const keyUrl = preset
		? (providerPresetRegion(preset, region)?.api_key_url ??
			preset.api_key_url ??
			PROVIDER_TYPE_META[type].apiKeyUrl)
		: PROVIDER_TYPE_META[type].apiKeyUrl;
	const openKeyHelp = keyUrl
		? () => {
				void action.run(async () => {
					if (capture()()) await Linking.openURL(keyUrl);
				});
			}
		: undefined;
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
			await sheet.close(true);
		});
	const title =
		step === "choose"
			? (group?.label ?? copy.addTitle)
			: `Set up ${identity.label ?? identity.providerId}`;
	return (
		<SheetPage
			title={title}
			scroll={step !== "choose"}
			fallback="/ai-providers"
			busy={action.busy || oauthBusy}
			sheet={sheet}
			actions={
				step === "configure" || group
					? [
							{
								id: "back",
								label: t("navigation.back"),
								disabled: locked || action.busy || oauthBusy,
								onPress: () => {
									if (step === "configure") {
										setStep("choose");
										setSecret("");
									} else setGroup(null);
								},
							},
						]
					: []
			}
		>
			{inventory.isError ? (
				<AppText accessibilityRole="alert">{t("providers.failed")}</AppText>
			) : null}
			{uncertain ? <AppText accessibilityRole="alert">{t("providers.uncertain")}</AppText> : null}
			<WebView
				recipe={dialogStyles.body}
				className={step === "choose" ? "flex-1" : "flex-none"}
				style={
					step === "choose" ? undefined : { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: "auto" }
				}
			>
				{step === "choose" ? (
					<ProviderChooser
						selected={group}
						onGroupChange={setGroup}
						onSelect={(selected: ProviderChoice) => {
							setSecret("");
							setOAuth(selected.kind === "oauth");
							if (selected.kind !== "oauth") {
								const id = selected.kind === "preset" ? selected.preset.id : selected.type;
								setChoice(id);
								setType(selected.kind === "preset" ? selected.preset.provider_type : selected.type);
								setRegion(selected.kind === "preset" ? (selected.regionId ?? null) : null);
							}
							setStep("configure");
						}}
					/>
				) : oauth ? (
					<ProviderFieldsForm
						label={label}
						placeholder={identity.label ?? PROVIDER_TYPE_META.openai.label}
						onLabel={setLabel}
						showRouting={false}
						baseUrl={baseUrl}
						onBaseUrl={setBaseUrl}
						apiMode={apiMode}
						onApiMode={setApiMode}
						secret={secret}
						onSecret={setSecret}
						disabled={locked || action.busy}
						oauth
					/>
				) : (
					<>
						{preset?.region_variants?.length ? (
							<ChoiceSelect
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
						<ProviderFieldsForm
							label={label}
							placeholder={identity.label ?? preset?.label ?? PROVIDER_TYPE_META[type].label}
							onLabel={setLabel}
							showRouting={custom}
							baseUrl={baseUrl}
							onBaseUrl={setBaseUrl}
							apiMode={apiMode}
							onApiMode={setApiMode}
							secret={secret}
							onSecret={setSecret}
							credentialLabel={preset?.credential_label ?? copy.apiKey}
							credentialLinkLabel={providerCredentialLinkLabel(
								preset?.credential_label ?? copy.apiKey,
								preset?.credential_link_label,
							)}
							onCredentialHelp={openKeyHelp}
							disabled={locked || action.busy}
						/>
					</>
				)}
			</WebView>
			{step === "configure" && oauth ? (
				<ProviderOAuthFlow
					dialogFooter
					providers={providers}
					onBusyChange={setOAuthBusy}
					refresh={refresh}
					label={label}
					startLabel={copy.continueChatGpt}
				/>
			) : null}
			{step === "configure" && !oauth ? (
				<WebView recipe={dialogStyles.footer}>
					<ActionButton
						label={locked ? t("providers.retrySame") : copy.add}
						variant="default"
						disabled={
							action.busy ||
							!providers ||
							!secret.trim() ||
							(custom && (!baseUrl.trim() || !label.trim()))
						}
						onPress={() => void submit()}
					/>
				</WebView>
			) : null}
			{action.error ? <AppText accessibilityRole="alert">{t("providers.failed")}</AppText> : null}
		</SheetPage>
	);
}
