import { isClawdiManagedProviderId } from "@clawdi/shared";
import {
	buildHostedAiBindingFields,
	type DeploymentMutation,
	type DeploymentRead,
	type DeploymentUpdate,
	deploymentLifecycleAvailable,
	HOSTED_DEPLOY_LANGUAGE_OPTIONS,
	type HostedDeployOperation,
	hostedAiProviderAvailabilityIssue,
	normalizeHostedDeployLanguage,
} from "@clawdi/shared/api";
import { hostedAgentSettingsClasses as styles } from "@clawdi/shared/ui";
import {
	agentSettingsCopy,
	agentSurfaceCopy,
	aiBindingCopy,
	computeFundingMode,
	deploymentDeleteCopy,
	deploymentDeleteSubscriptionPolicy,
	deploymentLifecycleConfirmCopy,
	deploymentPrimaryLifecycleAction,
	deploymentStatusFromResource,
	firstModelForProvider,
	formatShortDate,
	initialDeploymentCopy,
	isManagedProviderId,
	MANAGED_AI_CHOICE,
	mergeTimezoneOptions,
	primaryModelValue,
	supportedTimezones,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { useRouter } from "expo-router";
import Info from "lucide-react-native/icons/info";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import Trash2 from "lucide-react-native/icons/trash";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActionButton, ChoiceSelect as NativePicker } from "@/components/dashboard/controls";
import { EntityAddCard } from "@/components/entity-card";
import { SettingsSection } from "@/components/settings-section";
import { RichConfirmAction } from "@/components/ui/confirm-action";
import { Icon } from "@/components/ui/icon";
import { Input as AppTextInput, Label } from "@/components/ui/input";
import { Text as AppText } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { AppView } from "@/components/ui/view";
import { WebIcon, WebText, WebView } from "@/components/ui/web-layout";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { hostedAgentTitle } from "@/hosted/agent-title";
import { TimezoneCombobox } from "@/hosted/billing/deploy/language-timezone-controls";
import { ProviderCreate } from "@/hosted/v2/ai-providers/add-provider-dialog";
import { AiBindingChoices } from "@/hosted/v2/ai-providers/ai-binding-choices";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { NativeSegments } from "@/platform/navigation/segmented-control";
import { type RuntimeAttempt, runtimeAttemptAfterFailure } from "@/platform/runtime-attempt";
import { runtimeAttempts } from "@/platform/runtime-attempt-storage";
import { useForegroundLease } from "@/platform/use-foreground-lease";

type SubscriptionChoice = Extract<
	DeploymentMutation,
	{ action: "delete" }
>["body"]["subscription_choice"];

