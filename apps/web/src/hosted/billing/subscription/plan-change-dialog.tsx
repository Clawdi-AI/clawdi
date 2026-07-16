"use client";

import { CalendarClock, CreditCard, WalletCards } from "lucide-react";
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
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import { WalletDebitEquation } from "@/hosted/billing/components/wallet-debit-equation";
import type { ComputePlanSlug, Plan } from "@/hosted/billing/contracts";
import { billingTermLabel, formatCents } from "@/hosted/billing/format";
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
	type PlanChangeQuoteView,
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
	quote,
	walletBalanceCredits,
	isQuoting,
	isConfirming,
	onQuote,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	plans: Plan[];
	currentPlanSlug: ComputePlanSlug;
	currentBillingTermMonths: number;
	quote: PlanChangeQuoteView | null;
	walletBalanceCredits: number | null;
	isQuoting: boolean;
	isConfirming: boolean;
	onQuote: (selection: PlanChangeSelection) => void;
	onConfirm: (operationId: string) => void;
}) {
	const initialSelection = useMemo(
		() => defaultPlanChangeSelection(currentPlanSlug, currentBillingTermMonths),
		[currentBillingTermMonths, currentPlanSlug],
	);
	const [selection, setSelection] = useState(initialSelection);
	const selectedPlan =
		selection.planSlug === "compute_performance"
			? resolvePerformancePlan(plans)
			: resolveBasicPlan(plans);
	const offers = selectedPlan
		? selection.planSlug === "compute_basic"
			? explicitPlanOffers(selectedPlan)
			: planOffers(selectedPlan)
		: [];
	const selectedOffer = offers.find(
		(offer) => offer.billing_term_months === selection.billingTermMonths,
	);
	const noChange = isSamePlanChangeSelection(selection, currentPlanSlug, currentBillingTermMonths);
	const walletBalanceBefore = walletBalanceCredits === null ? null : String(walletBalanceCredits);
	const walletBalanceAfter =
		quote?.fundingSource === "wallet" && quote.amountCredits && walletBalanceBefore
			? walletBalanceAfterDebit(walletBalanceBefore, quote.amountCredits)
			: null;

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
			(offer) => offer.billing_term_months === selection.billingTermMonths,
		);
		setSelection({
			planSlug: nextPlanSlug,
			billingTermMonths: keepsTerm
				? selection.billingTermMonths
				: (nextOffers[0]?.billing_term_months ?? 1),
		});
	}

	const quoteTitle =
		quote?.changeKind === "immediate_upgrade" ? "Confirm immediate upgrade" : "Schedule downgrade";
	const confirmLabel =
		quote?.changeKind === "immediate_upgrade" ? "Confirm upgrade" : "Schedule downgrade";

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
							? quote.changeKind === "immediate_upgrade"
								? "The quoted proration is charged now. Compute changes after payment is confirmed."
								: `The current plan remains active until ${formatShortDate(quote.effectiveAt)}.`
							: "Choose a compute plan and monthly or annual billing, then review the server quote."}
					</DialogDescription>
				</DialogHeader>

				{quote ? (
					<div className="flex flex-col gap-4">
						<div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
							<dl>
								<dt className="text-xs text-muted-foreground">New subscription</dt>
								<dd className="font-medium">
									{computeTierLabel(quote.targetPlanSlug)} ·{" "}
									{billingTermLabel(quote.targetBillingTermMonths)}
								</dd>
							</dl>
							<dl>
								<dt className="text-xs text-muted-foreground">
									{quote.changeKind === "immediate_upgrade" ? "Due now" : "Effective date"}
								</dt>
								<dd className="font-medium tabular-nums">
									{quote.changeKind === "immediate_upgrade"
										? formatCents(quote.amountCents)
										: formatShortDate(quote.effectiveAt)}
								</dd>
							</dl>
						</div>
						{quote.fundingSource === "wallet" &&
						quote.changeKind === "immediate_upgrade" &&
						quote.amountCredits &&
						walletBalanceBefore &&
						walletBalanceAfter ? (
							<WalletDebitEquation
								balanceBeforeCredits={walletBalanceBefore}
								exactDebitCredits={quote.amountCredits}
								exactDebitCents={quote.amountCents}
								balanceAfterCredits={walletBalanceAfter}
							/>
						) : null}
						{quote.changeKind === "scheduled_downgrade" ? (
							<Alert>
								<CalendarClock aria-hidden />
								<AlertTitle>No charge today</AlertTitle>
								<AlertDescription>
									The downgrade is scheduled for the current period boundary. Your current plan and
									resources remain active until then.
								</AlertDescription>
							</Alert>
						) : null}
						<DialogFooter>
							<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isConfirming}>
								Back
							</Button>
							<Button onClick={() => onConfirm(quote.operationId)} disabled={isConfirming}>
								{isConfirming ? (
									<Spinner />
								) : quote.fundingSource === "wallet" ? (
									<WalletCards />
								) : (
									<CreditCard />
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
								<Select items={PLAN_ITEMS} value={selection.planSlug} onValueChange={updatePlan}>
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
									value={selection.billingTermMonths}
									onChange={(billingTermMonths) =>
										setSelection((current) => ({ ...current, billingTermMonths }))
									}
								/>
							</div>
						</div>
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
								disabled={isQuoting || noChange || !selectedOffer}
							>
								{isQuoting ? <Spinner /> : null}
								Review change
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
