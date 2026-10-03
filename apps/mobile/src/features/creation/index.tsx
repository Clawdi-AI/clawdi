import {
	buildHostedDeploySubscriptionQuoteRequest,
	HOSTED_DEPLOY_LANGUAGE_OPTIONS,
	type HostedDeploySubscriptionQuote,
	type HostedDeploySubscriptionSelection,
	type HostedDeployWizardDraft,
	hostedDeployRuntimeLabel,
	isHostedDeployComputePlan,
	isHostedDeployRuntime,
	projectHostedDeployRequest,
	validateAndBuildHostedDeployRequest,
} from "@clawdi/shared/api";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useMobileApi } from "../../providers/api-provider";
import { NativeButton, NativePicker, NativeSwitch } from "../../ui/native-controls";
import { AppScrollView, AppText, AppTextInput, AppView } from "../../ui/primitives";
import { ReadScreen } from "../../ui/read-screen";
import { nextBillingCursor, subscriptionPrice, uniqueBillingItems } from "../billing/helpers";
import { BackButton, formatDate } from "../cloud-inventory";
import { operationIdFromName } from "../deployments/state";
import { ResourceError } from "../resource-error";
import {
	type CreationAttempt,
	canDiscardCreationAttempt,
	isDefinitiveAdmissionRejection,
	offeredQuoteSelections,
	serverAllowsEntitledCreation,
	validationTranslationKeys,
} from "./state";
import { clearAttempt, readSavedAttempt, replaceAttempt, saveAttempt } from "./storage";

export { creationEn } from "./en";

const initialDraft: HostedDeployWizardDraft = {
	runtime: "hermes",
	computePlanSlug: "compute_basic",
	agentName: "Hermes",
	language: "en",
	timezone: "",
	ai: { mode: "unmanaged" },
};

export function CreateAgentScreen() {
	const scope = useAccountScope();
	return <CreationForm key={`${scope.accountKey}:${scope.generation}`} />;
}

