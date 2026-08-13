"use client";

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
import { formatShortDate } from "@/lib/format";
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

type ManagementMode = "plan-billing" | "payment-source";

function planSlug(value: string | null): ComputePlanSlug | null {
	return value === "compute_basic" || value === "compute_performance" ? value : null;
}

export function planChangeDialogStep({
	hasAcceptedChange,
	hasQuote,
	paymentMethodRequired,
}: {
	hasAcceptedChange: boolean;
	hasQuote: boolean;
	paymentMethodRequired: boolean;
}): "pending" | "payment_method_required" | "quote" | "selection" {
	if (hasAcceptedChange) return "pending";
	if (paymentMethodRequired) return "payment_method_required";
	if (hasQuote) return "quote";
	return "selection";
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
				<AlertTitle>A card is required</AlertTitle>
				<AlertDescription>
					Opening billing settings does not complete this payment source change. After you return,
					request a fresh quote and submit it again.
				</AlertDescription>
			</Alert>
			<DialogFooter>
				<Button variant="ghost" onClick={onClose} disabled={isManagingPaymentMethods}>
					Close
				</Button>
				<Button onClick={onManagePaymentMethods} disabled={isManagingPaymentMethods}>
					{isManagingPaymentMethods ? (
						<Spinner data-icon="inline-start" />
					) : (
						<CreditCard data-icon="inline-start" />
					)}
					Manage payment methods
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
	const paymentSourceLabel = fundingSource === "wallet" ? "Wallet" : "Card";
	return (
		<>
			<div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
				<dl>
					<dt className="text-xs text-muted-foreground">Payment source</dt>
					<dd className="font-medium">{paymentSourceLabel}</dd>
				</dl>
				<dl>
					<dt className="text-xs text-muted-foreground">Due now</dt>
					<dd className="font-medium tabular-nums">{formatCents(amountCents)}</dd>
				</dl>
			</div>
			<Alert>
				{fundingSource === "wallet" ? <WalletCards aria-hidden /> : <CreditCard aria-hidden />}
				<AlertTitle>Future renewals use {paymentSourceLabel}</AlertTitle>
				<AlertDescription>
					Your plan, billing term, price, and renewal date stay the same. This change does not{" "}
					{fundingSource === "wallet" ? "debit your Wallet" : "charge your card"} today.
				</AlertDescription>
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
	const [selection, setSelection] = useState(initialSelection);
	const [managementMode, setManagementMode] = useState<ManagementMode>(
		paymentSourceOnly ? "payment-source" : "plan-billing",
	);
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
	const quoteFundingSource = displayedQuote?.funding_source ?? selection.funding_source;
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
	const hasManagementModes = !allowCombinedChange && !paymentSourceOnly;
	const paymentSourceMode = paymentSourceOnly || managementMode === "payment-source";

	useEffect(() => {
		if (!open) return;
		setSelection(initialSelection);
		setManagementMode(paymentSourceOnly ? "payment-source" : "plan-billing");
	}, [initialSelection, open, paymentSourceOnly]);

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

	const quoteTitle = fundingSourceSwitch
		? "Confirm payment source change"
		: displayedQuote?.change_kind === "immediate_upgrade"
			? "Confirm immediate upgrade"
			: "Schedule downgrade";
	const confirmLabel = fundingSourceSwitch
		? "Update payment source"
		: displayedQuote?.change_kind === "immediate_upgrade"
			? "Confirm upgrade"
			: "Schedule downgrade";
	const busyLabel = fundingSourceSwitch
		? "Updating payment source…"
		: displayedQuote?.change_kind === "immediate_upgrade"
			? "Confirming plan change…"
			: "Scheduling downgrade…";
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
			<DialogContent data-hosted="true" className="sm:max-w-lg" showCloseButton={!blocksClose}>
				<DialogHeader>
					<DialogTitle>
						{step === "pending"
							? "Check subscription change status"
							: step === "payment_method_required"
								? "Add a card to continue"
								: step === "quote"
									? quoteTitle
									: paymentSourceOnly
										? "Change payment source"
										: hasManagementModes
											? "Manage compute subscription"
											: "Change compute subscription"}
					</DialogTitle>
					<DialogDescription>
						{step === "pending"
							? "This subscription change was already accepted. Checking its status will not submit another request or charge."
							: step === "payment_method_required"
								? "Add or choose a card in secure billing settings, then return and request a new quote."
								: step === "quote" && displayedQuote
									? fundingSourceSwitch
										? `No payment is due now. Future renewals will use ${quoteFundingSource === "wallet" ? "Wallet" : "Card"}.`
										: displayedQuote.change_kind === "immediate_upgrade"
											? "The quoted proration is charged now. Compute changes after payment is confirmed."
											: `The current plan remains active until ${formatShortDate(displayedQuote.effective_at)}.`
									: paymentSourceMode
										? "Choose a new payment source. Your plan and billing term stay the same; eligibility is verified before the change is applied."
										: allowCombinedChange
											? "Choose a compute plan, billing term, and payment source, then review the exact price and timing."
											: "Choose a compute plan and billing term. Your payment source stays the same."}
					</DialogDescription>
				</DialogHeader>

				{step === "pending" ? (
					<div className="flex flex-col gap-4">
						<Alert>
							<CalendarClock aria-hidden />
							<AlertTitle>Still waiting for confirmation</AlertTitle>
							<AlertDescription>
								We don’t have a final result yet. Don’t submit another subscription change. You can
								close this window and check again in a few minutes; if it still hasn’t finished,
								contact support.
							</AlertDescription>
						</Alert>
						<DialogFooter>
							<Button
								variant="ghost"
								onClick={() => requestOpenChange(false)}
								disabled={blocksClose}
							>
								Close
							</Button>
							<Button onClick={onCheckStatus} disabled={isConfirming}>
								{isConfirming ? (
									<Spinner data-icon="inline-start" />
								) : (
									<RefreshCw data-icon="inline-start" />
								)}
								{isConfirming ? "Checking status…" : "Check status"}
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
									{fundingSourceSwitch ? "Subscription" : "New subscription"}
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
											? "Due now"
											: "Effective date"}
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
								<AlertTitle>No charge today</AlertTitle>
								<AlertDescription>
									The downgrade is scheduled for the current period boundary. Your current plan and
									resources remain active until then.
								</AlertDescription>
							</Alert>
						) : null}
						{walletInsufficient ? (
							<Alert variant="destructive">
								<TriangleAlert aria-hidden />
								<AlertTitle>Not enough Wallet balance</AlertTitle>
								<AlertDescription className="flex flex-col items-start gap-3">
									<span>Top up the shortfall, then request a fresh price.</span>
									{onTopUp ? (
										<Button type="button" size="sm" variant="outline" onClick={onTopUp}>
											<WalletCards data-icon="inline-start" /> Top up Wallet
										</Button>
									) : null}
								</AlertDescription>
							</Alert>
						) : null}
						{walletQuoteMissingAmount ? (
							<Alert variant="destructive">
								<TriangleAlert aria-hidden />
								<AlertTitle>Wallet quote is incomplete</AlertTitle>
								<AlertDescription>
									Request a fresh quote before confirming this plan change.
								</AlertDescription>
							</Alert>
						) : null}
						{invalidFundingSourceSwitchQuote ? (
							<Alert variant="destructive">
								<TriangleAlert aria-hidden />
								<AlertTitle>Payment source quote is invalid</AlertTitle>
								<AlertDescription>
									A payment source-only change must keep the current plan and term, have $0 due now,
									and apply to future renewals. Go back and request a fresh quote.
								</AlertDescription>
							</Alert>
						) : null}
						<DialogFooter>
							<Button
								variant="ghost"
								onClick={() => requestOpenChange(false)}
								disabled={blocksClose}
							>
								Back
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
								aria-label="Subscription management mode"
							>
								<ToggleGroupItem value="plan-billing" className="min-w-0 px-2">
									Plan &amp; billing
								</ToggleGroupItem>
								<ToggleGroupItem value="payment-source" className="min-w-0 px-2">
									Payment source
								</ToggleGroupItem>
							</ToggleGroup>
						) : null}
						{paymentSourceMode ? (
							<div className="grid gap-3 border-y py-3 sm:grid-cols-2">
								<dl>
									<dt className="text-xs text-muted-foreground">Current plan</dt>
									<dd className="font-medium">{computeTierLabel(currentPlanSlug)}</dd>
								</dl>
								<dl>
									<dt className="text-xs text-muted-foreground">Billing term</dt>
									<dd className="font-medium">{billingTermLabel(currentBillingTermMonths)}</dd>
								</dl>
							</div>
						) : (
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="plan-change-tier">Compute plan</Label>
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
									<Label>Billing term</Label>
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
								<Label id="plan-change-funding-label">Payment source</Label>
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
										<CreditCard data-icon="inline-start" /> Card
									</ToggleGroupItem>
									<ToggleGroupItem value="wallet">
										<WalletCards data-icon="inline-start" /> Wallet
									</ToggleGroupItem>
								</ToggleGroup>
							</div>
						) : null}
						{selection.funding_source === "wallet" && !walletReady ? (
							<p className="text-sm text-muted-foreground" role="status">
								Loading Wallet balance…
							</p>
						) : null}
						{selectedOffer && !paymentSourceMode ? (
							<p className="text-sm text-muted-foreground">
								Listed recurring price {formatCents(selectedOffer.price_cents)}
								{selectedOffer.billing_term_months === 1 ? "/month" : "/year"}
							</p>
						) : null}
						<DialogFooter>
							<Button variant="ghost" onClick={() => requestOpenChange(false)} disabled={isQuoting}>
								Cancel
							</Button>
							<Button
								onClick={() => onQuote(selection)}
								disabled={isQuoting || noChange || !offerReady || !walletReady}
							>
								{isQuoting ? <Spinner data-icon="inline-start" /> : null}
								Review change
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
