import { isClawdiManagedProviderId } from "@clawdi/shared";
import {
	ApiClientError,
	buildHostedAiBindingFields,
	type DeploymentMutation,
	type DeploymentRead,
	type DeploymentUpdate,
	deploymentLifecycleAvailable,
	HOSTED_DEPLOY_LANGUAGE_OPTIONS,
	type HostedDeployOperation,
	hostedAiProviderAvailabilityIssue,
	isValidHostedDeployTimezone,
	normalizeHostedDeployLanguage,
} from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { useRef, useState } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { NativeButton, NativePicker } from "../../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../../ui/primitives";

type Attempt = { key: string; version: string; mutation: DeploymentMutation; uncertain: boolean };

export function DeploymentControls({
	deployment,
	blocked,
	onAccepted,
}: {
	deployment: DeploymentRead;
	blocked: boolean;
	onAccepted: (operation: HostedDeployOperation) => Promise<void>;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { deploymentMutations } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const [attempt, setAttempt] = useState<Attempt | null>(null);
	const [rejected, setRejected] = useState(false);
	const confirmation = useRef(0);
	const state = deployment.resource.status?.summary_state;
	const busy =
		action.busy ||
		blocked ||
		Boolean(attempt) ||
		!scope.isReady ||
		Boolean(deployment.accepted_operation && !deployment.accepted_operation.done);
	const submit = (saved: Attempt) =>
		action.run(async (current) => {
			const visible = capture();
			if (!deploymentMutations || !visible()) return;
			setAttempt({ ...saved, uncertain: true });
			setRejected(false);
			try {
				const operation = await read((signal) =>
					deploymentMutations.apply(
						deployment.resource.id,
						saved.version,
						saved.key,
						saved.mutation,
						signal,
					),
				);
				if (!current()) return;
				setAttempt(null);
				await onAccepted(operation);
			} catch (error) {
				if (
					current() &&
					!saved.uncertain &&
					error instanceof ApiClientError &&
					error.status === 412 &&
					error.code === "resource_version_mismatch"
				)
					setRejected(true);
				throw error;
			}
		});
	const confirm = (mutation: DeploymentMutation) => {
		if (busy || !deploymentMutations) return;
		const visible = capture();
		const saved: Attempt = {
			key: randomUUID(),
			version: deployment.resource.metadata.resourceVersion,
			mutation,
			uncertain: false,
		};
		const ticket = ++confirmation.current;
		Alert.alert(t("runtime.confirm"), t("runtime.warning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("runtime.apply"),
				onPress: () => {
					if (
						confirmation.current === ticket &&
						scope.isCurrent() &&
						!scope.signal.aborted &&
						visible()
					) {
						confirmation.current++;
						void submit(saved);
					}
				},
			},
		]);
	};
	const stable = state === "running" || state === "stopped" || state === "failed";
	return (
		<AppView className="gap-3">
			<AppText accessibilityRole="header" className="text-xl font-semibold text-foreground">
				{t("runtime.title")}
			</AppText>
			<AppText>{t("runtime.warning")}</AppText>
			{attempt ? (
				<>
					<AppText accessibilityRole="alert">
						{t(rejected ? "runtime.conflict" : "runtime.uncertain")}
					</AppText>
					<NativeButton
						label={t("runtime.retry")}
						disabled={action.busy || rejected}
						onPress={() => void submit(attempt)}
					/>
					{rejected ? (
						<NativeButton
							label={t("runtime.review")}
							disabled={action.busy}
							onPress={() => {
								setAttempt(null);
								setRejected(false);
							}}
						/>
					) : null}
				</>
			) : null}
			{action.error ? <AppText accessibilityRole="alert">{t("runtime.failed")}</AppText> : null}
			{deploymentLifecycleAvailable("start", state) && deployment.start_action === "start" ? (
				<NativeButton
					label={t("runtime.start")}
					disabled={busy}
					onPress={() => confirm({ action: "start" })}
				/>
			) : null}
			{state === "stopped" && deployment.start_action !== "start" ? (
				<AppText>{t("runtime.paymentRequired")}</AppText>
			) : null}
			{deploymentLifecycleAvailable("stop", state) ? (
				<NativeButton
					label={t("runtime.stop")}
					disabled={busy}
					onPress={() => confirm({ action: "stop" })}
				/>
			) : null}
			{deploymentLifecycleAvailable("restart", state) ? (
				<NativeButton
					label={t("runtime.restart")}
					disabled={busy}
					onPress={() => confirm({ action: "restart" })}
				/>
			) : null}
			{stable ? (
				<NativeButton
					label={t("runtime.resetAccess")}
					disabled={busy}
					onPress={() => confirm({ action: "reset_runtime_ui_access" })}
				/>
			) : null}
			<LocaleSettings
				key={JSON.stringify([
					deployment.resource.spec.runtime_configuration.language,
					deployment.resource.spec.runtime_configuration.timezone,
				])}
				deployment={deployment}
				disabled={busy || !stable}
				apply={(body) => confirm({ action: "update", body })}
			/>
			<ModelSettings
				key={JSON.stringify([
					deployment.resource.spec.runtime_configuration.providers,
					deployment.resource.spec.runtime_configuration.primary_model,
				])}
				deployment={deployment}
				disabled={busy || !stable}
				apply={(body) => confirm({ action: "update", body })}
			/>
		</AppView>
	);
}

