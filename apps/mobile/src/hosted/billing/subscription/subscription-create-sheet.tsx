import {
	ApiClientError,
	buildHostedDeploySubscriptionQuoteRequest,
	type DeployComponents,
	type DeploymentRead,
	HOSTED_WALLET_FUNDING_ERROR_COPY,
	type HostedDeploySubscriptionQuote,
	type HostedDeploySubscriptionSelection,
	hostedSubscriptionQuoteWalletDebit,
	hostedWalletFundingErrorKind,
} from "@clawdi/shared/api";
import { subscriptionSourcePickerClasses as pickerStyles } from "@clawdi/shared/ui";
import {
	agentSectionHref,
	billingErrorCopy,
	billingTermLabel,
	computePricePresentation,
	computeTierLabel,
	subscriptionCreateCopy as copy,
	existingSubscriptionCreateSelection,
	formatCents,
	formatUsdExact,
	fundingSourcesFor,
	isWebSelectableSubscription,
	resolveSubscriptionSource,
	reusableSubscriptionChoiceView,
	type SubscriptionSource,
	subscriptionSourceCopy,
	supportedBillingTerm,
	walletDebitShortfallUsd,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { useLocalSearchParams } from "expo-router";
import Cpu from "lucide-react-native/icons/cpu";
import CreditCard from "lucide-react-native/icons/credit-card";
import Plus from "lucide-react-native/icons/plus";
import Smartphone from "lucide-react-native/icons/smartphone";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import WalletCards from "lucide-react-native/icons/wallet-cards";
import Zap from "lucide-react-native/icons/zap";
import { useEffect, useRef, useState } from "react";
import { Alert as NativeAlert } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { ENTITY_CHOICE_GRID_CLASS, EntityChoiceCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { SheetPage } from "@/components/ui/sheet-page";
import { StatusBadge } from "@/components/ui/status-badge";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { WebIcon, WebText, WebView, webView } from "@/components/ui/web-layout";
import { useAgentDeployment, useComputePlanModel } from "@/hosted/agents/compute-plan-model";
import { WalletDebitEquation } from "@/hosted/billing/components/wallet-debit-equation";
import {
	canonicalWalletQuote,
	walletQuoteConfirmation,
} from "@/hosted/billing/deploy/deploy-request";
import { useReusableSubscriptions } from "@/hosted/billing/hooks";
import { StoreUpgradeAction } from "@/hosted/billing/store/compute-store";
import {
	type SubscriptionAttempt,
	subscriptionAttemptControls,
	subscriptionAttemptErrorCopy,
	subscriptionAttemptNeedsQuote,
	subscriptionAttemptStorageKey,
} from "@/hosted/billing/subscription/subscription-attempt";
import {
	confirmSubscriptionAttempt,
	replaySubscriptionAttempt,
	type SubscriptionAttemptDeps,
	type SubscriptionAttemptStep,
} from "@/hosted/billing/subscription/subscription-attempt-controller";
import {
	type ComputePlanSlug,
	FundingField,
	type FundingSource,
	offersForPlan,
	PlanField,
	planForSlug,
	TermField,
} from "@/hosted/billing/subscription/subscription-sheet-controls";
import { WalletTopUpAction } from "@/hosted/billing/wallet/balance-card";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { requestFailure } from "@/lib/request-failure";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useSheet } from "@/platform/navigation/use-sheet";
import { useStoreSurfaces } from "@/platform/store/store-provider";
import { subscriptionAttempts } from "@/platform/subscription-attempt-storage";

type ReusableSubscription = DeployComponents["schemas"]["V2ComputeReusableSubscriptionItem"];
type Notice = { title: string; description?: string };

/** Reads every view an activation changes, like Web's sensitive subscription actions. */
const ACTIVATION_READS = [
	"deployments",
	"deployment",
	"billing-subscriptions",
	"billing-reusable",
	"billing-wallet",
	"billing-transactions",
	"creation-inventory",
	"creation-reusable",
	"cloud-agents",
] as const;

/** `/agents/[id]/subscription`: Web's "Choose a paid subscription" for an existing Agent. */
export default function SubscriptionCreateRoute() {
	const scope = useAccountScope();
	const agentId = routeParam(useLocalSearchParams<{ id?: string | string[] }>().id);
	const agent = useAgentDeployment(agentId);
	if (!agentId || !agent.deployment)
		return (
			<SheetPage title={copy.title} fallback={agentId ? agentSectionHref(agentId) : "/agents"}>
				{agent.error || agent.missing ? (
					<ApiErrorPanel error={agent.error ?? new ApiClientError(404)} onRetry={agent.retry} />
				) : (
					<LoadingScreen />
				)}
			</SheetPage>
		);
	return (
		<SubscriptionCreateSheet
			key={`${scope.accountKey}:${scope.generation}:${agent.deployment.resource.id}`}
			agentId={agentId}
			deployment={agent.deployment}
		/>
	);
}

function SubscriptionCreateSheet({
	agentId,
	deployment,
}: {
	agentId: string;
	deployment: DeploymentRead;
}) {
	const t = useI18n();
	const cache = useQueryClient();
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const surfaces = useStoreSurfaces();
	const storeBuild = !surfaces.cardBilling;
	const model = useComputePlanModel(deployment);
	const reusable = useReusableSubscriptions();
	const action = useAuthAction(scope);
	const sheet = useSheet<Notice>({
		fallback: agentSectionHref(agentId, "settings"),
		busy: action.busy,
		// Web's success toast, as a native confirmation once the sheet closes.
		onResult: async (notice) => NativeAlert.alert(notice.title, notice.description),
	});
	const deploymentId = deployment.resource.id;
	const fundingSources = fundingSourcesFor(storeBuild, "new_subscription");
	const [selected, setSelected] = useState<SubscriptionSource | null>(null);
	const [planChoice, setPlanChoice] = useState<ComputePlanSlug | null>(null);
	const [termChoice, setTermChoice] = useState<number | null>(null);
	const [fundingSource, setFundingSource] = useState<FundingSource>(fundingSources[0] ?? "wallet");
	const [message, setMessage] = useState<Notice | null>(null);
	const [walletFundingRefused, setWalletFundingRefused] = useState(false);
	const [attempt, setAttempt] = useState<SubscriptionAttempt | null>(null);
	const [storageKey, setStorageKey] = useState<string | null>(null);
	const [storage, setStorage] = useState<"loading" | "ready" | "error">("loading");
	// Assignment moves no money: like Web, one in-memory key per selection.
	const assignment = useRef<{ subscriptionId: string; key: string } | null>(null);

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
				const key = subscriptionAttemptStorageKey(digest, deploymentId);
				if (!key) throw new Error("Invalid subscription storage key");
				const saved = await subscriptionAttempts.readSavedAttempt(key);
				if (!current()) return;
				setStorageKey(key);
				setAttempt(saved);
				if (saved) {
					// A saved request resumes exactly as it was confirmed.
					setPlanChoice(saved.selection.planSlug);
					setTermChoice(saved.selection.billingTermMonths);
					setFundingSource("wallet");
				}
				setStorage("ready");
			} catch {
				if (current()) setStorage("error");
			}
		};
		void restore();
		return () => {
			mounted = false;
		};
	}, [scope, deploymentId]);

	const plans = model.plans.data;
	const planSlug = planChoice ?? model.subscriptionCreatePlanSlug;
	const offers = offersForPlan(planForSlug(plans, planSlug), planSlug);
	const billingTermMonths =
		termChoice ??
		offers.find((offer) => offer.billing_term_months === model.billingTerm)?.billing_term_months ??
		offers[0]?.billing_term_months ??
		model.billingTerm;
	const selectedOffer =
		offers.find((offer) => offer.billing_term_months === billingTermMonths) ?? null;
	const selectedPrice = selectedOffer ? computePricePresentation(selectedOffer, offers) : null;
	const reusableItems = reusable.error == null ? reusable.data : undefined;
	const selectable = (reusable.data ?? []).filter(isWebSelectableSubscription);
	const source: SubscriptionSource | null = attempt
		? { mode: "new" }
		: resolveSubscriptionSource({
				selected,
				includedAvailable: false,
				reusableSubscriptions: reusableItems,
			});
	const selectedReusable =
		source?.mode === "existing"
			? (selectable.find((item) => item.subscription_id === source.subscriptionId) ?? null)
			: null;
	const supportedTerm = supportedBillingTerm(billingTermMonths);
	const walletSelection: (HostedDeploySubscriptionSelection & { fundingSource: "wallet" }) | null =
		attempt
			? attempt.selection
			: source?.mode === "new" && fundingSource === "wallet" && supportedTerm && selectedOffer
				? { planSlug, billingTermMonths: supportedTerm, fundingSource: "wallet" }
				: null;
	// Quoted live for a new request, or a saved one no send of which can still charge.
	const quoting = walletSelection !== null && (!attempt || subscriptionAttemptNeedsQuote(attempt));
	const quoteKey = accountQueryKey(
		scope,
		"subscription-quote",
		walletSelection?.planSlug,
		walletSelection?.billingTermMonths,
	);
	const fetchWalletQuote = async (
		selection: HostedDeploySubscriptionSelection,
		signal?: AbortSignal,
	): Promise<HostedDeploySubscriptionQuote> => {
		if (!compute) throw new Error("Compute API unavailable");
		const quoted = await read(
			(s) => compute.quoteSubscription(buildHostedDeploySubscriptionQuoteRequest(selection), s),
			signal,
		);
		const canonical = canonicalWalletQuote(quoted, selection.planSlug);
		if (!canonical || canonical.billing_term_months !== selection.billingTermMonths)
			throw new Error("Invalid wallet quote");
		return canonical;
	};
	const quote = useQuery({
		queryKey: quoteKey,
		queryFn: ({ signal }) => {
			if (!walletSelection) throw new Error("Quote unavailable");
			return fetchWalletQuote(walletSelection, signal);
		},
		// Like Web, the shown quote is not refreshed under an in-flight confirmation.
		enabled:
			scope.isReady && Boolean(compute) && quoting && model.canCreateCloudAgents && !action.busy,
		staleTime: 30_000,
		retry: false,
	});
	const shownQuote = quoting ? (quote.data ?? null) : (attempt?.walletQuote ?? null);
	const walletDebit = shownQuote ? hostedSubscriptionQuoteWalletDebit(shownQuote) : null;
	const shortfall = walletDebitShortfallUsd(walletDebit);
	const controls = attempt ? subscriptionAttemptControls(attempt) : null;
	const checkStatus = controls?.checkStatus === true;

	const current = (owns: () => boolean) => owns() && scope.isCurrent() && !scope.signal.aborted;
	const finish = async (notice: Notice) => {
		await Promise.all(
			ACTIVATION_READS.map((key) =>
				cache.invalidateQueries({ queryKey: accountQueryKey(scope, key) }),
			),
		);
		await sheet.close(notice);
	};
	const showSendError = (saved: SubscriptionAttempt, error: unknown) => {
		// Like Web, a funding refusal asks for a top-up and a fresh quote.
		const funding = hostedWalletFundingErrorKind(
			error instanceof ApiClientError ? error.code : null,
		);
		if (funding !== "other") {
			setWalletFundingRefused(true);
			setMessage(
				funding === "insufficient_balance"
					? {
							title: HOSTED_WALLET_FUNDING_ERROR_COPY.insufficientBalanceTitle,
							description: HOSTED_WALLET_FUNDING_ERROR_COPY.subscription.insufficientBalance,
						}
					: {
							title: HOSTED_WALLET_FUNDING_ERROR_COPY.refundDebtTitle,
							description: HOSTED_WALLET_FUNDING_ERROR_COPY.subscription.refundDebt,
						},
			);
			return;
		}
		setMessage(subscriptionAttemptErrorCopy(saved, error));
	};
	/** The money ordering lives in the controller; the sheet sends and shows. */
	const attemptDeps = (key: string, owns: () => boolean): SubscriptionAttemptDeps => ({
		journal: subscriptionAttempts,
		storageKey: key,
		isCurrent: () => current(owns),
		onRecord: setAttempt,
		// The journaled request, sent byte for byte on every send and replay.
		activate: (saved) =>
			read((s) => {
				if (!compute || !current(owns)) throw new Error("Subscription action expired");
				return compute.activateDeploymentSubscription(
					{
						deploymentId: saved.deploymentId,
						subscriptionSelection: { mode: "new" },
						selection: saved.selection,
						idempotencyKey: saved.idempotencyKey,
						quote: saved.walletQuote,
					},
					s,
				);
			}),
	});
	const showStep = async (step: SubscriptionAttemptStep) => {
		if (step.kind === "stale") return;
		if (step.kind === "failed") {
			setAttempt(step.attempt);
			showSendError(step.attempt, step.error);
			return;
		}
		if (step.kind === "released") {
			setAttempt(step.attempt);
			setMessage({ title: t("creation.walletNotFound") });
			return;
		}
		setAttempt(null);
		setWalletFundingRefused(false);
		const debit = hostedSubscriptionQuoteWalletDebit(step.attempt.walletQuote);
		await finish({
			title: copy.startedTitle,
			description: copy.walletPaidDescription(
				debit
					? formatUsdExact(debit.debitAmountUsd)
					: formatCents(step.attempt.walletQuote.term_price_cents),
			),
		});
	};
	const assign = async (row: ReusableSubscription, owns: () => boolean) => {
		const selection = existingSubscriptionCreateSelection(row);
		if (!compute || !selection) return;
		if (assignment.current?.subscriptionId !== row.subscription_id)
			assignment.current = { subscriptionId: row.subscription_id, key: Crypto.randomUUID() };
		const key = assignment.current.key;
		try {
			await read((s) =>
				compute.activateDeploymentSubscription(
					{
						deploymentId,
						subscriptionSelection: { mode: "existing", subscription_id: row.subscription_id },
						selection,
						idempotencyKey: key,
						quote: null,
					},
					s,
				),
			);
		} catch (error) {
			if (!current(owns)) return;
			const code = error instanceof ApiClientError ? error.code : null;
			if (code === "reusable_subscription_unavailable") {
				assignment.current = null;
				setSelected(null);
				await reusable.refetch();
				setMessage({ title: copy.unavailableTitle, description: copy.unavailableDescription });
				return;
			}
			if (code === "idempotency_key_reused") assignment.current = null;
			setMessage({ title: copy.failedTitle, description: billingErrorCopy(requestFailure(error)) });
			return;
		}
		assignment.current = null;
		if (current(owns))
			await finish({ title: copy.assignedTitle, description: copy.assignedDescription });
	};
	const submit = () =>
		action.run(async (owns) => {
			if (!compute || !source || !current(owns)) return;
			setMessage(null);
			if (attempt?.submission === "uncertain") {
				if (storageKey)
					await showStep(await replaySubscriptionAttempt(attempt, attemptDeps(storageKey, owns)));
				return;
			}
			// Refresh access at the explicit mutation boundary, like Web's recheck.
			const capabilities = await read((s) => compute.getProductCapabilities(s));
			if (!current(owns)) return;
			if (capabilities.can_use_v2 !== true) {
				setMessage({ title: copy.temporarilyUnavailable });
				return;
			}
			if (source.mode === "existing") {
				if (selectedReusable) await assign(selectedReusable, owns);
				return;
			}
			if (!walletSelection || !storageKey || storage !== "ready") return;
			// Confirm only the terms the user saw: re-quote, then persist that fresh quote.
			let fresh: HostedDeploySubscriptionQuote;
			try {
				fresh = await fetchWalletQuote(walletSelection);
			} catch (error) {
				if (current(owns)) {
					setMessage({
						title: copy.quoteFailed,
						description: billingErrorCopy(requestFailure(error)),
					});
					void quote.refetch();
				}
				return;
			}
			if (!current(owns)) return;
			cache.setQueryData(quoteKey, fresh);
			if (walletQuoteConfirmation(shownQuote, fresh) === "changed") {
				setMessage({ title: t("creation.walletQuoteChanged") });
				return;
			}
			setWalletFundingRefused(false);
			// A saved request keeps its key, hosted's replay identity, under the fresh quote.
			const next: SubscriptionAttempt = attempt
				? { ...attempt, walletQuote: fresh }
				: {
						version: 1,
						submission: "prepared",
						deploymentId,
						idempotencyKey: Crypto.randomUUID(),
						selection: walletSelection,
						uiMode: "custom",
						walletQuote: fresh,
					};
			await showStep(
				await confirmSubscriptionAttempt(attempt, next, attemptDeps(storageKey, owns)),
			);
		});
	const discard = () =>
		action.run(async (owns) => {
			if (!attempt || !storageKey || !subscriptionAttemptControls(attempt).discard) return;
			await subscriptionAttempts.clearAttempt(storageKey, attempt, () => current(owns));
			if (!current(owns)) return;
			setAttempt(null);
			setSelected(null);
			setMessage(null);
			setWalletFundingRefused(false);
		});

	// The sheet offers a new subscription only while the Agent needs one; a saved request
	// always stays reachable so it can be checked or discarded.
	const offered = model.canOfferStartNew || attempt !== null;
	const locked = action.busy || attempt !== null;
	const submitLabel = checkStatus
		? t(action.busy ? "storeCompute.checkingStatus" : "creation.recover")
		: !model.canCreateCloudAgents
			? copy.temporarilyUnavailable
			: source?.mode === "existing"
				? copy.useSubscription
				: walletDebit
					? copy.payFromWallet(formatUsdExact(walletDebit.debitAmountUsd))
					: copy.reviewWalletQuote;
	const submitDisabled =
		action.busy ||
		(!checkStatus &&
			(!model.canCreateCloudAgents ||
				!source ||
				(source.mode === "existing" &&
					(!selectedReusable || reusable.isFetching || reusable.error != null)) ||
				(source.mode === "new" &&
					(storage !== "ready" ||
						!walletSelection ||
						!walletDebit ||
						(quoting && quote.isError) ||
						shortfall !== null))));
	const showTopUp = source?.mode === "new" && (shortfall !== null || walletFundingRefused);

	return (
		<SheetPage
			title={copy.title}
			description={copy.description}
			fallback={agentSectionHref(agentId, "settings")}
			busy={action.busy}
			sheet={sheet}
		>
			<AppView className="gap-5">
				{storage === "error" ? (
					<Text className="text-destructive">{t("creation.storageError")}</Text>
				) : null}
				{!offered ? (
					<Text className="text-muted-foreground">
						{model.createUnavailableMessage ?? copy.temporarilyUnavailable}
					</Text>
				) : null}
				{offered ? (
					<WebView recipe={pickerStyles.root}>
						<WebView recipe={ENTITY_CHOICE_GRID_CLASS}>
							{selectable.map((item) => (
								<ReusableSubscriptionChoice
									key={item.subscription_id}
									subscription={item}
									selected={
										source?.mode === "existing" && source.subscriptionId === item.subscription_id
									}
									disabled={locked || reusable.isFetching || reusable.error != null}
									onSelect={() =>
										setSelected({ mode: "existing", subscriptionId: item.subscription_id })
									}
								/>
							))}
							{/* Like Web, the picker is hidden when a new subscription is the only choice. */}
							{source?.mode !== "new" ||
							reusable.isFetching ||
							reusable.error != null ||
							selectable.length > 0 ? (
								<EntityChoiceCard
									selected={source?.mode === "new"}
									disabled={locked || reusable.isFetching || reusable.error != null}
									onClick={() => setSelected({ mode: "new" })}
									icon={
										<IconChip size="sm">
											<Icon as={Plus} />
										</IconChip>
									}
									title={subscriptionSourceCopy.newTitle}
									description={subscriptionSourceCopy.newDescription}
									className={webView(pickerStyles.choice)}
								/>
							) : null}
						</WebView>
						{reusable.isFetching && !attempt ? (
							<WebText recipe={pickerStyles.loading}>{subscriptionSourceCopy.checking}</WebText>
						) : reusable.error != null ? (
							<ApiErrorPanel
								error={reusable.error}
								onRetry={() => void reusable.refetch()}
								title={subscriptionSourceCopy.loadFailed}
							/>
						) : null}
					</WebView>
				) : null}
				{offered && storeBuild && !attempt ? (
					<StoreUpgradeAction deployment={deployment} recoveryTarget={model.recoveryTarget} />
				) : null}
				{offered && source?.mode === "new" ? (
					<AppView className="gap-4">
						<PlanField
							label={copy.computePlan}
							value={planSlug}
							plans={plans}
							requirePlan
							disabled={locked}
							onChange={(next) => {
								const nextOffers = offersForPlan(planForSlug(plans, next), next);
								setPlanChoice(next);
								setTermChoice(
									nextOffers.find((offer) => offer.billing_term_months === billingTermMonths)
										?.billing_term_months ??
										nextOffers[0]?.billing_term_months ??
										billingTermMonths,
								);
							}}
						/>
						<TermField
							label={copy.billingTerm}
							offers={offers}
							value={billingTermMonths}
							disabled={locked}
							onChange={setTermChoice}
						/>
						<FundingField
							label={copy.fundingSource}
							sources={fundingSources}
							value={fundingSource}
							disabled={locked}
							onChange={setFundingSource}
						/>
						{selectedOffer && selectedPrice ? (
							<AppView className="gap-1">
								<Text className="text-sm text-muted-foreground">
									{computeTierLabel(planSlug)} · {billingTermLabel(billingTermMonths)}
								</Text>
								<Text className="text-base font-semibold text-foreground tabular-nums">
									{selectedPrice.primary}
								</Text>
								<Text className="text-xs text-muted-foreground tabular-nums">
									{selectedPrice.secondary}
								</Text>
							</AppView>
						) : attempt ? null : (
							<Alert variant="destructive" icon={TriangleAlert} title={copy.priceUnavailableTitle}>
								{copy.priceUnavailableDescription}
							</Alert>
						)}
						{quoting && quote.isPending && !quote.data ? (
							<Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
								{copy.gettingQuote}
							</Text>
						) : quoting && quote.isError ? (
							<ApiErrorPanel
								error={quote.error}
								onRetry={() => void quote.refetch()}
								title={copy.quoteFailed}
							/>
						) : walletDebit ? (
							<WalletDebitEquation debit={walletDebit} />
						) : null}
						{showTopUp ? (
							<Alert
								variant="destructive"
								icon={TriangleAlert}
								title={copy.insufficientBalanceTitle}
							>
								<AppView className="items-start gap-3">
									<Text>{copy.insufficientBalanceDescription}</Text>
									<WalletTopUpAction size="sm" />
								</AppView>
							</Alert>
						) : null}
					</AppView>
				) : null}
				{attempt ? (
					<Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
						{t(
							attempt.submission === "uncertain"
								? "subscriptionSheet.unconfirmed"
								: "subscriptionSheet.saved",
						)}
					</Text>
				) : null}
				{message ? (
					<AppView accessibilityLiveRegion="polite" className="gap-0.5">
						<Text className="font-medium text-foreground">{message.title}</Text>
						{message.description ? (
							<Text className="text-muted-foreground">{message.description}</Text>
						) : null}
					</AppView>
				) : null}
				{action.error ? (
					<Text accessibilityRole="alert" className="text-destructive">
						{billingErrorCopy(requestFailure(action.failure))}
					</Text>
				) : null}
				{offered ? (
					<AppView className="gap-2">
						<Button disabled={submitDisabled} onPress={() => void submit()}>
							{source?.mode === "existing" || checkStatus ? null : <Icon as={WalletCards} />}
							<Text>{submitLabel}</Text>
						</Button>
						{controls?.discard ? (
							<Button variant="ghost" disabled={action.busy} onPress={() => void discard()}>
								<Text>{t("subscriptionSheet.discard")}</Text>
							</Button>
						) : null}
					</AppView>
				) : null}
			</AppView>
		</SheetPage>
	);
}