export function DeploymentControls({
	deployment,
	deploymentId,
	blocked,
	transitioning,
	onAccepted,
	onAbsent,
	section = "settings",
	onBusyChange,
	startLabel,
	statusDetails,
	computePlan,
	startFallback,
}: {
	deployment: DeploymentRead | undefined;
	deploymentId: string;
	blocked: boolean;
	transitioning: boolean;
	onAccepted: (operation: HostedDeployOperation) => Promise<void>;
	onAbsent: () => Promise<void>;
	/** `settings` is Web's Settings tab: language, compute plan, agent controls, danger zone. */
	section?: "settings" | "ai" | "startup";
	onBusyChange?: (busy: boolean) => void;
	startLabel?: string;
	/** Status shown at the top of Agent controls, like Web's ComputeStatusDetails. */
	statusDetails?: ReactNode;
	/** Web's Compute plan section, between language and agent controls. */
	computePlan?: ReactNode;
	/** Settings' Start slot when starting needs a subscription or funds first. */
	startFallback?: ReactNode;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { deploymentMutations } = useMobileApi();
	const agent = useCloudAgent(deployment?.agent_id ?? undefined);
	const cache = useQueryClient();
	const action = useAuthAction(scope.identity);
	useEffect(() => {
		onBusyChange?.(action.busy);
		return () => onBusyChange?.(false);
	}, [action.busy, onBusyChange]);
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
	const nativeConfirmation = useConfirmation();
	const status = deploymentStatusFromResource(deployment?.resource.status ?? null);
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
	const refreshDeployment = () =>
		Promise.all([
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "deployment", deploymentId) }),
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "deployments") }),
		]);
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
				const settled = runtimeAttemptAfterFailure(saved, error);
				if (!owns() || settled.status !== "rejected") throw error;
				// The conflict copy explains a rejected replay; no generic failure is shown.
				await runtimeAttempts.replaceAttempt(storageKey, submitting, settled, owns);
				if (!owns()) return;
				setAttempt(settled);
				await refreshDeployment();
			}
		});
	const discard = (saved: RuntimeAttempt) =>
		action.run(async (current) => {
			if (!storageKey) return;
			const owns = () => current() && scope.isCurrent() && !scope.signal.aborted;
			await runtimeAttempts.clearAttempt(storageKey, saved, owns);
			if (!owns()) return;
			setAttempt(null);
			await refreshDeployment();
		});
	const confirmDiscard = (saved: RuntimeAttempt) => {
		if (saved.status !== "uncertain") {
			void discard(saved);
			return;
		}
		const visible = capture();
		nativeConfirmation.show(
			t("runtime.discardUncertainTitle"),
			t("runtime.discardUncertainWarning"),
			[
				{ text: t("account.cancel"), style: "cancel" },
				{
					text: t("runtime.review"),
					style: "destructive",
					onPress: () => {
						if (scope.isCurrent() && !scope.signal.aborted && visible()) return discard(saved);
					},
				},
			],
		);
	};
	const subscription = deployment?.commercial_display?.compute_subscription;
	const fundingMode = computeFundingMode(deployment?.current_plan_slug, subscription);
	const { offerChoice, defaultChoice, storeNotice } =
		deploymentDeleteSubscriptionPolicy(deployment);
	const periodEnd = formatShortDate(subscription?.current_period_end);
	const [deleteChoice, setDeleteChoice] = useState<{
		choice: SubscriptionChoice;
		confirm: (choice: SubscriptionChoice) => unknown;
	} | null>(null);
	const deleteCopy = deploymentDeleteCopy({
		name: (deployment && hostedAgentTitle(agent.data, deployment)) ?? "",
		choice: deleteChoice?.choice ?? "cancel_subscription",
		offerChoice,
		storeNotice,
		cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
		isTrial: subscription?.status === "trialing",
		periodEndLabel: periodEnd === "—" ? null : periodEnd,
	});
	const request = (mutation: DeploymentMutation) => {
		if ((mutation.action === "delete" ? writeBlocked : busy) || !deploymentMutations || !deployment)
			return;
		const visible = capture();
		const prepared = (next: DeploymentMutation): RuntimeAttempt => ({
			format: 1,
			deploymentId: deployment.resource.id,
			key: randomUUID(),
			version: deployment.resource.metadata.resourceVersion,
			mutation: next,
			status: "prepared",
		});
		const ticket = ++confirmation.current;
		const run = (next: DeploymentMutation) => {
			if (
				confirmation.current === ticket &&
				scope.isCurrent() &&
				!scope.signal.aborted &&
				visible()
			) {
				// Failures close the confirmation: the journaled attempt and its Retry/Discard
				// controls drive recovery instead of a second, conflicting confirm.
				return submit(prepared(next), true);
			}
		};
		if (mutation.action === "delete" && offerChoice) {
			setDeleteChoice({
				choice: "cancel_subscription",
				confirm: (subscription_choice) => run({ action: "delete", body: { subscription_choice } }),
			});
			return;
		}
		if (mutation.action === "delete") {
			nativeConfirmation.show(
				deleteCopy.title,
				deleteCopy.notice ? `${deleteCopy.warning}\n\n${deleteCopy.notice}` : deleteCopy.warning,
				[
					{ text: deleteCopy.dismissLabel, style: "cancel" },
					{ text: deleteCopy.confirmLabel, style: "destructive", onPress: () => run(mutation) },
				],
			);
			return;
		}
		// Like Web, only Restart and Stop confirm; Start and settings changes apply directly.
		if (mutation.action !== "restart" && mutation.action !== "stop") {
			void run(mutation);
			return;
		}
		const lifecycle = deploymentLifecycleConfirmCopy[mutation.action];
		nativeConfirmation.show(lifecycle.title, lifecycle.description, [
			{ text: t("account.cancel"), style: "cancel" },
			{ text: lifecycle.confirmLabel, style: "default", onPress: () => run(mutation) },
		]);
	};
	const canStart = deploymentLifecycleAvailable("start", status.kind);
	const startButton = (label: string) => (
		<ActionButton
			label={label}
			icon={section === "settings" ? <Icon as={RefreshCw} /> : undefined}
			disabled={busy || !canStart}
			onPress={() => request({ action: "start" })}
		/>
	);
	const journal = (
		<>
			{storageError ? (
				<AppText accessibilityRole="alert">{t("runtime.storageError")}</AppText>
			) : null}
			{attempt ? (
				<AppText accessibilityRole="alert">
					{t(
						rejected
							? "runtime.conflict"
							: attempt.status === "prepared"
								? "runtime.prepared"
								: "runtime.uncertain",
					)}
				</AppText>
			) : null}
			{action.error ? <AppText accessibilityRole="alert">{t("runtime.failed")}</AppText> : null}
			{/* Recovery controls exist only while a saved change or its storage error does. */}
			{attempt || storageError ? (
				<AppView className="flex-row flex-wrap gap-2.5">
					<ActionButton
						label={t("runtime.reloadAttempt")}
						disabled={action.busy}
						onPress={() => setRestoreEpoch((value) => value + 1)}
					/>
					{attempt ? (
						<ActionButton
							label={t("runtime.retry")}
							disabled={action.busy || rejected || !storageKey || storageError}
							onPress={() => void submit(attempt)}
						/>
					) : null}
					{/* An uncertain delete may carry a subscription cancel; it settles only by replay. */}
					{attempt && (attempt.status !== "uncertain" || attempt.mutation.action !== "delete") ? (
						<ActionButton
							label={t("runtime.review")}
							disabled={action.busy || !storageKey || storageError}
							onPress={() => confirmDiscard(attempt)}
						/>
					) : null}
				</AppView>
			) : null}
		</>
	);
	const primary = deploymentPrimaryLifecycleAction(status);
	const stable = status.kind === "running" || status.kind === "stopped" || status.kind === "failed";
	return (
		<AppView className="gap-3">
			{nativeConfirmation.dialog}
			{section === "settings" && deployment ? (
				<RichConfirmAction
					open={deleteChoice !== null}
					onOpenChange={(open) => {
						if (!open) {
							confirmation.current++;
							setDeleteChoice(null);
						}
					}}
					title={deleteCopy.title}
					description={
						<AppView className="gap-3">
							<AppText>{deleteCopy.warning}</AppText>
							<NativeSegments
								value={deleteChoice?.choice ?? "cancel_subscription"}
								disabled={action.busy}
								options={[
									{ value: "keep_subscription", label: t("runtime.deleteKeepChoice") },
									{ value: "cancel_subscription", label: t("runtime.deleteCancelChoice") },
								]}
								onChange={(value) => {
									if (value === "keep_subscription" || value === "cancel_subscription")
										setDeleteChoice((current) => current && { ...current, choice: value });
								}}
							/>
							<AppText>
								{
									deleteCopy.choices.find(
										(option) => option.value === (deleteChoice?.choice ?? "cancel_subscription"),
									)?.description
								}
							</AppText>
						</AppView>
					}
					cancelLabel={deleteCopy.dismissLabel}
					confirmLabel={deleteCopy.confirmLabel}
					destructive
					onConfirm={() => deleteChoice?.confirm(deleteChoice.choice)}
				/>
			) : null}
			{section === "settings" && deployment ? (
				<SettingsSection
					title={agentSettingsCopy.languageTimezone.title}
					description={agentSettingsCopy.languageTimezone.description}
				>
					<LocaleSettings
						key={JSON.stringify([
							deployment.resource.spec.runtime_configuration.language,
							deployment.resource.spec.runtime_configuration.timezone,
						])}
						deployment={deployment}
						disabled={busy || status.kind === "updating"}
						apply={(body) => request({ action: "update", body })}
					/>
				</SettingsSection>
			) : null}
			{section === "settings" ? computePlan : null}
			{section === "settings" ? (
				<SettingsSection
					title={agentSettingsCopy.controls.title}
					description={agentSettingsCopy.controls.description}
				>
					<AppView className="gap-3">
						{statusDetails}
						{journal}
						<WebView recipe={styles.controls} className="flex-row">
							<ActionButton
								label={agentSettingsCopy.controls.restart}
								icon={<Icon as={RefreshCw} />}
								disabled={busy || !deploymentLifecycleAvailable("restart", status.kind)}
								onPress={() => request({ action: "restart" })}
							/>
							{primary === "stop" ? (
								<ActionButton
									label={agentSettingsCopy.controls.stop}
									disabled={busy || !deploymentLifecycleAvailable("stop", status.kind)}
									onPress={() => request({ action: "stop" })}
								/>
							) : deployment?.start_action === "start" ? (
								startButton(agentSettingsCopy.controls.start)
							) : (
								startFallback
							)}
						</WebView>
					</AppView>
				</SettingsSection>
			) : (
				<>
					{journal}
					{section === "startup" && canStart && deployment?.start_action === "start"
						? startButton(startLabel ?? initialDeploymentCopy.retry)
						: null}
				</>
			)}
			{section === "settings" ? (
				<SettingsSection
					title={agentSettingsCopy.dangerZone.title}
					description={agentSettingsCopy.dangerZone.description}
					destructive
				>
					<WebView recipe={styles.deleteRow}>
						<AppView>
							<WebText recipe={styles.deleteTitle}>
								{agentSettingsCopy.dangerZone.deleteTitle}
							</WebText>
							<WebText recipe={styles.deleteDescription}>
								{agentSettingsCopy.dangerZone.deleteDescription}
							</WebText>
						</AppView>
						<ActionButton
							label={agentSettingsCopy.dangerZone.delete}
							icon={<Icon as={Trash2} />}
							className="text-destructive"
							disabled={writeBlocked || !deploymentLifecycleAvailable("delete", status.kind)}
							onPress={() =>
								request({
									action: "delete",
									body: { subscription_choice: defaultChoice },
								})
							}
						/>
					</WebView>
					{attempt?.mutation.action === "delete" ? (
						<AppText accessibilityRole="alert">
							{attempt.mutation.body.subscription_choice === "cancel_subscription" &&
							fundingMode !== "included_basic"
								? `${deleteCopy.warning} ${t("runtime.deleteCancelsSubscription")}`
								: deleteCopy.warning}
						</AppText>
					) : null}
				</SettingsSection>
			) : null}
			{deployment && section === "ai" ? (
				<ModelSettings
					key={JSON.stringify([
						deployment.resource.spec.runtime_configuration.providers,
						deployment.resource.spec.runtime_configuration.primary_model,
					])}
					deployment={deployment}
					disabled={busy || !stable}
					apply={(body) => request({ action: "update", body })}
				/>
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
	const copy = agentSettingsCopy.languageTimezone;
	const config = deployment.resource.spec.runtime_configuration;
	const configLanguage = config.language ?? "";
	const configTimezone = config.timezone ?? "";
	const [language, setLanguage] = useState(configLanguage);
	const [timezone, setTimezone] = useState(configTimezone);
	const [runtimeTimezones] = useState(() =>
		supportedTimezones(configTimezone ? [configTimezone] : []),
	);
	const timezoneOptions = mergeTimezoneOptions(
		runtimeTimezones,
		[configTimezone, timezone].filter(Boolean),
	);
	const dirty = language !== configLanguage || timezone !== configTimezone;
	return (
		<WebView recipe={styles.locale}>
			<WebView recipe={styles.liveNote} className="flex-row">
				<WebIcon as={Info} recipe={styles.liveNoteIcon} />
				<AppText>{copy.note}</AppText>
			</WebView>
			<WebView recipe={styles.localeFields}>
				<WebView recipe={styles.field}>
					<Label>{copy.language}</Label>
					<NativePicker
						className="w-full"
						value={language}
						options={[
							{ value: "", label: agentSurfaceCopy.default },
							...HOSTED_DEPLOY_LANGUAGE_OPTIONS.map((item) => ({
								value: item.code,
								label: item.label,
							})),
						]}
						disabled={disabled}
						onValueChange={setLanguage}
					/>
				</WebView>
				<WebView recipe={styles.field}>
					<Label>{copy.timezone}</Label>
					<TimezoneCombobox
						value={timezone}
						options={timezoneOptions}
						disabled={disabled}
						onValueChange={setTimezone}
					/>
				</WebView>
			</WebView>
			<ActionButton
				label={copy.save}
				variant="default"
				className="self-start"
				disabled={disabled || !dirty}
				onPress={() =>
					apply({
						language: normalizeHostedDeployLanguage(language),
						timezone: timezone.trim() || null,
					})
				}
			/>
		</WebView>
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
			? MANAGED_AI_CHOICE
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
			<ActionButton
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
					(choice === MANAGED_AI_CHOICE && !model) ||
					(Boolean(selected) && !agentOwnsModels && !model)
				}
				onPress={() =>
					void action.run(async () => {
						if (!catalog.data) return;
						if (choice !== MANAGED_AI_CHOICE && choice !== "__unmanaged__" && !selected)
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
										: choice === MANAGED_AI_CHOICE
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
