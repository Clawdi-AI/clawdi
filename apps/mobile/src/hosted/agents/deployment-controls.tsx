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
	agentDisplayName,
	agentSurfaceCopy,
	aiBindingCopy,
	computeFundingMode,
	computeSubscriptionCancellationCopy,
	deploymentDeleteSubscriptionPolicy,
	firstModelForProvider,
	formatShortDate,
	initialDeploymentCopy,
	isManagedProviderId,
	primaryModelValue,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActionButton, ChoiceSelect as NativePicker } from "@/components/dashboard/controls";
import { EntityAddCard } from "@/components/entity-card";
import { RichConfirmAction } from "@/components/ui/confirm-action";
import { Input as AppTextInput } from "@/components/ui/input";
import { Text as AppText } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { AppView } from "@/components/ui/view";
import { ProviderCreate } from "@/hosted/v2/ai-providers/add-provider-dialog";
import { AiBindingChoices } from "@/hosted/v2/ai-providers/ai-binding-choices";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { NativeSegments } from "@/platform/navigation/segmented-control";
import type { RuntimeAttempt } from "@/platform/runtime-attempt";
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
	section = "all",
	onBusyChange,
	startLabel,
}: {
	deployment: DeploymentRead | undefined;
	deploymentId: string;
	blocked: boolean;
	transitioning: boolean;
	onAccepted: (operation: HostedDeployOperation) => Promise<void>;
	onAbsent: () => Promise<void>;
	section?: "all" | "ai" | "startup";
	onBusyChange?: (busy: boolean) => void;
	startLabel?: string;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { deploymentMutations } = useMobileApi();
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
	const subscription = deployment?.commercial_display?.compute_subscription;
	const fundingMode = computeFundingMode(deployment?.current_plan_slug, subscription);
	const { offerChoice, defaultChoice, storeNotice } =
		deploymentDeleteSubscriptionPolicy(deployment);
	const periodEnd = formatShortDate(subscription?.current_period_end);
	const periodEndLabel = periodEnd === "—" ? null : periodEnd;
	const deleteTitle = deployment
		? t("runtime.deleteTitle", {
				name: agentDisplayName({
					name: deployment.resource.name,
					agent_type: deployment.resource.spec.runtime,
				}),
			})
		: "";
	const [deleteChoice, setDeleteChoice] = useState<{
		choice: SubscriptionChoice;
		confirm: (choice: SubscriptionChoice) => unknown;
	} | null>(null);
	const confirm = (mutation: DeploymentMutation) => {
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
		nativeConfirmation.show(
			mutation.action === "delete" ? deleteTitle : t("runtime.confirm"),
			mutation.action === "delete"
				? storeNotice
					? `${t("runtime.deleteWarning")}\n\n${storeNotice}`
					: subscription?.cancel_at_period_end
						? `${t("runtime.deleteWarning")}\n\n${t("runtime.deleteScheduledCancel")}`
						: t("runtime.deleteWarning")
				: t("runtime.warning"),
			[
				{ text: t("account.cancel"), style: "cancel" },
				{
					text: t(mutation.action === "delete" ? "runtime.deleteAgent" : "runtime.apply"),
					style: mutation.action === "delete" ? "destructive" : "default",
					onPress: () => run(mutation),
				},
			],
		);
	};
	const stable = state === "running" || state === "stopped" || state === "failed";
	return (
		<AppView className="gap-3">
			{nativeConfirmation.dialog}
			{section === "all" && deployment ? (
				<RichConfirmAction
					open={deleteChoice !== null}
					onOpenChange={(open) => {
						if (!open) {
							confirmation.current++;
							setDeleteChoice(null);
						}
					}}
					title={deleteTitle}
					description={
						<AppView className="gap-3">
							<AppText>{t("runtime.deleteWarning")}</AppText>
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
								{deleteChoice?.choice === "keep_subscription"
									? periodEndLabel
										? `${t("runtime.deleteKeepDescription")} ${t("runtime.deleteValidThrough", { date: periodEndLabel })}`
										: t("runtime.deleteKeepDescription")
									: computeSubscriptionCancellationCopy({
											isTrial: subscription?.status === "trialing",
											periodEndLabel,
											hasRetainedDeployment: false,
										}).description}
							</AppText>
						</AppView>
					}
					cancelLabel={t("account.cancel")}
					confirmLabel={t(
						deleteChoice?.choice === "keep_subscription"
							? "runtime.deleteKeepConfirm"
							: "runtime.deleteCancelConfirm",
					)}
					destructive
					onConfirm={() => deleteChoice?.confirm(deleteChoice.choice)}
				/>
			) : null}
			{section === "all" ? (
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
			{section === "all" || attempt || storageError ? (
				<ActionButton
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
					<ActionButton
						label={t("runtime.retry")}
						disabled={action.busy || rejected || !storageKey || storageError}
						onPress={() => void submit(attempt)}
					/>
					{attempt.status !== "uncertain" ? (
						<ActionButton
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
				<ActionButton
					label={
						startLabel ?? (section === "startup" ? initialDeploymentCopy.retry : t("runtime.start"))
					}
					disabled={busy}
					onPress={() => confirm({ action: "start" })}
				/>
			) : null}
			{section === "all" && state === "stopped" && deployment?.start_action !== "start" ? (
				<AppText>{t("runtime.paymentRequired")}</AppText>
			) : null}
			{section === "all" && deploymentLifecycleAvailable("stop", state) ? (
				<ActionButton
					label={t("runtime.stop")}
					disabled={busy}
					onPress={() => confirm({ action: "stop" })}
				/>
			) : null}
			{section === "all" && deploymentLifecycleAvailable("restart", state) ? (
				<ActionButton
					label={t("runtime.restart")}
					disabled={busy}
					onPress={() => confirm({ action: "restart" })}
				/>
			) : null}
			{section === "all" && stable ? (
				<ActionButton
					label={t("runtime.resetAccess")}
					disabled={busy}
					onPress={() => confirm({ action: "reset_runtime_ui_access" })}
				/>
			) : null}
			{section === "all" && deploymentLifecycleAvailable("delete", state) ? (
				<ActionButton
					label={t("runtime.deleteAgent")}
					disabled={writeBlocked}
					onPress={() =>
						confirm({
							action: "delete",
							body: { subscription_choice: defaultChoice },
						})
					}
				/>
			) : null}
			{attempt?.mutation.action === "delete" ? (
				<AppText accessibilityRole="alert">
					{attempt.mutation.body.subscription_choice === "cancel_subscription" &&
					fundingMode !== "included_basic"
						? `${t("runtime.deleteWarning")} ${t("runtime.deleteCancelsSubscription")}`
						: t("runtime.deleteWarning")}
				</AppText>
			) : null}
			{deployment && section !== "startup" ? (
				<>
					{section === "all" ? (
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
			<ActionButton
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
