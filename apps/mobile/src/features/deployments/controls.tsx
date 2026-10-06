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
import {
	agentSurfaceCopy,
	aiBindingCopy,
	firstModelForProvider,
	isManagedProviderId,
	primaryModelValue,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { AiBindingChoices } from "../../ui/agents/ai-binding-choices";
import {
	ActionButton as NativeButton,
	ChoiceSelect as NativePicker,
} from "../../ui/agents/controls";
import { EntityAddCard } from "../../ui/entity-card";
import { Input as AppTextInput } from "../../ui/input";
import { AppText, AppView } from "../../ui/primitives";
import { ProviderCreate } from "../provider-create";
import type { RuntimeAttempt } from "./attempt";
import { runtimeAttempts } from "./attempt-storage";

export function DeploymentControls({
	deployment,
	deploymentId,
	blocked,
	transitioning,
	onAccepted,
	onAbsent,
	section = "all",
}: {
	deployment: DeploymentRead | undefined;
	deploymentId: string;
	blocked: boolean;
	transitioning: boolean;
	onAccepted: (operation: HostedDeployOperation) => Promise<void>;
	onAbsent: () => Promise<void>;
	section?: "all" | "ai";
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { deploymentMutations } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const [attempt, setAttempt] = useState<RuntimeAttempt | null>(null);
	const [storageKey, setStorageKey] = useState<string | null>(null);
	const [storageError, setStorageError] = useState(false);
	const [restoreEpoch, setRestoreEpoch] = useState(0);
	const rejected = attempt?.status === "rejected";
	useEffect(() => {
		let mounted = true;
		const current = () => mounted && scope.isCurrent() && !scope.signal.aborted;
		setStorageKey(null);
		setStorageError(false);
		void (async () => {
			if (!scope.accountKey || !scope.isReady) return;
			try {
				const digest = await digestStringAsync(
					CryptoDigestAlgorithm.SHA256,
					JSON.stringify([scope.accountKey, deploymentId]),
				);
				if (!current()) return;
				const key = `clawdi.runtime.v1.${digest}`;
				const saved = await runtimeAttempts.readSavedAttempt(key);
				if (!current()) return;
				if (saved && saved.deploymentId !== deploymentId) throw new Error("Wrong runtime journal");
				setAttempt(saved);
				setStorageKey(key);
			} catch {
				if (current()) setStorageError(true);
			}
		})();
		return () => {
			mounted = false;
		};
	}, [scope, deploymentId, restoreEpoch]);
	const confirmation = useRef(0);
	const state = deployment?.resource.status?.summary_state;
	const writeBlocked =
		action.busy ||
		blocked ||
		Boolean(attempt) ||
		!scope.isReady ||
		!deployment ||
		deployment.resource.id !== deploymentId ||
		deployment.resource.spec.desired_lifecycle === "deleted" ||
		!storageKey ||
		storageError;
	const busy =
		writeBlocked ||
		transitioning ||
		Boolean(deployment?.accepted_operation && !deployment.accepted_operation.done);
	const submit = (saved: RuntimeAttempt, fresh = false) =>
		action.run(async (current) => {
			const visible = capture();
			const owns = () => current() && scope.isCurrent() && !scope.signal.aborted;
			if (!deploymentMutations || !storageKey || !visible() || saved.status === "rejected") return;
			if (fresh) await runtimeAttempts.saveAttempt(storageKey, saved, owns);
			if (!owns()) return;
			setAttempt(saved);
			const submitting: RuntimeAttempt = { ...saved, status: "uncertain" };
			await runtimeAttempts.replaceAttempt(
				storageKey,
				saved,
				submitting,
				() => owns() && visible(),
			);
			if (!owns()) return;
			setAttempt(submitting);
			if (!visible()) return;
			try {
				const operation = await read((signal) =>
					deploymentMutations.apply(
						saved.deploymentId,
						saved.version,
						saved.key,
						saved.mutation,
						signal,
					),
				);
				if (!owns()) return;
				await runtimeAttempts.clearAttempt(storageKey, submitting, owns);
				if (!owns()) return;
				setAttempt(null);
				if ("status" in operation) await onAbsent();
				else await onAccepted(operation);
			} catch (error) {
				if (
					owns() &&
					saved.status === "prepared" &&
					error instanceof ApiClientError &&
					error.status === 412 &&
					error.code === "resource_version_mismatch"
				) {
					const refused: RuntimeAttempt = { ...saved, status: "rejected" };
					await runtimeAttempts.replaceAttempt(storageKey, submitting, refused, owns);
					if (owns()) setAttempt(refused);
				}
				throw error;
			}
		});
	const confirm = (mutation: DeploymentMutation) => {
		if ((mutation.action === "delete" ? writeBlocked : busy) || !deploymentMutations || !deployment)
			return;
		const visible = capture();
		const saved: RuntimeAttempt = {
			format: 1,
			deploymentId: deployment.resource.id,
			key: randomUUID(),
			version: deployment.resource.metadata.resourceVersion,
			mutation,
			status: "prepared",
		};
		const ticket = ++confirmation.current;
		Alert.alert(
			t(mutation.action === "delete" ? "runtime.deleteAgent" : "runtime.confirm"),
			mutation.action === "delete"
				? `${deployment.resource.name}\n\n${t("runtime.deleteWarning")}`
				: t("runtime.warning"),
			[
				{ text: t("account.cancel"), style: "cancel" },
				{
					text: t(mutation.action === "delete" ? "runtime.deleteAgent" : "runtime.apply"),
					style: mutation.action === "delete" ? "destructive" : "default",
					onPress: () => {
						if (
							confirmation.current === ticket &&
							scope.isCurrent() &&
							!scope.signal.aborted &&
							visible()
						) {
							confirmation.current++;
							void submit(saved, true);
						}
					},
				},
			],
		);
	};
	const stable = state === "running" || state === "stopped" || state === "failed";
	return (
		<AppView className="gap-3">
			{section !== "ai" ? (
				<>
					<AppText accessibilityRole="header" className="text-xl font-semibold text-foreground">
						{t("runtime.title")}
					</AppText>
					<AppText>{t("runtime.warning")}</AppText>
				</>
			) : null}
			{storageError ? (
				<AppText accessibilityRole="alert">{t("runtime.storageError")}</AppText>
			) : null}
			{section !== "ai" || attempt || storageError ? (
				<NativeButton
					label={t("runtime.reloadAttempt")}
					disabled={action.busy}
					onPress={() => setRestoreEpoch((value) => value + 1)}
				/>
			) : null}
			{attempt ? (
				<>
					<AppText accessibilityRole="alert">
						{t(
							rejected
								? "runtime.conflict"
								: attempt.status === "prepared"
									? "runtime.prepared"
									: "runtime.uncertain",
						)}
					</AppText>
					<NativeButton
						label={t("runtime.retry")}
						disabled={action.busy || rejected || !storageKey || storageError}
						onPress={() => void submit(attempt)}
					/>
					{attempt.status !== "uncertain" ? (
						<NativeButton
							label={t("runtime.review")}
							disabled={action.busy || !storageKey || storageError}
							onPress={() =>
								void action.run(async (current) => {
									if (!storageKey) return;
									await runtimeAttempts.clearAttempt(
										storageKey,
										attempt,
										() => current() && scope.isCurrent() && !scope.signal.aborted,
									);
									if (current()) setAttempt(null);
								})
							}
						/>
					) : null}
				</>
			) : null}
			{action.error ? <AppText accessibilityRole="alert">{t("runtime.failed")}</AppText> : null}
			{section !== "ai" &&
			deploymentLifecycleAvailable("start", state) &&
			deployment?.start_action === "start" ? (
				<NativeButton
					label={t("runtime.start")}
					disabled={busy}
					onPress={() => confirm({ action: "start" })}
				/>
			) : null}
			{section !== "ai" && state === "stopped" && deployment?.start_action !== "start" ? (
				<AppText>{t("runtime.paymentRequired")}</AppText>
			) : null}
			{section !== "ai" && deploymentLifecycleAvailable("stop", state) ? (
				<NativeButton
					label={t("runtime.stop")}
					disabled={busy}
					onPress={() => confirm({ action: "stop" })}
				/>
			) : null}
			{section !== "ai" && deploymentLifecycleAvailable("restart", state) ? (
				<NativeButton
					label={t("runtime.restart")}
					disabled={busy}
					onPress={() => confirm({ action: "restart" })}
				/>
			) : null}
			{section !== "ai" && stable ? (
				<NativeButton
					label={t("runtime.resetAccess")}
					disabled={busy}
					onPress={() => confirm({ action: "reset_runtime_ui_access" })}
				/>
			) : null}
			{section !== "ai" && deploymentLifecycleAvailable("delete", state) ? (
				<NativeButton
					label={t("runtime.deleteAgent")}
					disabled={writeBlocked}
					onPress={() =>
						confirm({ action: "delete", body: { subscription_choice: "keep_subscription" } })
					}
				/>
			) : null}
			{attempt?.mutation.action === "delete" ? (
				<AppText accessibilityRole="alert">{t("runtime.deleteWarning")}</AppText>
			) : null}
			{deployment ? (
				<>
					{section !== "ai" ? (
						<LocaleSettings
							key={JSON.stringify([
								deployment.resource.spec.runtime_configuration.language,
								deployment.resource.spec.runtime_configuration.timezone,
							])}
							deployment={deployment}
							disabled={busy || !stable}
							apply={(body) => confirm({ action: "update", body })}
						/>
					) : null}
					<ModelSettings
						key={JSON.stringify([
							deployment.resource.spec.runtime_configuration.providers,
							deployment.resource.spec.runtime_configuration.primary_model,
						])}
						deployment={deployment}
						disabled={busy || !stable}
						apply={(body) => confirm({ action: "update", body })}
					/>
				</>
			) : null}
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
	const router = useRouter();
	const config = deployment.resource.spec.runtime_configuration;
	const initialProvider = config.primary_model?.provider_id ?? config.providers[0]?.provider_id;
	const initialChoice = !initialProvider
		? "__unmanaged__"
		: isManagedProviderId(initialProvider)
			? "__managed__"
			: initialProvider;
	const initialModel = primaryModelValue(config.primary_model);
	const [choice, setChoice] = useState(initialChoice);
	const [model, setModel] = useState(initialModel);
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
	return (
		<AppView className="gap-3">
			{deployment.provider_conflicts?.length ? (
				<AppText accessibilityRole="alert">{t("runtime.providerConflict")}</AppText>
			) : null}
			<AiBindingChoices
				providers={catalog.data?.providers ?? []}
				models={catalog.data?.managed ?? []}
				choice={choice}
				model={model}
				disabled={disabled || catalog.isPending || catalog.isError}
				runtime={deployment.resource.spec.runtime}
				agentId={deployment.agent_id}
				currentIds={currentIds}
				onChoice={(next) => {
					setChoice(next);
					setModel(
						firstModelForProvider(next, catalog.data?.providers ?? [], catalog.data?.managed ?? []),
					);
				}}
				onModel={setModel}
				onAdd={() => router.push("/ai-providers")}
				addProvider={
					<ProviderCreate
						providers={catalog.data?.providers}
						refresh={async () => {
							const result = await catalog.refetch();
							if (result.isError) throw new Error("Provider inventory unavailable");
						}}
						renderTrigger={(open) => (
							<EntityAddCard
								title={aiBindingCopy.addProvider}
								description={aiBindingCopy.addProviderDescription}
								onClick={open}
							/>
						)}
					/>
				}
				onRetry={() => void catalog.refetch()}
				error={catalog.error}
			/>
			{selected && !agentOwnsModels ? (
				<AppTextInput
					accessibilityLabel={t("runtime.modelId")}
					placeholder={t("runtime.modelId")}
					value={model}
					onChangeText={setModel}
					maxLength={200}
					editable={!disabled}
					autoCapitalize="none"
					autoCorrect={false}
				/>
			) : agentOwnsModels ? (
				<AppText>{t("runtime.modelsInAgent")}</AppText>
			) : null}
			{choice === "__unmanaged__" ? <AppText>{t("runtime.unmanagedWarning")}</AppText> : null}
			<NativeButton
				label={aiBindingCopy.save}
				variant="default"
				className="self-start"
				disabled={
					disabled ||
					(choice === initialChoice && model === initialModel) ||
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
							throw new Error(agentSurfaceCopy.providerUnavailable);
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
