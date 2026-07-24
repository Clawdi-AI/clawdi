"use client";

import { CalendarClock, CreditCard, TriangleAlert, WalletCards } from "lucide-react";
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
	isSamePlanChangeSelection,
	type PlanChangeSelection,
	walletBalanceAfterDebit,
} from "./plan-change.logic";

const PLAN_ITEMS = [
	{ value: "compute_basic", label: "Basic" },
	{ value: "compute_performance", label: "Performance" },
] as const;

function planSlug(value: string | null): ComputePlanSlug | null {
	return value === "compute_basic" || value === "compute_performance" ? value : null;
}

export function PlanChangeDialog({
	open,
	onOpenChange,
	plans,
	currentPlanSlug,
	currentBillingTermMonths,
	defaultFundingSource,
	fundingSourceSelectable,
	quote,
	walletBalanceUsd,
	isQuoting,
	isConfirming,
	onQuote,
	onConfirm,
	onTopUp,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	plans: Plan[];
	currentPlanSlug: ComputePlanSlug;
	currentBillingTermMonths: ComputePlanChangeQuoteRequest["target_billing_term_months"];
	defaultFundingSource: PlanChangeSelection["funding_source"];
	fundingSourceSelectable: boolean;
	quote: ComputePlanChangeQuoteResponse | null;
	walletBalanceUsd: string | null;
	isQuoting: boolean;
	isConfirming: boolean;
	onQuote: (selection: PlanChangeSelection) => void;
	onConfirm: (operationId: string) => void;
	onTopUp?: () => void;
}) {
	const initialSelection = useMemo(
		() =>
			defaultPlanChangeSelection(currentPlanSlug, currentBillingTermMonths, defaultFundingSource),
		[currentBillingTermMonths, currentPlanSlug, defaultFundingSource],
	);
	const [selection, setSelection] = useState(initialSelection);
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
	const noChange = isSamePlanChangeSelection(selection, currentPlanSlug, currentBillingTermMonths);
	const quoteFundingSource = quote?.funding_source ?? selection.funding_source;
	const walletBalanceAfter =
		quoteFundingSource === "wallet" && quote?.amount_usd && walletBalanceUsd
			? walletBalanceAfterDebit(walletBalanceUsd, quote.amount_usd)
			: null;
	const walletInsufficient = walletBalanceAfter?.startsWith("-") ?? false;
	const walletQuoteMissingAmount =
		quoteFundingSource === "wallet" &&
		quote?.change_kind === "immediate_upgrade" &&
		!quote.amount_usd;
	const walletReady = selection.funding_source !== "wallet" || walletBalanceUsd !== null;

	useEffect(() => {
		if (open) setSelection(initialSelection);
	}, [initialSelection, open]);

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
		setSelection({
			...selection,
			target_plan_slug: nextPlanSlug,
			target_billing_term_months: keepsTerm
				? selection.target_billing_term_months
				: nextOffers[0]?.billing_term_months === 12
					? 12
					: 1,
		});
	}

	const quoteTitle =
		quote?.change_kind === "immediate_upgrade" ? "Confirm immediate upgrade" : "Schedule downgrade";
	const confirmLabel =
		quote?.change_kind === "immediate_upgrade" ? "Confirm upgrade" : "Schedule downgrade";

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!isQuoting && !isConfirming) onOpenChange(nextOpen);
			}}
		>
			<DialogContent data-hosted="true" className="sm:max-w-lg" showCloseButton={!isConfirming}>
				<DialogHeader>
					<DialogTitle>{quote ? quoteTitle : "Change compute subscription"}</DialogTitle>
					<DialogDescription>
						{quote
							? quote.change_kind === "immediate_upgrade"
								? "The quoted proration is charged now. Compute changes after payment is confirmed."
								: `The current plan remains active until ${formatShortDate(quote.effective_at)}.`
							: "Choose a compute plan and monthly or annual billing, then review the server quote."}
					</DialogDescription>
				</DialogHeader>

				{quote ? (
					<div className="flex flex-col gap-4">
						<div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
							<dl>
								<dt className="text-xs text-muted-foreground">New subscription</dt>
								<dd className="font-medium">
									{computeTierLabel(planSlug(quote.target_plan_slug))} ·{" "}
									{billingTermLabel(quote.target_billing_term_months)}
								</dd>
							</dl>
							<dl>
								<dt className="text-xs text-muted-foreground">
									{quote.change_kind === "immediate_upgrade" ? "Due now" : "Effective date"}
								</dt>
								<dd className="font-medium tabular-nums">
									{quote.change_kind === "immediate_upgrade"
										? quoteFundingSource === "wallet"
											? quote.amount_usd
												? formatUsdExact(quote.amount_usd)
												: "—"
											: formatCents(quote.amount_cents)
										: formatShortDate(quote.effective_at)}
								</dd>
							</dl>
						</div>
						{quoteFundingSource === "wallet" &&
						quote.change_kind === "immediate_upgrade" &&
						quote.amount_usd &&
						walletBalanceUsd &&
						walletBalanceAfter ? (
							<WalletDebitEquation
								balanceBeforeUsd={walletBalanceUsd}
								debitAmountUsd={quote.amount_usd}
								balanceAfterUsd={walletBalanceAfter}
							/>
						) : null}
						{quote.change_kind === "scheduled_downgrade" ? (
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
									<span>Top up the shortfall, then request a fresh server quote.</span>
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
						<DialogFooter>
							<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isConfirming}>
								Back
							</Button>
							<Button
								onClick={() => onConfirm(quote.operation_id)}
								disabled={isConfirming || walletInsufficient || walletQuoteMissingAmount}
							>
								{isConfirming ? (
									<Spinner data-icon="inline-start" />
								) : quoteFundingSource === "wallet" ? (
									<WalletCards data-icon="inline-start" />
								) : (
									<CreditCard data-icon="inline-start" />
								)}
								{confirmLabel}
							</Button>
						</DialogFooter>
					</div>
				) : (
					<div className="flex flex-col gap-5">
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
										setSelection((current) => ({
											...current,
											target_billing_term_months: billingTermMonths === 12 ? 12 : 1,
										}))
									}
								/>
							</div>
						</div>
						{fundingSourceSelectable ? (
							<div className="flex flex-col gap-1.5">
								<Label id="plan-change-funding-label">Funding source</Label>
								<ToggleGroup
									value={[selection.funding_source]}
									onValueChange={(value) => {
										const next = value[0];
										if (next === "stripe" || next === "wallet") {
											setSelection((current) => ({
												...current,
												funding_source: next,
											}));
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
						) : (
							<p className="text-sm text-muted-foreground">
								Funding source: {selection.funding_source === "wallet" ? "Wallet" : "Card"}
							</p>
						)}
						{selection.funding_source === "wallet" && !walletReady ? (
							<p className="text-sm text-muted-foreground" role="status">
								Loading Wallet balance…
							</p>
						) : null}
						{selectedOffer ? (
							<p className="text-sm text-muted-foreground">
								Server quote required · listed recurring price{" "}
								{formatCents(selectedOffer.price_cents)}
								{selectedOffer.billing_term_months === 1 ? "/month" : "/year"}
							</p>
						) : null}
						<DialogFooter>
							<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isQuoting}>
								Cancel
							</Button>
							<Button
								onClick={() => onQuote(selection)}
								disabled={isQuoting || noChange || !selectedOffer || !walletReady}
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