function CreationForm() {
	const { compute, hosted } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const t = useI18n();
	const router = useRouter();
	const action = useAuthAction(scope);
	const [draft, setDraft] = useState(initialDraft);
	const [attempt, setAttempt] = useState<CreationAttempt | null>(null);
	const [storageKey, setStorageKey] = useState<string | null>(null);
	const [storageReady, setStorageReady] = useState(false);
	const [storageError, setStorageError] = useState(false);
	const [confirmed, setConfirmed] = useState(false);
	const [message, setMessage] = useState("");
	const [quote, setQuote] = useState<HostedDeploySubscriptionQuote | null>(null);
	const [quoteSelection, setQuoteSelection] = useState<HostedDeploySubscriptionSelection | null>(
		null,
	);
	const [resolved, setResolved] = useState(false);
	const inventory = useQuery({
		queryKey: accountQueryKey(scope, "creation-inventory"),
		queryFn: ({ signal }) =>
			read(async (s) => {
				if (!compute) throw new Error("Compute API unavailable");
				const [plans, catalog, included, capabilities] = await Promise.all([
					compute.listPlans(s),
					compute.getManagedModels(s),
					compute.getIncludedBasicAvailability(s),
					compute.getProductCapabilities(s),
				]);
				return { plans, catalog, included, capabilities };
			}, signal),
		enabled: scope.isReady && Boolean(compute),
		retry: false,
	});
	const reusable = useInfiniteQuery({
		queryKey: accountQueryKey(scope, "creation-reusable"),
		initialPageParam: undefined as string | undefined,
		queryFn: ({ signal, pageParam }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getReusableSubscriptions({ limit: 25, cursor: pageParam }, s);
			}, signal),
		getNextPageParam: nextBillingCursor,
		enabled: scope.isReady && Boolean(compute),
		retry: false,
	});
	const reusableItems = uniqueBillingItems(
		reusable.data?.pages.flatMap((page) => page.items ?? []) ?? [],
		(item) => item.subscription_id,
	);

	useEffect(() => {
		let mounted = true;
		const current = () => mounted && scope.isCurrent() && !scope.signal.aborted;
		const restore = async () => {
			if (!scope.accountKey || !scope.isReady) return;
			try {
				const digest = await Crypto.digestStringAsync(
					Crypto.CryptoDigestAlgorithm.SHA256,
					scope.accountKey,
				);
				if (!current()) return;
				const key = `clawdi.creation.v1.${digest}`;
				const saved = await readSavedAttempt(key);
				if (!current()) return;
				setStorageKey(key);
				setAttempt(saved);
				if (saved) setDraft(saved.draft);
				setStorageReady(true);
			} catch {
				if (current()) setStorageError(true);
			}
		};
		void restore();
		return () => {
			mounted = false;
		};
	}, [scope]);

	const models = inventory.data?.catalog.models ?? [];
	const selectedPlan = inventory.data?.plans.find((plan) => plan.slug === draft.computePlanSlug);
	const eligible = serverAllowsEntitledCreation(
		inventory.data?.capabilities,
		inventory.data?.included,
		selectedPlan,
		{ reusable: reusableItems, hasSavedAttempt: Boolean(attempt) },
	);
	const quoteOptions = offeredQuoteSelections(inventory.data?.plans ?? []);
	const quoteAvailable =
		quoteSelection &&
		quoteOptions.some(
			(option) =>
				option.planSlug === quoteSelection.planSlug &&
				option.billingTermMonths === quoteSelection.billingTermMonths,
		);
	const current = (owns: () => boolean) => owns() && scope.isCurrent() && !scope.signal.aborted;
	const navigateRequest = async (id: string, owns: () => boolean) => {
		if (!hosted) throw new Error("Hosted API unavailable");
		const status = await read((s) => hosted.getDeploymentByRequest(id, s));
		if (!current(owns)) return;
		const projection = projectHostedDeployRequest(status);
		if (projection.kind === "terminal" || projection.kind === "deployment") setResolved(true);
		if (projection.kind === "deployment") {
			router.push(`/deployments/${encodeURIComponent(projection.deploymentId)}`);
		} else if (projection.kind === "operation" || projection.kind === "operation_name") {
			const operationId = operationIdFromName(
				projection.kind === "operation" ? projection.operation.name : projection.operationName,
			);
			if (!operationId) throw new Error("Invalid operation name");
			const operation =
				projection.kind === "operation"
					? projection.operation
					: await read((s) => hosted.getOperation(operationId, s));
			if (current(owns))
				router.push(`/deployments/${encodeURIComponent(operation.metadata.deploymentId)}`);
		} else
			setMessage(
				t(
					projection.kind === "terminal" || projection.kind === "invalid_success"
						? "creation.failed"
						: "creation.wait",
				),
			);
	};
	const create = () =>
		action.run(async (owns) => {
			if (
				!compute ||
				!hosted ||
				!storageReady ||
				!storageKey ||
				!confirmed ||
				!eligible ||
				!current(owns)
			)
				return;
			// Refresh authorization at the explicit mutation boundary, never rely on a stale query.
			const [capabilities, included, plans] = await read((s) =>
				Promise.all([
					compute.getProductCapabilities(s),
					compute.getIncludedBasicAvailability(s),
					compute.listPlans(s),
				]),
			);
			if (!current(owns)) return;
			const refreshedReusable = attempt
				? undefined
				: await reusable.refetch({ throwOnError: true });
			if (
				!current(owns) ||
				!serverAllowsEntitledCreation(
					capabilities,
					included,
					plans.find((p) => p.slug === draft.computePlanSlug),
					{
						reusable: refreshedReusable?.data?.pages.flatMap((page) => page.items ?? []),
						hasSavedAttempt: Boolean(attempt),
					},
				)
			) {
				if (current(owns)) setMessage(t("creation.blocked"));
				return;
			}
			// A saved request is already validated. Catalog changes must not rewrite
			// or prevent same-key replay of an uncertain, previously admitted POST.
			let saved = attempt;
			if (!saved) {
				const validated = validateAndBuildHostedDeployRequest(draft, models);
				if (!validated.ok) {
					setMessage(
						validated.issues.map((issue) => t(validationTranslationKeys[issue.field])).join("\n"),
					);
					return;
				}
				const ai = draft.ai;
				if (ai.mode === "managed" && !models.some((model) => model.id === ai.model)) return;
				const id = Crypto.randomUUID();
				saved = {
					version: 1,
					submission: "prepared",
					id,
					draft,
					request: { ...validated.request, deploy_request_id: id },
				};
			}
			// Persist before POST. A failed write must never fall through to creation.
			if (!attempt) await saveAttempt(storageKey, saved, () => current(owns));
			if (!current(owns)) return;
			setAttempt(saved);
			// Persist uncertainty BEFORE any POST, including an app crash or account switch.
			const submitting: CreationAttempt = { ...saved, submission: "uncertain" };
			await replaceAttempt(storageKey, saved, submitting, () => current(owns));
			if (!current(owns)) return;
			setAttempt(submitting);
			try {
				await read((s) => compute.createEntitledDeployment(submitting.request, submitting.id, s));
			} catch (error) {
				if (current(owns) && isDefinitiveAdmissionRejection(saved, error)) {
					const rejected: CreationAttempt = { ...saved, submission: "entitlement_rejected" };
					await replaceAttempt(storageKey, submitting, rejected, () => current(owns));
					if (current(owns)) {
						setAttempt(rejected);
						setMessage(t("creation.notAdmitted"));
					}
				}
				throw error;
			}
			if (current(owns)) await navigateRequest(saved.id, owns);
		});
	const update = (patch: Partial<HostedDeployWizardDraft>) => {
		setDraft((previous) => ({ ...previous, ...patch }));
		setMessage("");
		setQuote(null);
		setConfirmed(false);
	};
	const locked = action.busy || Boolean(attempt) || !storageReady;
	const catalogUnavailable = inventory.isPending || inventory.isError || models.length === 0;
	const aiSelection = draft.ai;
	const selectedModel =
		aiSelection.mode === "managed" && models.some((model) => model.id === aiSelection.model)
			? aiSelection.model
			: "";
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName="gap-4 p-5">
				<BackButton />
				<AppText className="text-2xl font-semibold text-foreground">{t("creation.title")}</AppText>
				{!compute || !hosted ? (
					<AppText>{t("creation.unavailable")}</AppText>
				) : (
					<>
						{storageError ? (
							<AppText className="text-danger">{t("creation.storageError")}</AppText>
						) : null}
						{action.error ? <AppText className="text-danger">{t("creation.error")}</AppText> : null}
						{inventory.isError ? <ResourceError missing={false} /> : null}
						<NativeButton
							label={t("creation.refresh")}
							disabled={inventory.isFetching || reusable.isFetching || action.busy}
							onPress={() => {
								setConfirmed(false);
								void inventory.refetch();
								void reusable.refetch();
							}}
						/>
						<AppText>{t("creation.runtime")}</AppText>
						<NativePicker
							value={draft.runtime}
							options={(["hermes", "openclaw"] as const).map((runtime) => ({
								value: runtime,
								label: hostedDeployRuntimeLabel(runtime),
							}))}
							disabled={locked}
							onValueChange={(runtime) => {
								if (isHostedDeployRuntime(runtime)) update({ runtime });
							}}
						/>
						<AppText>{t("creation.name")}</AppText>
						<AppTextInput
							accessibilityLabel={t("creation.name")}
							value={draft.agentName}
							editable={!locked}
							maxLength={64}
							onChangeText={(agentName) => update({ agentName })}
							className="rounded-xl bg-surface p-3 text-foreground"
						/>
						<AppText>{t("creation.language")}</AppText>
						<NativePicker
							value={draft.language}
							options={HOSTED_DEPLOY_LANGUAGE_OPTIONS.map((language) => ({
								value: language.code,
								label: language.label,
							}))}
							disabled={locked}
							onValueChange={(language) => {
								if (HOSTED_DEPLOY_LANGUAGE_OPTIONS.some((option) => option.code === language))
									update({ language });
							}}
						/>
						<AppText>{t("creation.timezone")}</AppText>
						<AppTextInput
							accessibilityLabel={t("creation.timezone")}
							value={draft.timezone}
							editable={!locked}
							autoCapitalize="none"
							onChangeText={(timezone) => update({ timezone })}
							className="rounded-xl bg-surface p-3 text-foreground"
						/>
						<NativeSwitch
							label={t("creation.managed")}
							value={draft.ai.mode === "managed"}
							disabled={locked || catalogUnavailable}
							onValueChange={(managed) => {
								if (!managed) update({ ai: { mode: "unmanaged" } });
								else {
									const model = models.find((item) => item.is_default) ?? models[0];
									if (model) update({ ai: { mode: "managed", model: model.id } });
								}
							}}
						/>
						{draft.ai.mode === "unmanaged" ? (
							<AppText>{t("creation.unmanaged")}</AppText>
						) : (
							<>
								<AppText>{t("creation.model")}</AppText>
								<NativePicker
									value={selectedModel}
									options={[
										{ value: "", label: t("creation.chooseModel") },
										...models.map((model) => ({ value: model.id, label: model.display_name })),
									]}
									disabled={locked || catalogUnavailable}
									onValueChange={(model) => {
										if (models.some((item) => item.id === model))
											update({ ai: { mode: "managed", model } });
									}}
								/>
							</>
						)}
						<AppText>{t("creation.compute")}</AppText>
						<NativePicker
							value={draft.computePlanSlug}
							options={[
								{
									value: "compute_basic",
									label:
										inventory.data?.plans.find((plan) => plan.slug === "compute_basic")?.name ??
										t("creation.basic"),
								},
								{
									value: "compute_performance",
									label:
										inventory.data?.plans.find((plan) => plan.slug === "compute_performance")
											?.name ?? t("creation.performance"),
								},
							]}
							disabled={locked}
							onValueChange={(computePlanSlug) => {
								if (isHostedDeployComputePlan(computePlanSlug)) update({ computePlanSlug });
							}}
						/>
						<AppText>{t("creation.selectionNotice")}</AppText>
						{inventory.data?.plans.map((plan) => (
							<AppView key={plan.slug} className="gap-2 rounded-xl bg-surface p-3">
								<AppText>
									{plan.name} · {plan.vcpu} vCPU · {plan.ram_gb} GB · {plan.disk_size} GB
								</AppText>
								<AppText>
									{plan.offers
										?.map(
											(offer) =>
												`${offer.billing_term_months} ${t("creation.months")}: ${subscriptionPrice({ price_cents: offer.price_cents, currency: "usd" }) ?? t("billing.unknown")}`,
										)
										.join(" · ") ??
										subscriptionPrice({ price_cents: plan.price_cents, currency: "usd" }) ??
										t("billing.unknown")}
								</AppText>
							</AppView>
						))}
						<AppText>
							{t("creation.included")}: {inventory.data?.included.available_slots ?? "—"}
						</AppText>
						<AppText>
							{t("creation.reusable")}: {reusable.isPending ? "—" : reusableItems.length}
						</AppText>
						{reusable.isError ? <ResourceError missing={false} /> : null}
						{reusable.hasNextPage ? (
							<NativeButton
								label={t("inventory.loadMore")}
								disabled={reusable.isFetching || action.busy}
								onPress={() => void reusable.fetchNextPage()}
							/>
						) : null}
						{reusableItems.map((subscription) => (
							<AppView
								key={subscription.subscription_id}
								className="gap-2 rounded-xl bg-surface p-3"
							>
								<AppText>
									{subscription.plan_slug} · {subscription.billing_term_months}{" "}
									{t("creation.months")} · {subscription.status}
								</AppText>
								<AppText>
									{subscriptionPrice(subscription) ?? t("billing.unknown")} ·{" "}
									{formatDate(subscription.entitled_until) ?? t("billing.unknown")}
								</AppText>
							</AppView>
						))}
						<AppText>{t("creation.pending")}</AppText>
						<AppText>{t("creation.quoteNotice")}</AppText>
						{quoteOptions.map((option) => (
							<NativeButton
								key={`${option.planSlug}:${option.billingTermMonths}`}
								disabled={action.busy}
								label={`${quoteSelection?.planSlug === option.planSlug && quoteSelection.billingTermMonths === option.billingTermMonths ? "✓ " : ""}${inventory.data?.plans.find((plan) => plan.slug === option.planSlug)?.name ?? option.planSlug} · ${t(option.billingTermMonths === 12 ? "creation.annual" : "creation.monthly")}`}
								onPress={() => {
									setQuoteSelection(option);
									setQuote(null);
								}}
							/>
						))}
						<NativeButton
							label={t("creation.quote")}
							disabled={action.busy || !quoteAvailable || inventory.isError}
							onPress={() => {
								void action.run(async (owns) => {
									if (!quoteSelection || !quoteAvailable) return;
									const result = await read((s) =>
										compute.quoteSubscription(
											buildHostedDeploySubscriptionQuoteRequest(quoteSelection),
											s,
										),
									);
									if (current(owns)) setQuote(result);
								});
							}}
						/>
						{quote ? (
							<AppText>
								{t("creation.preview")}:{" "}
								{subscriptionPrice({
									price_cents: quote.term_price_cents,
									currency: quote.currency,
								}) ?? t("billing.unknown")}{" "}
								· {formatDate(quote.expires_at) ?? t("billing.unknown")}
							</AppText>
						) : null}
						<NativeButton
							label={t("creation.validate")}
							disabled={action.busy}
							onPress={() => {
								const result = validateAndBuildHostedDeployRequest(draft, models);
								setMessage(
									result.ok
										? t("creation.valid")
										: result.issues
												.map((issue) => t(validationTranslationKeys[issue.field]))
												.join("\n"),
								);
							}}
						/>
						{message ? <AppText>{message}</AppText> : null}
						{attempt ? (
							<>
								<AppText>{t("creation.saved")}</AppText>
								<AppText selectable>{attempt.id}</AppText>
								<NativeButton
									label={t("creation.recover")}
									disabled={action.busy}
									onPress={() => {
										void action.run((owns) => navigateRequest(attempt.id, owns));
									}}
								/>
								{resolved || canDiscardCreationAttempt(attempt) ? (
									<NativeButton
										label={t(resolved ? "creation.clear" : "creation.discard")}
										disabled={action.busy}
										onPress={() => {
											void action.run(async (owns) => {
												if (!storageKey) return;
												await clearAttempt(storageKey, attempt, () => current(owns));
												if (current(owns)) {
													setAttempt(null);
													setDraft(initialDraft);
													setResolved(false);
													setConfirmed(false);
													setMessage("");
												}
											});
										}}
									/>
								) : null}
							</>
						) : null}
						<NativeSwitch
							label={t("creation.confirm")}
							value={confirmed}
							disabled={action.busy || !eligible}
							onValueChange={setConfirmed}
						/>
						{!eligible ? <AppText>{t("creation.blocked")}</AppText> : null}
						<NativeButton
							label={t(attempt ? "creation.retry" : "creation.create")}
							disabled={
								action.busy ||
								resolved ||
								!confirmed ||
								!eligible ||
								!storageReady ||
								storageError ||
								inventory.isError
							}
							onPress={() => {
								void create();
							}}
						/>
					</>
				)}
			</AppScrollView>
		</ReadScreen>
	);
}
