import {
	ApiClientError,
	type ComputePlanChangeQuoteResponse,
	type ComputePlanChangeResult,
	HOSTED_WALLET_FUNDING_ERROR_COPY,
	hostedWalletFundingErrorKind,
	type PlanChangeOutcome,
} from "@clawdi/shared/api";
import {
	agentSectionHref,
	appComputeActions,
	billingErrorCopy,
	billingTermLabel,
	computeTierLabel,
	planChangeCopy as copy,
	defaultPlanChangeSelection,
	formatCents,
	formatShortDate,
	formatUsdExact,
	fundingSourcesFor,
	isCombinedPaidPlanChange,
	isFundingSourceOnlySelection,
	isFundingSourceSwitchQuote,
	isSamePlanChangeSelection,
	isValidFundingSourceSwitchQuote,
	isValidPaidPlanChangeQuote,
	isWalletToCardSwitchSelection,
	type PlanChangeManagementMode,
	type PlanChangeSelection,
	type PlanChangeTarget,
	planChangeDialogStep,
	planChangeManagementModes,
	planChangeNeedsOffer,
	planChangeNeedsWalletBalance,
	planChangeTargetFingerprint,
	selectPlanChangeFundingSource,
	selectPlanChangeOffer,
	shouldResetUnacceptedPlanChangeQuote,
	subscriptionCreateCopy,
	visiblePlanChangeOperationName,
	walletBalanceAfterDebit,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { openBrowserAsync } from "expo-web-browser";
import CalendarClock from "lucide-react-native/icons/calendar-clock";
import CreditCard from "lucide-react-native/icons/credit-card";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import WalletCards from "lucide-react-native/icons/wallet-cards";
import { useEffect, useMemo, useState } from "react";
import { Alert as NativeAlert } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { useAgentDeployment, useComputePlanModel } from "@/hosted/agents/compute-plan-model";
import { WalletDebitEquation } from "@/hosted/billing/components/wallet-debit-equation";
import { useWallet } from "@/hosted/billing/hooks";
import {
	FundingField,
	offersForPlan,
	PlanField,
	planForSlug,
	TermField,
} from "@/hosted/billing/subscription/subscription-sheet-controls";
import { WalletTopUpAction } from "@/hosted/billing/wallet/balance-card";
import { useMobileApi } from "@/lib/api-provider";
import { requestFailure } from "@/lib/request-failure";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { NativeSegments } from "@/platform/navigation/segmented-control";
import { useSheet } from "@/platform/navigation/use-sheet";
import { useStoreSurfaces } from "@/platform/store/store-provider";

type Notice = { title: string; description?: string };

/** Reads a plan change can change, like Web's settled plan-change invalidation. */
const PLAN_CHANGE_READS = [
	"deployments",
	"deployment",
	"billing-subscriptions",
	"billing-reusable",
	"billing-wallet",
	"billing-transactions",
] as const;

function isPaymentMethodRequired(error: unknown): boolean {
	return error instanceof ApiClientError && error.code === "payment_method_required";
}

/** Web's notice for a settled plan change. */
export function planChangeResultNotice(result: ComputePlanChangeResult): Notice {
	if (result.kind === "scheduled")
		return {
			title: copy.downgradeScheduledTitle,
			description: copy.downgradeScheduledDescription(formatShortDate(result.effectiveAt)),
		};
	if (result.changeKind === "funding_source_switch")
		return {
			title: copy.paymentMethodUpdatedTitle,
			description: copy.paymentMethodUpdatedDescription(result.fundingSource),
		};
	return { title: copy.planChangedTitle, description: copy.planChangedDescription };
}

/** `/agents/[id]/plan`: Web's plan-change controller and dialog for an Agent's subscription. */
export default function PlanChangeRoute() {
	const scope = useAccountScope();
	const agentId = routeParam(useLocalSearchParams<{ id?: string | string[] }>().id);
	const agent = useAgentDeployment(agentId);
	const model = useComputePlanModel(agent.deployment);
	const surfaces = useStoreSurfaces();
	// The same policy that shows Upgrade/Manage/Check status: a store build never opens
	// this sheet for a card row, even by route.
	const offered = appComputeActions(
		!surfaces.cardBilling,
		{ fundingSource: model.fundingSource },
		model.actions,
	).some(
		(action) =>
			action.kind === "manage" || action.kind === "upgrade" || action.kind === "check_change",
	);
	const target = offered ? model.management.target : null;
	if (!agentId || !agent.deployment)
		return (
			<SheetPage
				title={copy.changeTitle}
				fallback={agentId ? agentSectionHref(agentId) : "/agents"}
			>
				{agent.error || agent.missing ? (
					<ApiErrorPanel error={agent.error ?? new ApiClientError(404)} onRetry={agent.retry} />
				) : (
					<LoadingScreen />
				)}
			</SheetPage>
		);
	if (!target)
		return (
			<SheetPage title={copy.changeTitle} fallback={agentSectionHref(agentId, "settings")}>
				{model.management.unavailableReason ? (
					<Text className="text-muted-foreground">{model.management.unavailableReason}</Text>
				) : null}
			</SheetPage>
		);
	return (
		<PlanChangeSheet
			key={`${scope.accountKey}:${scope.generation}:${planChangeTargetFingerprint(target)}`}
			agentId={agentId}
			target={target}
			plans={model.plans.data ?? []}
			canCreateCloudAgents={model.canCreateCloudAgents}
		/>
	);
}

function PlanChangeSheet({
	agentId,
	target,
	plans,
	canCreateCloudAgents,
}: {
	agentId: string;
	target: PlanChangeTarget;
	plans: NonNullable<ReturnType<typeof useComputePlanModel>["plans"]["data"]>;
	canCreateCloudAgents: boolean;
}) {
	const cache = useQueryClient();
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const surfaces = useStoreSurfaces();
	const wallet = useWallet();
	const action = useAuthAction(scope);
	const fallback = agentSectionHref(agentId, "settings");
	const sheet = useSheet<Notice>({
		fallback,
		busy: action.busy,
		onResult: async (notice) => NativeAlert.alert(notice.title, notice.description),
	});
	// Store builds never charge a card: the payment source stays Wallet (D-1, card half).
	const fundingSources = fundingSourcesFor(!surfaces.cardBilling, "plan_change");
	const cardAllowed = fundingSources.includes("stripe");
	const deploymentId = target.deploymentId.trim();
	const [acceptedOperationName, setAcceptedOperationName] = useState<string | null>(null);
	const [ignoredOperationNames, setIgnoredOperationNames] = useState<readonly string[]>([]);
	const [quote, setQuote] = useState<ComputePlanChangeQuoteResponse | null>(null);
	const [paymentMethodRequired, setPaymentMethodRequired] = useState(false);
	const [walletFundingRefused, setWalletFundingRefused] = useState(false);
	const [message, setMessage] = useState<Notice | null>(null);
	const pendingOperationName =
		acceptedOperationName ??
		visiblePlanChangeOperationName(target.projectedOperationName, ignoredOperationNames);
	const hasUsablePlans = plans.some(
		(plan) =>
			offersForPlan(plan, "compute_basic").length > 0 ||
			offersForPlan(plan, "compute_performance").length > 0,
	);
	const modes = planChangeManagementModes({
		allowCombinedChange: target.allowCombinedChange,
		paymentSourceOnly: target.paymentSourceOnly,
		hasUsablePlans,
	});
	// Without card funding, the only payment-source change left would be to the current one.
	const hasModePicker = modes.hasModePicker && cardAllowed;
	const initialSelection = useMemo(
		() =>
			defaultPlanChangeSelection(
				target.currentPlanSlug,
				target.currentBillingTermMonths,
				cardAllowed ? target.currentFundingSource : "wallet",
				target.initialPlanSlug,
			),
		[
			cardAllowed,
			target.currentBillingTermMonths,
			target.currentFundingSource,
			target.currentPlanSlug,
			target.initialPlanSlug,
		],
	);
	const [selection, setSelection] = useState<PlanChangeSelection>(initialSelection);
	const [managementMode, setManagementMode] = useState<PlanChangeManagementMode>(modes.initialMode);
	// Like Web's dialog, re-sync once the plan catalog arrives: a cold open starts without
	// plans, which alone would leave only the payment-source mode.
	useEffect(() => {
		setSelection(initialSelection);
		setManagementMode(modes.initialMode);
	}, [initialSelection, modes.initialMode]);
	const paymentSourceMode = target.paymentSourceOnly || managementMode === "payment-source";
	const step = planChangeDialogStep({
		hasAcceptedChange: pendingOperationName !== null,
		hasQuote: quote !== null,
		paymentMethodRequired,
	});
	const offers = offersForPlan(
		planForSlug(plans, selection.target_plan_slug),
		selection.target_plan_slug,
	);
	const selectedOffer = offers.find(
		(offer) => offer.billing_term_months === selection.target_billing_term_months,
	);
	const walletBalanceUsd = wallet.data?.balance_usd ?? null;
	const noChange = isSamePlanChangeSelection(
		selection,
		target.currentPlanSlug,
		target.currentBillingTermMonths,
		target.currentFundingSource,
	);
	const offerReady =
		!planChangeNeedsOffer(selection, target.currentPlanSlug, target.currentBillingTermMonths) ||
		selectedOffer !== undefined;
	const walletReady =
		!planChangeNeedsWalletBalance(
			selection,
			target.currentPlanSlug,
			target.currentBillingTermMonths,
		) || walletBalanceUsd !== null;

	const fundingSourceSwitch = isFundingSourceSwitchQuote(quote);
	const quoteFundingSource =
		quote?.funding_source === "stripe" || quote?.funding_source === "wallet"
			? quote.funding_source
			: selection.funding_source;
	const walletBalanceAfter =
		!fundingSourceSwitch && quoteFundingSource === "wallet" && quote?.amount_usd && walletBalanceUsd
			? walletBalanceAfterDebit(walletBalanceUsd, quote.amount_usd)
			: null;
	const walletInsufficient = walletBalanceAfter?.startsWith("-") ?? false;
	const walletQuoteMissingAmount =
		quoteFundingSource === "wallet" &&
		!fundingSourceSwitch &&
		quote?.change_kind === "immediate_upgrade" &&
		!quote.amount_usd;
	const invalidFundingSourceSwitchQuote =
		fundingSourceSwitch &&
		quote !== null &&
		!isValidFundingSourceSwitchQuote(
			quote,
			selection,
			target.currentPlanSlug,
			target.currentBillingTermMonths,
			target.currentFundingSource,
		);

	const current = (owns: () => boolean) => owns() && scope.isCurrent() && !scope.signal.aborted;
	const ignoreOperation = (operationName: string | null) => {
		if (operationName === null) return;
		setIgnoredOperationNames((names) =>
			names.includes(operationName) ? names : [...names, operationName],
		);
	};
	const refresh = () =>
		Promise.all(
			PLAN_CHANGE_READS.map((key) =>
				cache.invalidateQueries({ queryKey: accountQueryKey(scope, key) }),
			),
		);
	const fundingRefusal = (code: string | null | undefined) => {
		const funding = hostedWalletFundingErrorKind(code);
		if (funding === "other") return false;
		setWalletFundingRefused(true);
		setMessage({
			title:
				funding === "insufficient_balance"
					? HOSTED_WALLET_FUNDING_ERROR_COPY.insufficientBalanceTitle
					: HOSTED_WALLET_FUNDING_ERROR_COPY.refundDebtTitle,
			description:
				funding === "insufficient_balance"
					? copy.walletFunding.insufficientBalance
					: copy.walletFunding.refundDebt,
		});
		return true;
	};
	/** Web's handling of an accepted change's reading. */
	const handleOutcome = async (outcome: PlanChangeOutcome, owns: () => boolean) => {
		if (!current(owns)) return;
		if (outcome.kind === "settled") {
			setAcceptedOperationName(null);
			ignoreOperation(outcome.operationName);
			setQuote(null);
			setPaymentMethodRequired(false);
			await refresh();
			await sheet.close(planChangeResultNotice(outcome.result));
			return;
		}
		if (outcome.kind === "pending") {
			setAcceptedOperationName(outcome.operationName);
			setMessage({ title: copy.stillWaitingTitle, description: copy.stillWaitingNotice });
			return;
		}
		setAcceptedOperationName(null);
		ignoreOperation(outcome.operationName);
		setQuote(null);
		setPaymentMethodRequired(false);
		void refresh();
		const problemCode = typeof outcome.problem?.code === "string" ? outcome.problem.code : null;
		if (
			outcome.fundingSource === "stripe" &&
			outcome.changeKind === "funding_source_switch" &&
			(problemCode === "payment_method_required" ||
				outcome.problem?.detail === "payment_method_required")
		) {
			setPaymentMethodRequired(true);
			return;
		}
		if (fundingRefusal(problemCode)) return;
		setMessage({
			title: copy.updateFailed,
			description: billingErrorCopy({
				kind: "response",
				status: outcome.problem?.status ?? 409,
				code: problemCode,
			}),
		});
	};
	const handleError = (error: unknown) => {
		// Like Web: hosted refused a not-yet-accepted change because its quote expired.
		if (
			error instanceof ApiClientError &&
			shouldResetUnacceptedPlanChangeQuote({
				status: error.status,
				detail: error.detail,
				terminal: false,
			})
		) {
			setQuote(null);
			setPaymentMethodRequired(false);
			setMessage({ title: copy.quoteStaleTitle, description: copy.quoteStaleDescription });
			return;
		}
		if (fundingRefusal(error instanceof ApiClientError ? error.code : null)) return;
		setMessage({ title: copy.updateFailed, description: billingErrorCopy(requestFailure(error)) });
	};
	const recheckAccess = async (owns: () => boolean) => {
		if (!compute) return false;
		const capabilities = await read((s) => compute.getProductCapabilities(s));
		if (!current(owns)) return false;
		if (capabilities.can_use_v2 === true) return true;
		setMessage({ title: subscriptionCreateCopy.temporarilyUnavailable });
		return false;
	};
	const requestQuote = () =>
		action.run(async (owns) => {
			if (!compute || !deploymentId || !canCreateCloudAgents) return;
			setMessage(null);
			if (
				target.paymentSourceOnly &&
				!isFundingSourceOnlySelection(
					selection,
					target.currentPlanSlug,
					target.currentBillingTermMonths,
					target.currentFundingSource,
				)
			) {
				setMessage({
					title: copy.paymentSourceOnlyTitle,
					description: copy.paymentSourceOnlyDescription,
				});
				return;
			}
			if (
				target.isPaidCompute &&
				isCombinedPaidPlanChange(
					selection,
					target.currentPlanSlug,
					target.currentBillingTermMonths,
					target.currentFundingSource,
				)
			) {
				setMessage({ title: copy.oneChangeTitle, description: copy.oneChangeDescription });
				return;
			}
			if (pendingOperationName === null && !(await recheckAccess(owns))) return;
			let next: ComputePlanChangeQuoteResponse;
			try {
				next = await read((s) =>
					compute.quotePlanChange({ deployment_id: deploymentId, ...selection }, s),
				);
			} catch (error) {
				if (!current(owns)) return;
				if (
					target.isPaidCompute &&
					isWalletToCardSwitchSelection(
						selection,
						target.currentPlanSlug,
						target.currentBillingTermMonths,
						target.currentFundingSource,
					) &&
					isPaymentMethodRequired(error)
				) {
					setQuote(null);
					setAcceptedOperationName(null);
					setPaymentMethodRequired(true);
					return;
				}
				setMessage({
					title: copy.quoteFailed,
					description: billingErrorCopy(requestFailure(error)),
				});
				return;
			}
			if (!current(owns)) return;
			if (
				target.isPaidCompute &&
				!isValidPaidPlanChangeQuote(
					next,
					selection,
					target.currentPlanSlug,
					target.currentBillingTermMonths,
					target.currentFundingSource,
				)
			) {
				setQuote(null);
				setAcceptedOperationName(null);
				setPaymentMethodRequired(false);
				setMessage({
					title: copy.quoteMismatchTitle,
					description: copy.quoteMismatchDescription,
				});
				return;
			}
			setAcceptedOperationName(null);
			setPaymentMethodRequired(false);
			setWalletFundingRefused(false);
			setQuote(next);
		});
	/** Accepts the quote with `Idempotency-Key = operation_id`; a repeat replays it. */
	const confirm = (operationId: string) =>
		action.run(async (owns) => {
			if (!compute || !quote) return;
			setMessage(null);
			if (!(await recheckAccess(owns))) return;
			let outcome: PlanChangeOutcome;
			try {
				outcome = await read((s) =>
					compute.changePlan(
						{ operation_id: operationId },
						{
							signal: s,
							onAccepted: (name) => {
								if (current(owns)) setAcceptedOperationName(name);
							},
						},
					),
				);
			} catch (error) {
				if (current(owns)) handleError(error);
				return;
			}
			await handleOutcome(outcome, owns);
		});
	/** Re-reads the accepted operation; never resubmits or charges. */
	const checkStatus = () =>
		action.run(async (owns) => {
			if (!compute || !pendingOperationName) return;
			setMessage(null);
			let outcome: PlanChangeOutcome;
			try {
				outcome = await read((s) => compute.checkPlanChange(pendingOperationName, s));
			} catch (error) {
				if (current(owns)) handleError(error);
				return;
			}
			await handleOutcome(outcome, owns);
		});
	const openPaymentMethods = () =>
		action.run(async (owns) => {
			if (!compute || !cardAllowed) return;
			ignoreOperation(pendingOperationName);
			setQuote(null);
			setPaymentMethodRequired(false);
			setAcceptedOperationName(null);
			try {
				const result = await read((s) =>
					compute.openBillingPortal({ return_context: "compute" }, s),
				);
				const url = result.url || result.portal_url;
				if (!current(owns)) return;
				if (!url) {
					setPaymentMethodRequired(true);
					setMessage({
						title: copy.portalUnavailableTitle,
						description: copy.portalUnavailableDescription,
					});
					return;
				}
				await openBrowserAsync(url);
			} catch (error) {
				if (!current(owns)) return;
				setPaymentMethodRequired(true);
				setMessage({
					title: copy.openBillingFailed,
					description: billingErrorCopy(requestFailure(error)),
				});
			}
		});
	const updateManagementMode = (next: PlanChangeManagementMode) => {
		setManagementMode(next);
		setSelection(
			next === "payment-source"
				? {
						target_plan_slug: target.currentPlanSlug,
						target_billing_term_months: target.currentBillingTermMonths,
						funding_source: target.currentFundingSource,
					}
				: initialSelection,
		);
	};

	const title =
		step === "pending"
			? copy.pendingTitle
			: step === "payment_method_required"
				? copy.cardRequiredStepTitle
				: step === "quote"
					? copy.quoteTitle(quote)
					: target.paymentSourceOnly
						? copy.changePaymentSourceTitle
						: hasModePicker
							? copy.manageTitle
							: copy.changeTitle;
	const description =
		step === "pending"
			? copy.pendingDescription
			: step === "payment_method_required"
				? copy.cardRequiredStepDescription
				: step === "quote" && quote
					? fundingSourceSwitch
						? copy.fundingSwitchQuoteDescription(quoteFundingSource)
						: quote.change_kind === "immediate_upgrade"
							? copy.upgradeQuoteDescription
							: copy.downgradeQuoteDescription(formatShortDate(quote.effective_at))
					: paymentSourceMode
						? copy.paymentSourceModeDescription
						: target.allowCombinedChange && cardAllowed
							? copy.combinedSelectionDescription
							: copy.planSelectionDescription;

	return (
		<SheetPage
			title={title}
			description={description}
			fallback={fallback}
			busy={action.busy}
			sheet={sheet}
		>
			<AppView className="gap-5">
				{step === "pending" ? (
					<>
						<Alert icon={CalendarClock} title={copy.stillWaitingTitle}>
							{copy.stillWaitingDescription}
						</Alert>
						<Button disabled={action.busy} onPress={() => void checkStatus()}>
							<Icon as={RefreshCw} />
							<Text>{action.busy ? copy.checkingStatus : copy.checkStatus}</Text>
						</Button>
					</>
				) : step === "payment_method_required" ? (
					<>
						<Alert variant="destructive" icon={CreditCard} title={copy.cardRequiredTitle}>
							{copy.cardRequiredDescription}
						</Alert>
						{cardAllowed ? (
							<Button disabled={action.busy} onPress={() => void openPaymentMethods()}>
								<Icon as={CreditCard} />
								<Text>{copy.managePaymentMethods}</Text>
							</Button>
						) : null}
					</>
				) : step === "quote" && quote ? (
					<>
						<AppView className="gap-3 rounded-lg border border-border bg-muted/20 p-3">
							<AppView>
								<Text className="text-xs text-muted-foreground">
									{fundingSourceSwitch ? copy.subscription : copy.newSubscription}
								</Text>
								<Text className="font-medium">
									{computeTierLabel(
										quote.target_plan_slug === "compute_basic" ||
											quote.target_plan_slug === "compute_performance"
											? quote.target_plan_slug
											: null,
									)}{" "}
									· {billingTermLabel(quote.target_billing_term_months)}
								</Text>
							</AppView>
							{fundingSourceSwitch ? (
								<>
									<AppView>
										<Text className="text-xs text-muted-foreground">{copy.paymentSource}</Text>
										<Text className="font-medium">
											{quoteFundingSource === "wallet" ? copy.wallet : copy.card}
										</Text>
									</AppView>
									<AppView>
										<Text className="text-xs text-muted-foreground">{copy.dueNow}</Text>
										<Text className="font-medium tabular-nums">
											{formatCents(quote.amount_cents)}
										</Text>
									</AppView>
								</>
							) : (
								<AppView>
									<Text className="text-xs text-muted-foreground">
										{quote.change_kind === "immediate_upgrade" ? copy.dueNow : copy.effectiveDate}
									</Text>
									<Text className="font-medium tabular-nums">
										{quote.change_kind === "immediate_upgrade"
											? quoteFundingSource === "wallet"
												? quote.amount_usd
													? formatUsdExact(quote.amount_usd)
													: "—"
												: formatCents(quote.amount_cents)
											: formatShortDate(quote.effective_at)}
									</Text>
								</AppView>
							)}
						</AppView>
						{fundingSourceSwitch ? (
							<Alert
								icon={quoteFundingSource === "wallet" ? WalletCards : CreditCard}
								title={copy.futureRenewalsUse(quoteFundingSource)}
							>
								{copy.fundingSwitchDescription(quoteFundingSource)}
							</Alert>
						) : null}
						{quoteFundingSource === "wallet" &&
						quote.change_kind === "immediate_upgrade" &&
						quote.amount_usd &&
						walletBalanceUsd &&
						walletBalanceAfter ? (
							<WalletDebitEquation
								debit={{
									balanceBeforeUsd: walletBalanceUsd,
									debitAmountUsd: quote.amount_usd,
									balanceAfterUsd: walletBalanceAfter,
								}}
							/>
						) : null}
						{quote.change_kind === "scheduled_downgrade" ? (
							<Alert icon={CalendarClock} title={copy.noChargeTodayTitle}>
								{copy.noChargeTodayDescription}
							</Alert>
						) : null}
						{walletInsufficient || walletFundingRefused ? (
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
						{walletQuoteMissingAmount ? (
							<Alert
								variant="destructive"
								icon={TriangleAlert}
								title={copy.walletQuoteIncompleteTitle}
							>
								{copy.walletQuoteIncompleteDescription}
							</Alert>
						) : null}
						{invalidFundingSourceSwitchQuote ? (
							<Alert
								variant="destructive"
								icon={TriangleAlert}
								title={copy.invalidSwitchQuoteTitle}
							>
								{copy.invalidSwitchQuoteDescription}
							</Alert>
						) : null}
						<AppView className="gap-2">
							<Button
								disabled={
									action.busy ||
									walletInsufficient ||
									walletQuoteMissingAmount ||
									invalidFundingSourceSwitchQuote
								}
								onPress={() => void confirm(quote.operation_id)}
							>
								<Icon as={quoteFundingSource === "wallet" ? WalletCards : CreditCard} />
								<Text>{action.busy ? copy.busyLabel(quote) : copy.confirmLabel(quote)}</Text>
							</Button>
							<Button
								variant="ghost"
								disabled={action.busy}
								onPress={() => {
									setQuote(null);
									setMessage(null);
									setWalletFundingRefused(false);
								}}
							>
								<Text>{copy.back}</Text>
							</Button>
						</AppView>
					</>
				) : (
					<>
						{hasModePicker ? (
							<NativeSegments
								value={managementMode}
								options={[
									...(modes.planBillingAvailable
										? [{ value: "plan-billing", label: copy.planAndBilling }]
										: []),
									{ value: "payment-source", label: copy.paymentSource },
								]}
								disabled={action.busy}
								onChange={(next) => {
									if (next === "plan-billing" || next === "payment-source")
										updateManagementMode(next);
								}}
							/>
						) : null}
						{paymentSourceMode ? (
							<AppView className="gap-3 border-y border-border py-3">
								<AppView>
									<Text className="text-xs text-muted-foreground">{copy.currentPlan}</Text>
									<Text className="font-medium">{computeTierLabel(target.currentPlanSlug)}</Text>
								</AppView>
								<AppView>
									<Text className="text-xs text-muted-foreground">{copy.billingTerm}</Text>
									<Text className="font-medium">
										{billingTermLabel(target.currentBillingTermMonths)}
									</Text>
								</AppView>
							</AppView>
						) : (
							<AppView className="gap-4">
								<PlanField
									label={copy.computePlan}
									value={selection.target_plan_slug}
									plans={plans}
									disabled={action.busy}
									onChange={(next) => {
										const nextOffers = offersForPlan(planForSlug(plans, next), next);
										const keepsTerm = nextOffers.some(
											(offer) => offer.billing_term_months === selection.target_billing_term_months,
										);
										setSelection(
											selectPlanChangeOffer(
												selection,
												next,
												keepsTerm
													? selection.target_billing_term_months
													: nextOffers[0]?.billing_term_months === 12
														? 12
														: 1,
												target.currentFundingSource,
												target.allowCombinedChange,
											),
										);
									}}
								/>
								<TermField
									label={copy.billingTerm}
									offers={offers}
									value={selection.target_billing_term_months}
									disabled={action.busy}
									onChange={(months) =>
										setSelection((value) =>
											selectPlanChangeOffer(
												value,
												value.target_plan_slug,
												months === 12 ? 12 : 1,
												target.currentFundingSource,
												target.allowCombinedChange,
											),
										)
									}
								/>
							</AppView>
						)}
						{target.allowCombinedChange || paymentSourceMode ? (
							<FundingField
								label={copy.paymentSource}
								sources={fundingSources}
								value={selection.funding_source}
								disabled={action.busy}
								onChange={(next) =>
									setSelection((value) =>
										selectPlanChangeFundingSource(
											value,
											next,
											target.currentPlanSlug,
											target.currentBillingTermMonths,
											target.allowCombinedChange,
										),
									)
								}
							/>
						) : null}
						{selection.funding_source === "wallet" && !walletReady ? (
							<Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
								{copy.loadingWalletBalance}
							</Text>
						) : null}
						{selectedOffer && !paymentSourceMode ? (
							<Text className="text-sm text-muted-foreground">
								{copy.listedPrice(
									formatCents(selectedOffer.price_cents),
									selectedOffer.billing_term_months,
								)}
							</Text>
						) : null}
						<Button
							disabled={action.busy || noChange || !offerReady || !walletReady}
							onPress={() => void requestQuote()}
						>
							<Text>{copy.reviewChange}</Text>
						</Button>
					</>
				)}
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
			</AppView>
		</SheetPage>
	);
}
