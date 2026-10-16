"use client";

import {
	planChangeCopy as copy,
	formatShortDate,
	type PlanChangeManagementMode,
	planChangeDialogStep,
	planChangeManagementModes,
} from "@clawdi/shared/view";
import { CalendarClock, CreditCard, RefreshCw, TriangleAlert, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useDialogExitLifecycle } from "@/components/ui/use-dialog-exit-lifecycle";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import { WalletDebitEquation } from "@/hosted/billing/components/wallet-debit-equation";
import type {
	ComputePlanChangeQuoteRequest,
	ComputePlanChangeQuoteResponse,
	ComputePlanSlug,
	Plan,
} from "@/hosted/billing/contracts";
import { billingTermLabel, formatCents, formatUsdExact } from "@/hosted/billing/format";
import {
	computeTierLabel,
	explicitPlanOffers,
	planOffers,
	resolveBasicPlan,
	resolvePerformancePlan,
} from "@/hosted/billing/subscription/subscription-utils";
import {
	defaultPlanChangeSelection,
	isFundingSourceSwitchQuote,
	isSamePlanChangeSelection,
	isValidFundingSourceSwitchQuote,
	type PlanChangeSelection,
	planChangeNeedsOffer,
	planChangeNeedsWalletBalance,
	selectPlanChangeFundingSource,
	selectPlanChangeOffer,
	walletBalanceAfterDebit,
} from "./plan-change.logic";

const PLAN_ITEMS = [
	{ value: "compute_basic", label: "Basic" },
	{ value: "compute_performance", label: "Performance" },
] as const;

export { planChangeDialogStep, planChangeManagementModes };

type ManagementMode = PlanChangeManagementMode;

function planSlug(value: string | null): ComputePlanSlug | null {
	return value === "compute_basic" || value === "compute_performance" ? value : null;
}

export function PaymentMethodRequiredRecovery({
	isManagingPaymentMethods,
	onClose,
	onManagePaymentMethods,
}: {
	isManagingPaymentMethods: boolean;
	onClose: () => void;
	onManagePaymentMethods: () => void;
}) {
	return (
		<div className="flex flex-col gap-4">
			<Alert variant="destructive">
				<CreditCard aria-hidden />
				<AlertTitle>{copy.cardRequiredTitle}</AlertTitle>
				<AlertDescription>{copy.cardRequiredDescription}</AlertDescription>
			</Alert>
			<DialogFooter>
				<Button variant="ghost" onClick={onClose} disabled={isManagingPaymentMethods}>
					{copy.close}
				</Button>
				<Button onClick={onManagePaymentMethods} disabled={isManagingPaymentMethods}>
					{isManagingPaymentMethods ? (
						<Spinner data-icon="inline-start" />
					) : (
						<CreditCard data-icon="inline-start" />
					)}
					{copy.managePaymentMethods}
				</Button>
			</DialogFooter>
		</div>
	);
}

export function FundingSourceSwitchSummary({
	amountCents,
	fundingSource,
}: {
	amountCents: number;
	fundingSource: PlanChangeSelection["funding_source"];
}) {
	const paymentSourceLabel = fundingSource === "wallet" ? copy.wallet : copy.card;
	return (
		<>
			<div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
				<dl>
					<dt className="text-xs text-muted-foreground">{copy.paymentSource}</dt>
					<dd className="font-medium">{paymentSourceLabel}</dd>
				</dl>
				<dl>
					<dt className="text-xs text-muted-foreground">{copy.dueNow}</dt>
					<dd className="font-medium tabular-nums">{formatCents(amountCents)}</dd>
				</dl>
			</div>
			<Alert>
				{fundingSource === "wallet" ? <WalletCards aria-hidden /> : <CreditCard aria-hidden />}
				<AlertTitle>{copy.futureRenewalsUse(fundingSource)}</AlertTitle>
				<AlertDescription>{copy.fundingSwitchDescription(fundingSource)}</AlertDescription>
			</Alert>
		</>
	);
}