function LocaleSettings({
	deployment,
	disabled,
	apply,
}: {
	deployment: DeploymentRead;
	disabled: boolean;
	apply: (body: DeploymentUpdate) => void;
}) {
	const t = useI18n();
	const config = deployment.resource.spec.runtime_configuration;
	const [language, setLanguage] = useState(config.language ?? "");
	const [timezone, setTimezone] = useState(config.timezone ?? "");
	const valid =
		(!language || normalizeHostedDeployLanguage(language) !== null) &&
		(!timezone.trim() || isValidHostedDeployTimezone(timezone.trim()));
	return (
		<AppView className="gap-3">
			<AppText accessibilityRole="header">{t("runtime.locale")}</AppText>
			<NativePicker
				value={language}
				options={[
					{ value: "", label: t("runtime.default") },
					...HOSTED_DEPLOY_LANGUAGE_OPTIONS.map((item) => ({
						value: item.code,
						label: item.label,
					})),
				]}
				disabled={disabled}
				onValueChange={setLanguage}
			/>
			<AppTextInput
				accessibilityLabel={t("runtime.timezone")}
				placeholder={t("runtime.timezone")}
				value={timezone}
				onChangeText={setTimezone}
				autoCapitalize="none"
				autoCorrect={false}
				maxLength={100}
				editable={!disabled}
				className="rounded-xl bg-surface p-3 text-foreground"
			/>
			{!valid ? <AppText>{t("runtime.invalidLocale")}</AppText> : null}
			<NativeButton
				label={t("runtime.saveLocale")}
				disabled={
					disabled ||
					!valid ||
					(language === (config.language ?? "") && timezone === (config.timezone ?? ""))
				}
				onPress={() =>
					apply({
						language: normalizeHostedDeployLanguage(language),
						timezone: timezone.trim() || null,
					})
				}
			/>
		</AppView>
	);
}