/** Web's `ExistingSubscriptionChoice`: one reusable card or Wallet subscription. */
function ReusableSubscriptionChoice({
	subscription,
	selected,
	disabled,
	onSelect,
}: {
	subscription: ReusableSubscription;
	selected: boolean;
	disabled: boolean;
	onSelect: () => void;
}) {
	const view = reusableSubscriptionChoiceView(subscription);
	const performance = subscription.plan_slug === "compute_performance";
	return (
		<EntityChoiceCard
			selected={selected}
			disabled={disabled}
			onClick={onSelect}
			icon={
				<IconChip
					size="sm"
					tint={
						performance
							? "bg-identity-8-bg text-identity-8-fg"
							: "bg-identity-3-bg text-identity-3-fg"
					}
				>
					<Icon as={performance ? Zap : Cpu} />
				</IconChip>
			}
			title={view.title}
			description={view.description}
			badge={
				<StatusBadge status={view.status.tone}>
					<Text>{view.status.label}</Text>
				</StatusBadge>
			}
			detailsPlacement="responsive"
			details={
				// RN has no CSS grid: facts wrap at just under half width, like the deploy wizard.
				<WebView recipe={pickerStyles.existingFacts} className="flex-row flex-wrap">
					{view.facts.map((fact) => (
						<WebView key={fact.id} recipe={pickerStyles.fact} className="basis-[45%] grow">
							<WebText recipe={pickerStyles.factLabel}>{fact.label}</WebText>
							{fact.id === "payment" ? (
								<WebView recipe={pickerStyles.payment} className="flex-row">
									<WebIcon
										as={
											view.payment.kind === "store"
												? Smartphone
												: view.payment.kind === "wallet"
													? WalletCards
													: CreditCard
										}
										recipe={pickerStyles.paymentIcon}
									/>
									<WebText recipe={pickerStyles.price}>{fact.value}</WebText>
								</WebView>
							) : (
								<WebText
									recipe={fact.id === "price" ? pickerStyles.nowrap : pickerStyles.factValue}
								>
									{fact.value}
								</WebText>
							)}
						</WebView>
					))}
				</WebView>
			}
			className={webView(pickerStyles.choice)}
		/>
	);
}