export function PlanChangeDialog({
	open,
	onOpenChange,
	plans,
	currentPlanSlug,
	initialPlanSlug,
	currentBillingTermMonths,
	currentFundingSource,
	quote,
	walletBalanceUsd,
	isQuoting,
	isConfirming,
	hasAcceptedChange,
	onQuote,
	onConfirm,
	onCheckStatus,
	onTopUp,
	allowCombinedChange,
	paymentSourceOnly,
	paymentMethodRequired,
	isManagingPaymentMethods,
	onManagePaymentMethods,
	onExitComplete,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	plans: Plan[];
	currentPlanSlug: ComputePlanSlug;
	initialPlanSlug: ComputePlanSlug;
	currentBillingTermMonths: ComputePlanChangeQuoteRequest["target_billing_term_months"];
	currentFundingSource: PlanChangeSelection["funding_source"];
	quote: ComputePlanChangeQuoteResponse | null;
	walletBalanceUsd: string | null;
	isQuoting: boolean;
	isConfirming: boolean;
	hasAcceptedChange: boolean;
	onQuote: (selection: PlanChangeSelection) => void;
	onConfirm: (operationId: string) => void;
	onCheckStatus: () => void;
	onTopUp?: () => void;
	allowCombinedChange: boolean;
	paymentSourceOnly: boolean;
	paymentMethodRequired: boolean;
	isManagingPaymentMethods: boolean;
	onManagePaymentMethods: () => void;
	onExitComplete?: () => void;
}) {
	const initialSelection = useMemo(
		() =>
			defaultPlanChangeSelection(
				currentPlanSlug,
				currentBillingTermMonths,
				currentFundingSource,
				initialPlanSlug,
			),
		[currentBillingTermMonths, currentFundingSource, currentPlanSlug, initialPlanSlug],
	);
	const hasUsablePlans = plans.some(
		(plan) => explicitPlanOffers(plan).length > 0 || planOffers(plan).length > 0,
	);
	const managementModes = planChangeManagementModes({
		allowCombinedChange,
		paymentSourceOnly,
		hasUsablePlans,
	});
	const [selection, setSelection] = useState(initialSelection);
	const [managementMode, setManagementMode] = useState<ManagementMode>(managementModes.initialMode);
	const exit = useDialogExitLifecycle({ open, value: quote, emptyValue: null });
	const displayedQuote = exit.renderedValue;
	const step = planChangeDialogStep({
		hasAcceptedChange,
		hasQuote: displayedQuote !== null,
		paymentMethodRequired,
	});
	const selectedPlan =
		selection.target_plan_slug === "compute_performance"
			? resolvePerformancePlan(plans)
			: resolveBasicPlan(plans);
	const offers = selectedPlan
		? selection.target_plan_slug === "compute_basic"
			? explicitPlanOffers(selectedPlan)
			: planOffers(selectedPlan)
		: [];
	const selectedOffer = offers.find(
		(offer) => offer.billing_term_months === selection.target_billing_term_months,
	);
	const noChange = isSamePlanChangeSelection(
		selection,
		currentPlanSlug,
		currentBillingTermMonths,
		currentFundingSource,
	);
	const fundingSourceSwitch = isFundingSourceSwitchQuote(displayedQuote);
	const quoteFundingSource =
		displayedQuote?.funding_source === "stripe" || displayedQuote?.funding_source === "wallet"
			? displayedQuote.funding_source
			: selection.funding_source;
	const walletBalanceAfter =
		!fundingSourceSwitch &&
		quoteFundingSource === "wallet" &&
		displayedQuote?.amount_usd &&
		walletBalanceUsd
			? walletBalanceAfterDebit(walletBalanceUsd, displayedQuote.amount_usd)
			: null;
	const walletInsufficient = walletBalanceAfter?.startsWith("-") ?? false;
	const walletQuoteMissingAmount =
		quoteFundingSource === "wallet" &&
		!fundingSourceSwitch &&
		displayedQuote?.change_kind === "immediate_upgrade" &&
		!displayedQuote.amount_usd;
	const invalidFundingSourceSwitchQuote =
		fundingSourceSwitch &&
		displayedQuote !== null &&
		!isValidFundingSourceSwitchQuote(
			displayedQuote,
			selection,
			currentPlanSlug,
			currentBillingTermMonths,
			currentFundingSource,
		);
	const offerReady =
		!planChangeNeedsOffer(selection, currentPlanSlug, currentBillingTermMonths) ||
		selectedOffer !== undefined;
	const walletReady =
		!planChangeNeedsWalletBalance(selection, currentPlanSlug, currentBillingTermMonths) ||
		walletBalanceUsd !== null;
	const hasManagementModes = managementModes.hasModePicker;
	const paymentSourceMode = paymentSourceOnly || managementMode === "payment-source";

	useEffect(() => {
		if (!open) return;
		setSelection(initialSelection);
		setManagementMode(managementModes.initialMode);
	}, [initialSelection, managementModes.initialMode, open]);

	function updateManagementMode(nextMode: ManagementMode) {
		setManagementMode(nextMode);
		setSelection(
			nextMode === "payment-source"
				? {
						target_plan_slug: currentPlanSlug,
						target_billing_term_months: currentBillingTermMonths,
						funding_source: currentFundingSource,
					}
				: initialSelection,
		);
	}

	function updatePlan(value: string | null) {
		const nextPlanSlug = planSlug(value);
		if (!nextPlanSlug) return;
		const plan =
			nextPlanSlug === "compute_performance"
				? resolvePerformancePlan(plans)
				: resolveBasicPlan(plans);
		const nextOffers = plan
			? nextPlanSlug === "compute_basic"
				? explicitPlanOffers(plan)
				: planOffers(plan)
			: [];
		const keepsTerm = nextOffers.some(
			(offer) => offer.billing_term_months === selection.target_billing_term_months,
		);
		setSelection(
			selectPlanChangeOffer(
				selection,
				nextPlanSlug,
				keepsTerm
					? selection.target_billing_term_months
					: nextOffers[0]?.billing_term_months === 12
						? 12
						: 1,
				currentFundingSource,
				allowCombinedChange,
			),
		);
	}

	const quoteTitle = copy.quoteTitle(displayedQuote);
	const confirmLabel = copy.confirmLabel(displayedQuote);
	const busyLabel = copy.busyLabel(displayedQuote);
	const blocksClose = isQuoting || (isConfirming && !hasAcceptedChange);
	function requestOpenChange(nextOpen: boolean) {
		if (blocksClose) return;
		if (nextOpen) exit.beginOpen();
		else exit.beginClose();
		onOpenChange(nextOpen);
	}

	return (
		<Dialog
			open={open}
			onOpenChange={requestOpenChange}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) {
					exit.completeClose();
					onExitComplete?.();
				}
			}}
		>
			<DialogContent
				data-hosted="true"
				className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
				showCloseButton={!blocksClose}
			>
				<DialogHeader>
					<DialogTitle>
						{step === "pending"
							? copy.pendingTitle
							: step === "payment_method_required"
								? copy.cardRequiredStepTitle
								: step === "quote"
									? quoteTitle
									: paymentSourceOnly
										? copy.changePaymentSourceTitle
										: hasManagementModes
											? copy.manageTitle
											: copy.changeTitle}
					</DialogTitle>
					<DialogDescription>
						{step === "pending"
							? copy.pendingDescription
							: step === "payment_method_required"
								? copy.cardRequiredStepDescription
								: step === "quote" && displayedQuote
									? fundingSourceSwitch
										? copy.fundingSwitchQuoteDescription(quoteFundingSource)
										: displayedQuote.change_kind === "immediate_upgrade"
											? copy.upgradeQuoteDescription
											: copy.downgradeQuoteDescription(formatShortDate(displayedQuote.effective_at))
									: paymentSourceMode
										? copy.paymentSourceModeDescription
										: allowCombinedChange
											? copy.combinedSelectionDescription
											: copy.planSelectionDescription}
					</DialogDescription>
				</DialogHeader>

				{step === "pending" ? (
					<div className="flex flex-col gap-4">
						<Alert>
							<CalendarClock aria-hidden />
							<AlertTitle>{copy.stillWaitingTitle}</AlertTitle>
							<AlertDescription>{copy.stillWaitingDescription}</AlertDescription>
						</Alert>
						<DialogFooter>
							<Button
								variant="ghost"
								onClick={() => requestOpenChange(false)}
								disabled={blocksClose}
							>
								{copy.close}
							</Button>
							<Button onClick={onCheckStatus} disabled={isConfirming}>
								{isConfirming ? (
									<Spinner data-icon="inline-start" />
								) : (
									<RefreshCw data-icon="inline-start" />
								)}
								{isConfirming ? copy.checkingStatus : copy.checkStatus}
							</Button>
						</DialogFooter>
					</div>
				) : step === "payment_method_required" ? (
					<PaymentMethodRequiredRecovery
						isManagingPaymentMethods={isManagingPaymentMethods}
						onClose={() => requestOpenChange(false)}
						onManagePaymentMethods={onManagePaymentMethods}
					/>
				) : step === "quote" && displayedQuote ? (
					<div className="flex flex-col gap-4">
						<div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
							<dl>
								<dt className="text-xs text-muted-foreground">
									{fundingSourceSwitch ? copy.subscription : copy.newSubscription}
								</dt>
								<dd className="font-medium">
									{computeTierLabel(planSlug(displayedQuote.target_plan_slug))} ·{" "}
									{billingTermLabel(displayedQuote.target_billing_term_months)}
								</dd>
							</dl>
							{!fundingSourceSwitch ? (
								<dl>
									<dt className="text-xs text-muted-foreground">
										{displayedQuote.change_kind === "immediate_upgrade"
											? copy.dueNow
											: copy.effectiveDate}
									</dt>
									<dd className="font-medium tabular-nums">
										{displayedQuote.change_kind === "immediate_upgrade"
											? quoteFundingSource === "wallet"
												? displayedQuote.amount_usd
													? formatUsdExact(displayedQuote.amount_usd)
													: "—"
												: formatCents(displayedQuote.amount_cents)
											: formatShortDate(displayedQuote.effective_at)}
									</dd>
								</dl>
							) : null}
						</div>
						{fundingSourceSwitch ? (
							<FundingSourceSwitchSummary
								amountCents={displayedQuote.amount_cents}
								fundingSource={quoteFundingSource}
							/>
						) : null}
						{quoteFundingSource === "wallet" &&
						displayedQuote.change_kind === "immediate_upgrade" &&
						displayedQuote.amount_usd &&
						walletBalanceUsd &&
						walletBalanceAfter ? (
							<WalletDebitEquation
								balanceBeforeUsd={walletBalanceUsd}
								debitAmountUsd={displayedQuote.amount_usd}
								balanceAfterUsd={walletBalanceAfter}
							/>
						) : null}
						{displayedQuote.change_kind === "scheduled_downgrade" ? (
							<Alert>
								<CalendarClock aria-hidden />
								<AlertTitle>{copy.noChargeTodayTitle}</AlertTitle>
								<AlertDescription>{copy.noChargeTodayDescription}</AlertDescription>
							</Alert>
						) : null}
						{walletInsufficient ? (
							<Alert variant="destructive">
								<TriangleAlert aria-hidden />
								<AlertTitle>{copy.insufficientBalanceTitle}</AlertTitle>
								<AlertDescription className="flex flex-col items-start gap-3">
									<span>{copy.insufficientBalanceDescription}</span>
									{onTopUp ? (
										<Button type="button" size="sm" variant="outline" onClick={onTopUp}>
											<WalletCards data-icon="inline-start" /> {copy.topUp}
										</Button>
									) : null}
								</AlertDescription>
							</Alert>
						) : null}
						{walletQuoteMissingAmount ? (
							<Alert variant="destructive">
								<TriangleAlert aria-hidden />
								<AlertTitle>{copy.walletQuoteIncompleteTitle}</AlertTitle>
								<AlertDescription>{copy.walletQuoteIncompleteDescription}</AlertDescription>
							</Alert>
						) : null}
						{invalidFundingSourceSwitchQuote ? (
							<Alert variant="destructive">
								<TriangleAlert aria-hidden />
								<AlertTitle>{copy.invalidSwitchQuoteTitle}</AlertTitle>
								<AlertDescription>{copy.invalidSwitchQuoteDescription}</AlertDescription>
							</Alert>
						) : null}
						<DialogFooter>
							<Button
								variant="ghost"
								onClick={() => requestOpenChange(false)}
								disabled={blocksClose}
							>
								{copy.back}
							</Button>
							<Button
								onClick={() => onConfirm(displayedQuote.operation_id)}
								disabled={
									isConfirming ||
									walletInsufficient ||
									walletQuoteMissingAmount ||
									invalidFundingSourceSwitchQuote
								}
							>
								{isConfirming ? (
									<Spinner data-icon="inline-start" />
								) : quoteFundingSource === "wallet" ? (
									<WalletCards data-icon="inline-start" />
								) : (
									<CreditCard data-icon="inline-start" />
								)}
								{isConfirming ? busyLabel : confirmLabel}
							</Button>
						</DialogFooter>
					</div>
				) : (
					<div className="flex flex-col gap-5">
						{hasManagementModes ? (
							<ToggleGroup
								value={[managementMode]}
								onValueChange={(value) => {
									const nextMode = value[0];
									if (nextMode === "plan-billing" || nextMode === "payment-source") {
										updateManagementMode(nextMode);
									}
								}}
								variant="outline"
								size="sm"
								className="grid w-full grid-cols-2"
								aria-label={copy.managementModeLabel}
							>
								<ToggleGroupItem
									value="plan-billing"
									className="min-w-0 px-2"
									disabled={!managementModes.planBillingAvailable}
								>
									{copy.planAndBilling}
								</ToggleGroupItem>
								<ToggleGroupItem value="payment-source" className="min-w-0 px-2">
									{copy.paymentSource}
								</ToggleGroupItem>
							</ToggleGroup>
						) : null}
						{paymentSourceMode ? (
							<div className="grid gap-3 border-y py-3 sm:grid-cols-2">
								<dl>
									<dt className="text-xs text-muted-foreground">{copy.currentPlan}</dt>
									<dd className="font-medium">{computeTierLabel(currentPlanSlug)}</dd>
								</dl>
								<dl>
									<dt className="text-xs text-muted-foreground">{copy.billingTerm}</dt>
									<dd className="font-medium">{billingTermLabel(currentBillingTermMonths)}</dd>
								</dl>
							</div>
						) : (
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="plan-change-tier">{copy.computePlan}</Label>
									<Select
										items={PLAN_ITEMS}
										value={selection.target_plan_slug}
										onValueChange={updatePlan}
									>
										<SelectTrigger id="plan-change-tier" className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectGroup>
												{PLAN_ITEMS.map((item) => (
													<SelectItem key={item.value} value={item.value}>
														{item.label}
													</SelectItem>
												))}
											</SelectGroup>
										</SelectContent>
									</Select>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label>{copy.billingTerm}</Label>
									<TermSwitcher
										offers={offers}
										value={selection.target_billing_term_months}
										onChange={(billingTermMonths) =>
											setSelection((current) =>
												selectPlanChangeOffer(
													current,
													current.target_plan_slug,
													billingTermMonths === 12 ? 12 : 1,
													currentFundingSource,
													allowCombinedChange,
												),
											)
										}
									/>
								</div>
							</div>
						)}
						{allowCombinedChange || paymentSourceMode ? (
							<div className="flex flex-col gap-1.5">
								<Label id="plan-change-funding-label">{copy.paymentSource}</Label>
								<ToggleGroup
									value={[selection.funding_source]}
									onValueChange={(value) => {
										const next = value[0];
										if (next === "stripe" || next === "wallet") {
											setSelection((current) =>
												selectPlanChangeFundingSource(
													current,
													next,
													currentPlanSlug,
													currentBillingTermMonths,
													allowCombinedChange,
												),
											);
										}
									}}
									variant="outline"
									className="grid w-full grid-cols-2"
									aria-labelledby="plan-change-funding-label"
								>
									<ToggleGroupItem value="stripe">
										<CreditCard data-icon="inline-start" /> {copy.card}
									</ToggleGroupItem>
									<ToggleGroupItem value="wallet">
										<WalletCards data-icon="inline-start" /> {copy.wallet}
									</ToggleGroupItem>
								</ToggleGroup>
							</div>
						) : null}
						{selection.funding_source === "wallet" && !walletReady ? (
							<p className="text-sm text-muted-foreground" role="status">
								{copy.loadingWalletBalance}
							</p>
						) : null}
						{selectedOffer && !paymentSourceMode ? (
							<p className="text-sm text-muted-foreground">
								{copy.listedPrice(
									formatCents(selectedOffer.price_cents),
									selectedOffer.billing_term_months,
								)}
							</p>
						) : null}
						<DialogFooter>
							<Button variant="ghost" onClick={() => requestOpenChange(false)} disabled={isQuoting}>
								{copy.cancel}
							</Button>
							<Button
								onClick={() => onQuote(selection)}
								disabled={isQuoting || noChange || !offerReady || !walletReady}
							>
								{isQuoting ? <Spinner data-icon="inline-start" /> : null}
								{copy.reviewChange}
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