function ModelSettings({
	deployment,
	disabled,
	apply,
}: {
	deployment: DeploymentRead;
	disabled: boolean;
	apply: (body: DeploymentUpdate) => void;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { aiProviders, compute } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const [choice, setChoice] = useState("");
	const [model, setModel] = useState("");
	const config = deployment.resource.spec.runtime_configuration;
	const catalog = useQuery({
		queryKey: accountQueryKey(scope, "runtime-model-catalog"),
		queryFn: ({ signal }) =>
			read(async (lease) => {
				if (!compute) throw new Error("Compute unavailable");
				const [providers, managed] = await Promise.all([
					aiProviders.list(lease),
					compute.getManagedModels(lease),
				]);
				return { providers: providers.providers, managed: managed.models };
			}, signal),
		enabled: scope.isReady && Boolean(compute),
		retry: false,
	});
	const currentIds = config.providers.map((provider) => provider.provider_id);
	const available = (catalog.data?.providers ?? []).filter(
		(provider) =>
			!isClawdiManagedProviderId(provider.provider_id) &&
			provider.readiness?.deployable &&
			hostedAiProviderAvailabilityIssue(provider, {
				runtime: deployment.resource.spec.runtime,
				environmentId: deployment.agent_id ?? null,
				currentProviderIds: currentIds,
			}) === null,
	);
	const selected = available.find((provider) => provider.provider_id === choice);
	const agentOwnsModels =
		selected &&
		["native", "custom", "connection"].includes(selected.configuration_mode ?? "catalog");
	const options = [
		{ value: "", label: t("runtime.chooseProvider") },
		{ value: "__unmanaged__", label: t("runtime.unmanaged") },
		{ value: "__managed__", label: "Clawdi AI" },
		...available.map((provider) => ({
			value: provider.provider_id,
			label: provider.label || provider.provider_id,
		})),
	];
	return (
		<AppView className="gap-3">
			<AppText accessibilityRole="header">{t("runtime.model")}</AppText>
			<AppText selectable>
				{currentIds.join(", ") || t("runtime.unmanaged")} · {config.primary_model?.model ?? ""}
			</AppText>
			{deployment.provider_conflicts?.length ? (
				<AppText accessibilityRole="alert">{t("runtime.providerConflict")}</AppText>
			) : null}
			<NativeButton
				label={t("runtime.refreshProviders")}
				disabled={catalog.isFetching || action.busy}
				onPress={() => void catalog.refetch()}
			/>
			<NativePicker
				value={choice}
				options={options}
				disabled={disabled || catalog.isPending || catalog.isError}
				onValueChange={(value) => {
					setChoice(value);
					setModel("");
				}}
			/>
			{choice === "__managed__" ? (
				<NativePicker
					value={model}
					options={[
						{ value: "", label: t("runtime.chooseModel") },
						...(catalog.data?.managed ?? []).map((item) => ({
							value: item.id,
							label: item.display_name || item.id,
						})),
					]}
					disabled={disabled}
					onValueChange={setModel}
				/>
			) : selected && !agentOwnsModels ? (
				<AppTextInput
					accessibilityLabel={t("runtime.modelId")}
					placeholder={t("runtime.modelId")}
					value={model}
					onChangeText={setModel}
					maxLength={200}
					editable={!disabled}
					autoCapitalize="none"
					autoCorrect={false}
					className="rounded-xl bg-surface p-3 text-foreground"
				/>
			) : agentOwnsModels ? (
				<AppText>{t("runtime.modelsInAgent")}</AppText>
			) : null}
			{choice === "__unmanaged__" ? <AppText>{t("runtime.unmanagedWarning")}</AppText> : null}
			<NativeButton
				label={t("runtime.saveModel")}
				disabled={
					disabled ||
					action.busy ||
					!catalog.data ||
					catalog.isError ||
					!choice ||
					(choice === "__managed__" && !model) ||
					(Boolean(selected) && !agentOwnsModels && !model)
				}
				onPress={() =>
					void action.run(async () => {
						if (!catalog.data) return;
						if (choice !== "__managed__" && choice !== "__unmanaged__" && !selected)
							throw new Error("Provider unavailable");
						apply(
							buildHostedAiBindingFields({
								mode: "update",
								providers: catalog.data.providers,
								managedModels: catalog.data.managed,
								currentProviderIds: currentIds,
								selection:
									choice === "__unmanaged__"
										? { mode: "unmanaged" }
										: choice === "__managed__"
											? { mode: "managed", model }
											: { mode: "saved", providerId: choice, model },
							}),
						);
					})
				}
			/>
			{action.error || catalog.isError ? (
				<AppText accessibilityRole="alert">{t("runtime.failed")}</AppText>
			) : null}
		</AppView>
	);
}
