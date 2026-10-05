import { nativeAiProvider } from "@clawdi/shared";
import {
	type ApiMode,
	type components,
	customProviderRuntimeEnv,
	PROVIDER_TYPE_META,
	type ProviderTypeId,
	providerFormIdentity,
	providerPresetById,
	type SavedAiProvider,
} from "@clawdi/shared/api";
import {
	providerFieldsFormCopy as copy,
	type ProviderChoice,
	type ProviderGroup,
} from "@clawdi/shared/view";
import { randomUUID } from "expo-crypto";
import { useFocusEffect } from "expo-router";
import { ArrowLeft, Plus } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { ActionButton, ChoiceSelect } from "../ui/agents/controls";
import { ProviderChooser } from "../ui/agents/provider-chooser";
import { ProviderFieldsForm } from "../ui/agents/provider-fields-form";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { AppText, AppView } from "../ui/primitives";
import { ProviderOAuth } from "./provider-oauth";

type AcceptRequest = components["schemas"]["AiProviderAcceptRequest"];
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
				<ActionButton
					label={copy.add}
					variant="default"
					icon={<Icon as={Plus} />}
					disabled={action.busy || !providers || !scope.isReady}
					onPress={() => {
						action.clearError();
						setStep("choose");
						setGroup(null);
						setOAuth(false);
						setOpen(true);
					}}
				/>
			) : (
				<Dialog
					open={open}
					onOpenChange={(next) => {
						if (!next && !action.busy) clearSensitive();
					}}
				>
					<DialogContent>
						<DialogHeader>
							{step === "configure" || group ? (
								<ActionButton
									label="Back"
									icon={<Icon as={ArrowLeft} />}
									variant="ghost"
									disabled={locked || action.busy}
									onPress={() => {
										if (step === "configure") {
											setStep("choose");
											setSecret("");
										} else setGroup(null);
									}}
								/>
							) : null}
							<DialogTitle>
								{step === "choose"
									? (group?.label ?? copy.addTitle)
									: oauth
										? "Sign in with ChatGPT"
										: `Set up ${preset?.label ?? PROVIDER_TYPE_META[type].label}`}
							</DialogTitle>
						</DialogHeader>
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
										setType(
											selected.kind === "preset" ? selected.preset.provider_type : selected.type,
										);
										setRegion(selected.kind === "preset" ? (selected.regionId ?? null) : null);
									}
									setStep("configure");
								}}
							/>
						) : oauth ? (
							<ProviderOAuth providers={providers} refresh={refresh} />
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
									placeholder={preset?.label ?? PROVIDER_TYPE_META[type].label}
									onLabel={setLabel}
									showRouting={custom}
									baseUrl={baseUrl}
									onBaseUrl={setBaseUrl}
									apiMode={apiMode}
									onApiMode={setApiMode}
									secret={secret}
									onSecret={setSecret}
									credentialLabel={preset?.credential_label ?? copy.apiKey}
									disabled={locked || action.busy}
								/>
								<DialogFooter>
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
									<ActionButton
										label={t("account.cancel")}
										disabled={action.busy}
										onPress={clearSensitive}
									/>
								</DialogFooter>
							</>
						)}
						{action.error ? (
							<AppText accessibilityRole="alert">{t("providers.failed")}</AppText>
						) : null}
					</DialogContent>
				</Dialog>
			)}
			{action.error ? <AppText accessibilityRole="alert">{t("providers.failed")}</AppText> : null}
		</AppView>
	);
}
