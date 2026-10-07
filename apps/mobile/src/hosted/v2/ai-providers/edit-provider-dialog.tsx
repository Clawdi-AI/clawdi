import { nativeAiProvider } from "@clawdi/shared";
import {
	type ApiMode,
	authFor,
	derivedProviderFields,
	PROVIDER_TYPE_META,
	providerEditOperation,
	providerPresetById,
	providerPresetForSavedProvider,
	providerPresetRegion,
	type SavedAiProvider,
} from "@clawdi/shared/api";
import { providerDialogClasses as dialogStyles } from "@clawdi/shared/ui";
import {
	providerFieldsFormCopy as copy,
	providerCredentialLinkLabel,
	providerPresentation,
} from "@clawdi/shared/view";
import { randomUUID } from "expo-crypto";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Pencil, RefreshCw } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { ActionButton, ChoiceSelect } from "@/components/dashboard/controls";
import { ResourceError } from "@/components/resource-error";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { Icon } from "@/components/ui/icon";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text as AppText } from "@/components/ui/text";
import { WebView } from "@/components/ui/web-layout";
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

export function ProviderEdit({ provider }: { provider: SavedAiProvider }) {
	const scope = useAccountScope();
	return (
		<ActionButton
			label={copy.edit}
			icon={<Icon as={Pencil} />}
			disabled={!scope.isReady}
			onPress={() =>
				router.push({
					pathname: "/ai-providers/[providerId]/edit",
					params: { providerId: provider.provider_id },
				})
			}
		/>
	);
}
export function ProviderEditScreen() {
	const { providerId } = useLocalSearchParams<{ providerId: string }>();
	const scope = useAccountScope();
	const inventory = useProviderInventory();
	const refresh = useRefreshProviders();
	const provider = inventory.isError
		? undefined
		: inventory.data?.providers.find((item) => item.provider_id === providerId);
	if (!provider)
		return (
			<SheetPage title={copy.edit} fallback="/ai-providers">
				{inventory.isPending ? (
					<RouteLoadingSkeleton />
				) : inventory.isError ? (
					<ApiErrorPanel error={inventory.error} onRetry={() => void inventory.refetch()} />
				) : (
					<ResourceError missing />
				)}
			</SheetPage>
		);
	return (
		<ProviderEditForm
			key={`${scope.accountKey}:${scope.generation}:${providerId}`}
			provider={provider}
			refresh={refresh}
		/>
	);
}
function ProviderEditForm({
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
	const [oauthBusy, setOAuthBusy] = useState(false);
	const sheet = useSheet<boolean>({ fallback: "/ai-providers", busy: action.busy || oauthBusy });
	const oauth = provider.auth.type === "agent_profile" || provider.auth.type === "oauth_profile";
	const preset =
		providerPresetById(provider.native_provider) ??
		providerPresetForSavedProvider({ baseUrl: provider.base_url });
	const defaults = derivedProviderFields(provider.type, oauth ? "oauth" : "api_key", preset);
	const [label, setLabel] = useState(provider.label ?? "");
	const [baseUrl, setBaseUrl] = useState(provider.base_url);
	const [apiMode, setApiMode] = useState<ApiMode>(provider.api_mode ?? defaults.apiMode);
	const [region, setRegion] = useState(provider.native_variant ?? null);
	const [secret, setSecret] = useState("");
	const keyUrl = preset
		? (providerPresetRegion(preset, region)?.api_key_url ??
			preset.api_key_url ??
			PROVIDER_TYPE_META[provider.type].apiKeyUrl)
		: PROVIDER_TYPE_META[provider.type].apiKeyUrl;
	const openKeyHelp = keyUrl
		? () => {
				void action.run(async () => {
					if (capture()()) await Linking.openURL(keyUrl);
				});
			}
		: undefined;
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
			await sheet.close(true);
		});
	return (
		<SheetPage
			title={t("labels.editProvider", { name: providerPresentation(provider).label })}
			fallback="/ai-providers"
			busy={action.busy || oauthBusy}
			sheet={sheet}
		>
			{uncertain ? <AppText accessibilityRole="alert">{t("providers.uncertain")}</AppText> : null}
			<WebView
				recipe={dialogStyles.body}
				className="flex-none"
				style={{ flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: "auto" }}
			>
				{!oauth && native && preset?.region_variants?.length ? (
					<ChoiceSelect
						value={region ?? preset.region_variants[0]?.id ?? ""}
						options={preset.region_variants.map((variant) => ({
							value: variant.id,
							label: variant.label,
						}))}
						disabled={locked || action.busy}
						onValueChange={setRegion}
					/>
				) : null}
				<ProviderFieldsForm
					label={label}
					placeholder={providerPresentation(provider).label}
					onLabel={setLabel}
					showRouting={!oauth && !native}
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
					oauthContent={
						oauth ? (
							<ProviderOAuthFlow
								provider={provider}
								onBusyChange={setOAuthBusy}
								refresh={refresh}
								startLabel={copy.reconnect}
								startIcon={<Icon as={RefreshCw} />}
							/>
						) : undefined
					}
					credentialPlaceholder={
						provider.auth.type === "none" ? copy.apiKeyPlaceholder : copy.keepCredential
					}
					disabled={locked || action.busy}
					oauth={oauth}
				/>
			</WebView>
			<WebView recipe={dialogStyles.footer}>
				<ActionButton
					label={t("account.cancel")}
					disabled={action.busy}
					onPress={() =>
						void action.run(async () => {
							await sheet.close();
							clear();
						})
					}
				/>
				<ActionButton
					label={locked ? t("providers.retrySame") : copy.save}
					variant="default"
					disabled={action.busy || !scope.isReady || !baseUrl.trim()}
					onPress={() => void save()}
				/>
			</WebView>
			{action.error ? <AppText accessibilityRole="alert">{t("providers.failed")}</AppText> : null}
		</SheetPage>
	);
}
