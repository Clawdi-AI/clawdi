"use client";

import { CreditCard, TriangleAlert, WalletCards } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
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
import { checkoutRedirectUrl } from "@/hosted/billing/components/stripe-checkout.logic";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import { WalletDebitEquation } from "@/hosted/billing/components/wallet-debit-equation";
import type {
	CheckoutRequest,
	ComputePlanChangeQuoteRequest,
	ComputePlanSlug,
	Plan,
	WalletComputeActivateRequest,
	WalletComputeQuoteRequest,
} from "@/hosted/billing/contracts";
import {
	billingErrorDetail,
	billingErrorNormalizer,
	isIdempotencyKeyReusedError,
	normalizeBillingError,
} from "@/hosted/billing/errors";
import { billingTermLabel, formatCents, formatCentsCompact } from "@/hosted/billing/format";
import { useCreateSubscription, useWallet, useWalletComputeQuote } from "@/hosted/billing/hooks";
import {
	forgetIdempotencyAttempt,
	type IdempotencyAttempt,
	idempotencyAttemptFor,
	idempotencyFingerprint,
	newIdempotencyKey,
} from "@/hosted/billing/idempotency";
import {
	computeTierLabel,
	explicitPlanOffers,
	planOffers,
	resolveBasicPlan,
	resolvePerformancePlan,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { topUpAmountCentsForCreditShortfall } from "@/hosted/billing/wallet/top-up-dialog.logic";
import {
	walletDebitShortfallCredits,
	walletSubscriptionDebitSummary,
} from "@/hosted/billing/wallet/wallet-debit-summary";
import { useHostedProductAccess } from "@/lib/hosted-product-access";

const PLAN_ITEMS = [
	{ value: "compute_basic", label: "Basic" },
	{ value: "compute_performance", label: "Performance" },
] as const;

type FundingSource = NonNullable<ComputePlanChangeQuoteRequest["funding_source"]>;

function computePlanSlug(value: string | null): ComputePlanSlug | null {
	return value === "compute_basic" || value === "compute_performance" ? value : null;
}

function supportedBillingTerm(
	value: number,
): WalletComputeQuoteRequest["billing_term_months"] | null {
	return value === 1 || value === 12 ? value : null;
}

function decimalCredits(value: unknown): number | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function planForSlug(plans: Plan[], planSlug: ComputePlanSlug): Plan | undefined {
	return planSlug === "compute_performance"
		? resolvePerformancePlan(plans)
		: resolveBasicPlan(plans);
}

function offersForPlan(plan: Plan | undefined, planSlug: ComputePlanSlug) {
	if (!plan) return [];
	return planSlug === "compute_basic" ? explicitPlanOffers(plan) : planOffers(plan);
}

export function SubscriptionCreateDialog({
	open,
	onOpenChange,
	plans,
	deploymentId,
	initialPlanSlug,
	initialBillingTermMonths,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	plans: Plan[];
	deploymentId: string;
	initialPlanSlug: ComputePlanSlug;
	initialBillingTermMonths: number;
}) {
	const hostedAccess = useHostedProductAccess();
	const createSubscription = useCreateSubscription();
	const runAction = useActionLock();
	const checkoutAttemptRef = useRef<IdempotencyAttempt | null>(null);
	const [planSlug, setPlanSlug] = useState(initialPlanSlug);
	const [billingTermMonths, setBillingTermMonths] = useState(initialBillingTermMonths);
	const [fundingSource, setFundingSource] = useState<FundingSource>("stripe");
	const [walletTopUpOpen, setWalletTopUpOpen] = useState(false);
	const [walletTopUpAmountCents, setWalletTopUpAmountCents] = useState<number | null>(null);
	const selectedPlan = useMemo(() => planForSlug(plans, planSlug), [planSlug, plans]);
	const offers = useMemo(() => offersForPlan(selectedPlan, planSlug), [planSlug, selectedPlan]);
	const selectedOffer =
		offers.find((offer) => offer.billing_term_months === billingTermMonths) ?? null;
	const supportedTerm = supportedBillingTerm(billingTermMonths);
	const walletQuoteRequest: WalletComputeQuoteRequest | null =
		supportedTerm && selectedOffer
			? {
					plan_slug: planSlug,
					billing_term_months: supportedTerm,
				}
			: null;
	const wallet = useWallet({
		enabled: open && hostedAccess.canUsePlanCBilling && fundingSource === "wallet",
	});
	const walletQuote = useWalletComputeQuote(walletQuoteRequest, {
		enabled: open && hostedAccess.canUsePlanCBilling && fundingSource === "wallet",
	});
	const walletDebit = walletQuote.data ? walletSubscriptionDebitSummary(walletQuote.data) : null;
	const walletShortfallCredits = walletDebitShortfallCredits(walletDebit);
	const walletHasRefundDebt = walletDebit?.hasOpenRefundDebt ?? false;
	const walletInsufficient = walletShortfallCredits !== null || walletHasRefundDebt;
	const isPending = createSubscription.isPending;
	const submitLabel =
		fundingSource === "wallet" && walletDebit
			? `Pay ${formatCents(walletDebit.exactDebitCents)} from Wallet`
			: fundingSource === "wallet"
				? "Review wallet quote"
				: "Continue to card checkout";

	useEffect(() => {
		if (!open) return;
		const plan = planForSlug(plans, initialPlanSlug);
		const initialOffers = offersForPlan(plan, initialPlanSlug);
		const nextTerm =
			initialOffers.find((offer) => offer.billing_term_months === initialBillingTermMonths)
				?.billing_term_months ??
			initialOffers[0]?.billing_term_months ??
			initialBillingTermMonths;
		setPlanSlug(initialPlanSlug);
		setBillingTermMonths(nextTerm);
		setFundingSource("stripe");
		setWalletTopUpOpen(false);
		setWalletTopUpAmountCents(null);
	}, [initialBillingTermMonths, initialPlanSlug, open, plans]);

	function updatePlan(value: string | null) {
		const nextPlanSlug = computePlanSlug(value);
		if (!nextPlanSlug) return;
		const nextOffers = offersForPlan(planForSlug(plans, nextPlanSlug), nextPlanSlug);
		const nextTerm =
			nextOffers.find((offer) => offer.billing_term_months === billingTermMonths)
				?.billing_term_months ??
			nextOffers[0]?.billing_term_months ??
			billingTermMonths;
		setPlanSlug(nextPlanSlug);
		setBillingTermMonths(nextTerm);
	}

	function openWalletTopUp(shortfallCredits: number | null) {
		const pointsPerUsd = walletDebit?.pointsPerUsd ?? wallet.data?.points_per_usd ?? 0;
		setWalletTopUpAmountCents(topUpAmountCentsForCreditShortfall(shortfallCredits, pointsPerUsd));
		setWalletTopUpOpen(true);
	}

	function handleWalletCreateError(error: unknown): boolean {
		const detail = billingErrorDetail(error);
		if (detail?.code === "insufficient_wallet_balance" || detail?.code === "insufficient_balance") {
			openWalletTopUp(decimalCredits(detail.shortfall_credits));
			toast.error("Not enough AI Credits", {
				description: "Top up the shortfall, then review a fresh wallet quote.",
			});
			return true;
		}
		if (detail?.code === "open_refund_debt") {
			openWalletTopUp(decimalCredits(detail.outstanding_debt_credits));
			toast.error("Refund debt must be repaid", {
				description: "Top up before starting this wallet subscription.",
			});
			return true;
		}
		return false;
	}

	async function create() {
		if (!hostedAccess.canUsePlanCBilling || !selectedOffer || !supportedTerm || isPending) {
			return;
		}
		try {
			if (fundingSource === "wallet") {
				if (!walletDebit || walletInsufficient) return;
				const body: WalletComputeActivateRequest = {
					plan_slug: planSlug,
					billing_term_months: supportedTerm,
					upgrade_deployment_id: deploymentId,
				};
				const outcome = await createSubscription.mutateAsync({
					fundingSource: "wallet",
					body,
				});
				if (outcome.fundingSource !== "wallet") return;
				toast.success("Subscription started", {
					description: `${formatCents(walletDebit.exactDebitCents)} was paid with AI Credits. Compute updates after payment is projected.`,
				});
				onOpenChange(false);
				return;
			}

			const body: CheckoutRequest = {
				plan_slug: planSlug,
				billing_term_months: supportedTerm,
				ui_mode: "hosted",
				upgrade_deployment_id: deploymentId,
			};
			const fingerprint = idempotencyFingerprint(body);
			checkoutAttemptRef.current = idempotencyAttemptFor(
				checkoutAttemptRef.current,
				"subscription-existing-deployment",
				fingerprint,
				newIdempotencyKey,
			);
			const outcome = await createSubscription.mutateAsync({
				fundingSource: "stripe",
				body,
				idempotencyKey: checkoutAttemptRef.current.key,
			});
			if (outcome.fundingSource !== "stripe") return;
			const checkoutUrl = checkoutRedirectUrl(outcome.data);
			if (checkoutUrl) {
				window.location.href = checkoutUrl;
				return;
			}
			toast.error("Couldn’t start checkout", {
				description: "No checkout URL was returned. Please try again.",
			});
		} catch (error) {
			if (fundingSource === "wallet" && handleWalletCreateError(error)) return;
			if (isIdempotencyKeyReusedError(error) && checkoutAttemptRef.current) {
				forgetIdempotencyAttempt(
					"subscription-existing-deployment",
					checkoutAttemptRef.current.fingerprint,
				);
				checkoutAttemptRef.current = null;
			}
			toast.error("Couldn’t start subscription", {
				description: normalizeBillingError(error),
			});
		}
	}

	const submitDisabled =
		!hostedAccess.canUsePlanCBilling ||
		!selectedOffer ||
		!supportedTerm ||
		isPending ||
		(fundingSource === "wallet" &&
			(!walletDebit || walletQuote.isFetching || !!walletQuote.error || walletInsufficient));

	return (
		<>
			<Dialog
				open={open}
				onOpenChange={(nextOpen) => {
					if (!isPending && !walletTopUpOpen) onOpenChange(nextOpen);
				}}
			>
				<DialogContent data-hosted="true" className="sm:max-w-lg" showCloseButton={!isPending}>
					<DialogHeader>
						<DialogTitle>Start a new subscription</DialogTitle>
						<DialogDescription>
							Choose the paid compute plan, billing term, and funding source for this agent.
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-5">
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="subscription-create-plan">Compute plan</Label>
								<Select items={PLAN_ITEMS} value={planSlug} onValueChange={updatePlan}>
									<SelectTrigger id="subscription-create-plan" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{PLAN_ITEMS.map((item) => (
												<SelectItem
													key={item.value}
													value={item.value}
													disabled={!planForSlug(plans, item.value)}
												>
													{item.label}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label>Billing term</Label>
								<div>
									<TermSwitcher
										offers={offers}
										value={billingTermMonths}
										onChange={setBillingTermMonths}
									/>
								</div>
							</div>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label id="subscription-create-funding-label">Funding source</Label>
							<ToggleGroup
								value={[fundingSource]}
								onValueChange={(value) => {
									const next = value[0];
									if (next === "stripe" || next === "wallet") setFundingSource(next);
								}}
								variant="outline"
								className="grid w-full grid-cols-2"
								aria-labelledby="subscription-create-funding-label"
							>
								<ToggleGroupItem value="stripe">
									<CreditCard data-icon="inline-start" /> Card
								</ToggleGroupItem>
								<ToggleGroupItem value="wallet">
									<WalletCards data-icon="inline-start" /> Wallet
								</ToggleGroupItem>
							</ToggleGroup>
						</div>

						{selectedOffer ? (
							<p className="text-sm text-muted-foreground">
								{computeTierLabel(planSlug)} · {billingTermLabel(billingTermMonths)} ·{" "}
								{formatCentsCompact(selectedOffer.price_cents)}
								{billingTermMonths === 1 ? "/month" : "/year"}
							</p>
						) : (
							<Alert variant="destructive">
								<TriangleAlert aria-hidden />
								<AlertTitle>Plan price unavailable</AlertTitle>
								<AlertDescription>
									Refresh the page before starting a paid subscription.
								</AlertDescription>
							</Alert>
						)}

						{fundingSource === "wallet" ? (
							walletQuote.isFetching && !walletQuote.data ? (
								<p className="text-sm text-muted-foreground" role="status">
									Getting the exact wallet debit…
								</p>
							) : walletQuote.error ? (
								<ApiErrorPanel
									normalizer={billingErrorNormalizer}
									error={walletQuote.error}
									onRetry={() => void walletQuote.refetch()}
									title="Couldn’t get wallet quote"
								/>
							) : walletDebit ? (
								<div className="flex flex-col gap-3">
									<WalletDebitEquation
										balanceBeforeCredits={walletDebit.balanceBeforeCredits}
										exactDebitCredits={walletDebit.exactDebitCredits}
										exactDebitCents={walletDebit.exactDebitCents}
										balanceAfterCredits={walletDebit.balanceAfterCredits}
									/>
									{walletInsufficient ? (
										<Alert variant="destructive">
											<TriangleAlert aria-hidden />
											<AlertTitle>
												{walletHasRefundDebt
													? "Wallet refund debt must be repaid"
													: "Not enough AI Credits"}
											</AlertTitle>
											<AlertDescription className="flex flex-col items-start gap-3">
												<span>
													{walletHasRefundDebt
														? "Top up before starting this subscription. New funds repay refund debt first."
														: "Top up the shortfall, then review a fresh wallet quote."}
												</span>
												<Button
													type="button"
													size="sm"
													variant="outline"
													disabled={!wallet.data}
													onClick={() => openWalletTopUp(walletShortfallCredits)}
												>
													<WalletCards data-icon="inline-start" /> Top up AI Credits
												</Button>
											</AlertDescription>
										</Alert>
									) : null}
								</div>
							) : null
						) : null}

						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								disabled={isPending}
								onClick={() => onOpenChange(false)}
							>
								Cancel
							</Button>
							<Button
								type="button"
								disabled={submitDisabled}
								onClick={() => void runAction(create).catch(() => undefined)}
							>
								{isPending ? (
									<Spinner data-icon="inline-start" />
								) : fundingSource === "wallet" ? (
									<WalletCards data-icon="inline-start" />
								) : (
									<CreditCard data-icon="inline-start" />
								)}
								{submitLabel}
							</Button>
						</DialogFooter>
					</div>
				</DialogContent>
			</Dialog>

			{hostedAccess.canUsePlanCBilling && wallet.data ? (
				<TopUpDialog
					open={walletTopUpOpen}
					onOpenChange={setWalletTopUpOpen}
					wallet={wallet.data}
					initialAmountCents={walletTopUpAmountCents}
					onComplete={() => void walletQuote.refetch()}
				/>
			) : null}
		</>
	);
}
