"use client";

import { useQueryClient } from "@tanstack/react-query";
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
import { useBillingClient } from "@/hosted/billing/billing-client";
import { checkoutRedirectUrl } from "@/hosted/billing/components/stripe-checkout.logic";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import { WalletDebitEquation } from "@/hosted/billing/components/wallet-debit-equation";
import type { ComputePlanSlug, Plan, SubscriptionSelection } from "@/hosted/billing/contracts";
import {
	cardTrialPricePresentation,
	computePricePresentation,
} from "@/hosted/billing/deploy/deploy-price-presentation";
import {
	billingErrorDetail,
	billingErrorNormalizer,
	isIdempotencyKeyReusedError,
	isReusableSubscriptionUnavailableError,
	normalizeBillingError,
} from "@/hosted/billing/errors";
import { billingTermLabel, formatCents, formatUsdExact } from "@/hosted/billing/format";
import { useSubscriptionCreateQuote } from "@/hosted/billing/hooks";
import {
	forgetIdempotencyAttempt,
	type IdempotencyAttempt,
	idempotencyAttemptFor,
	idempotencyFingerprint,
	newIdempotencyKey,
} from "@/hosted/billing/idempotency";
import { billingKeys } from "@/hosted/billing/query-keys";
import { useSensitiveCreateSubscription } from "@/hosted/billing/sensitive-actions";
import { useReusableSubscriptions } from "@/hosted/billing/subscription/reusable-subscriptions-query";
import {
	existingSubscriptionCreateSelection,
	resolveSubscriptionSource,
	type SubscriptionCreateSelection,
	type SubscriptionFundingSource,
	type SubscriptionSource,
	supportedBillingTerm,
} from "@/hosted/billing/subscription/subscription-create-adapter";
import { SubscriptionSourcePicker } from "@/hosted/billing/subscription/subscription-source-picker";
import {
	computeTierLabel,
	explicitPlanOffers,
	planOffers,
	resolveBasicPlan,
	resolvePerformancePlan,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { walletDebitShortfallUsd } from "@/hosted/billing/wallet/wallet-debit-summary";
import {
	SUBSCRIPTION_WALLET_FUNDING_ERROR_COPY,
	useWalletTopUpDialog,
} from "@/hosted/billing/wallet/wallet-funding";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";
import { useProductAccess } from "@/lib/product-access";
import { shouldBlockQueryError } from "@/lib/query-state";

const PLAN_ITEMS = [
	{ value: "compute_basic", label: "Basic" },
	{ value: "compute_performance", label: "Performance" },
] as const;

function computePlanSlug(value: string | null): ComputePlanSlug | null {
	return value === "compute_basic" || value === "compute_performance" ? value : null;
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
	const queryClient = useQueryClient();
	const billingClient = useBillingClient();
	const hostedAccess = useProductAccess();
	const createSubscription = useSensitiveCreateSubscription();
	const runAction = useActionLock();
	const createAttemptRef = useRef<IdempotencyAttempt | null>(null);
	const [planSlug, setPlanSlug] = useState(initialPlanSlug);
	const [billingTermMonths, setBillingTermMonths] = useState(initialBillingTermMonths);
	const [fundingSource, setFundingSource] = useState<SubscriptionFundingSource>("stripe");
	const [selectedSource, setSource] = useState<SubscriptionSource | null>(null);
	const reusableSubscriptions = useReusableSubscriptions(
		billingClient,
		open && hostedAccess.canCreateCloudAgents,
	);
	const source = resolveSubscriptionSource({
		selected: selectedSource,
		includedAvailable: false,
		reusableSubscriptions:
			reusableSubscriptions.error == null ? reusableSubscriptions.data : undefined,
	});
	const selectedReusableSubscription =
		source?.mode === "existing"
			? (reusableSubscriptions.data?.find(
					(subscription) => subscription.subscription_id === source.subscriptionId,
				) ?? null)
			: null;
	const walletTopUp = useWalletTopUpDialog(SUBSCRIPTION_WALLET_FUNDING_ERROR_COPY);
	const selectedPlan = useMemo(() => planForSlug(plans, planSlug), [planSlug, plans]);
	const offers = useMemo(() => offersForPlan(selectedPlan, planSlug), [planSlug, selectedPlan]);
	const selectedOffer =
		offers.find((offer) => offer.billing_term_months === billingTermMonths) ?? null;
	const selectedPrice = selectedOffer ? computePricePresentation(selectedOffer, offers) : null;
	const cardTrial =
		fundingSource === "stripe" && selectedOffer && selectedPrice
			? cardTrialPricePresentation(selectedPrice.primary, selectedOffer.card_trial_period_days)
			: null;
	const supportedTerm = supportedBillingTerm(billingTermMonths);
	const newSubscriptionSelection: SubscriptionCreateSelection | null =
		supportedTerm && selectedOffer
			? {
					planSlug,
					billingTermMonths: supportedTerm,
					fundingSource,
				}
			: null;
	const createSelection = selectedReusableSubscription
		? existingSubscriptionCreateSelection(selectedReusableSubscription)
		: source?.mode === "new"
			? newSubscriptionSelection
			: null;
	const wallet = useWalletSnapshot({
		enabled:
			open &&
			hostedAccess.canCreateCloudAgents &&
			source?.mode === "new" &&
			fundingSource === "wallet",
	});
	const createQuote = useSubscriptionCreateQuote(createSelection, {
		enabled:
			open &&
			hostedAccess.canCreateCloudAgents &&
			source?.mode === "new" &&
			fundingSource === "wallet",
	});
	const walletDebit = createQuote.data?.walletDebit ?? null;
	const blockingCreateQuoteError = shouldBlockQueryError(createQuote.error, createQuote.data)
		? createQuote.error
		: null;
	const walletShortfallUsd = walletDebitShortfallUsd(walletDebit);
	const walletInsufficient = walletShortfallUsd !== null;
	const isPending = createSubscription.isPending;
	const submitLabel = !hostedAccess.canCreateCloudAgents
		? "Temporarily unavailable"
		: source?.mode === "existing"
			? "Use subscription"
			: fundingSource === "wallet" && walletDebit
				? `Pay ${formatUsdExact(walletDebit.debitAmountUsd)} from Wallet`
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
		setSource(null);
		walletTopUp.reset();
	}, [initialBillingTermMonths, initialPlanSlug, open, plans, walletTopUp.reset]);

	useEffect(() => {
		if (open && !hostedAccess.isLoading && !hostedAccess.canCreateCloudAgents) {
			onOpenChange(false);
		}
	}, [hostedAccess.canCreateCloudAgents, hostedAccess.isLoading, onOpenChange, open]);

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

	async function create() {
		if (
			!hostedAccess.canCreateCloudAgents ||
			!source ||
			source.mode === "included" ||
			!createSelection ||
			isPending ||
			reusableSubscriptions.isFetching ||
			reusableSubscriptions.error != null ||
			reusableSubscriptions.data === undefined ||
			(source.mode === "new" && !selectedOffer) ||
			(source.mode === "new" && fundingSource === "wallet" && (!walletDebit || walletInsufficient))
		) {
			return;
		}
		const target = { kind: "terminal_fallback", deploymentId } as const;
		const subscriptionSelection: SubscriptionSelection =
			source.mode === "existing"
				? { mode: "existing", subscription_id: source.subscriptionId }
				: { mode: "new" };
		const fingerprint = idempotencyFingerprint({
			selection: createSelection,
			subscriptionSelection,
			target,
		});
		try {
			if (!(await hostedAccess.recheckCanCreateCloudAgents())) {
				onOpenChange(false);
				return;
			}
			createAttemptRef.current = idempotencyAttemptFor(
				createAttemptRef.current,
				"subscription-terminal-fallback",
				fingerprint,
				newIdempotencyKey,
			);
			const execute = (attempt: IdempotencyAttempt) =>
				createSubscription.execute({
					selection: createSelection,
					subscriptionSelection,
					target,
					uiMode: "hosted",
					idempotencyKey: attempt.key,
					quote: source.mode === "new" ? (createQuote.data ?? null) : null,
				});
			const outcome = await execute(createAttemptRef.current).catch((error: unknown) => {
				if (
					source.mode !== "new" ||
					fundingSource !== "stripe" ||
					billingErrorDetail(error)?.code !== "checkout_attempt_expired"
				)
					throw error;
				forgetIdempotencyAttempt("subscription-terminal-fallback", fingerprint);
				createAttemptRef.current = idempotencyAttemptFor(
					null,
					"subscription-terminal-fallback",
					fingerprint,
					newIdempotencyKey,
				);
				// Only this first failure is retried; a second failure reaches the outer handler.
				return execute(createAttemptRef.current);
			});
			if (outcome.flowType === "subscription_activation") {
				forgetIdempotencyAttempt("subscription-terminal-fallback", fingerprint);
				createAttemptRef.current = null;
				toast.success(
					source.mode === "existing" ? "Subscription assigned" : "Subscription started",
					{
						description:
							source.mode === "existing"
								? "Compute updates after the existing subscription is assigned."
								: fundingSource === "wallet"
									? `${walletDebit ? formatUsdExact(walletDebit.debitAmountUsd) : formatCents(selectedOffer?.price_cents ?? 0)} was paid from Wallet. Compute updates after payment is projected.`
									: "Card payment was confirmed. Compute updates after payment is projected.",
					},
				);
				onOpenChange(false);
				return;
			}

			const checkoutUrl = checkoutRedirectUrl(outcome.checkout);
			if (source.mode === "existing") {
				throw new Error("Existing subscription assignment unexpectedly returned checkout.");
			}
			if (checkoutUrl) {
				window.location.href = checkoutUrl;
				return;
			}
			toast.error("Couldn’t start checkout", {
				description: "No checkout URL was returned. Please try again.",
			});
		} catch (error) {
			if (isReusableSubscriptionUnavailableError(error)) {
				if (createAttemptRef.current) {
					forgetIdempotencyAttempt(
						"subscription-terminal-fallback",
						createAttemptRef.current.fingerprint,
					);
					createAttemptRef.current = null;
				}
				setSource(null);
				await queryClient.invalidateQueries({
					queryKey: billingKeys.reusableSubscriptions,
					refetchType: "none",
				});
				await reusableSubscriptions.refetch();
				toast.error("Subscription no longer available", {
					description: "Choose a current reusable subscription or start a new one.",
				});
				return;
			}
			if (source.mode === "new" && fundingSource === "wallet") {
				void createQuote.refetch();
				if (walletTopUp.handleFundingError(error)) return;
			}
			if (
				(isIdempotencyKeyReusedError(error) ||
					billingErrorDetail(error)?.code === "checkout_attempt_expired") &&
				createAttemptRef.current
			) {
				forgetIdempotencyAttempt(
					"subscription-terminal-fallback",
					createAttemptRef.current.fingerprint,
				);
				createAttemptRef.current = null;
			}
			toast.error("Couldn’t start subscription", {
				description: normalizeBillingError(error),
			});
		}
	}

	const submitDisabled =
		!hostedAccess.canCreateCloudAgents ||
		!source ||
		source.mode === "included" ||
		!createSelection ||
		isPending ||
		reusableSubscriptions.isFetching ||
		reusableSubscriptions.error != null ||
		reusableSubscriptions.data === undefined ||
		(source.mode === "new" && !selectedOffer) ||
		(source.mode === "new" &&
			fundingSource === "wallet" &&
			(!walletDebit || blockingCreateQuoteError !== null || walletInsufficient));

	return (
		<>
			<Dialog
				open={open}
				onOpenChange={(nextOpen) => {
					if (!isPending && !walletTopUp.dialogProps.open) onOpenChange(nextOpen);
				}}
			>
				<DialogContent
					data-hosted="true"
					className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-x-hidden overflow-y-auto sm:max-w-lg [&>*]:min-w-0"
					showCloseButton={!isPending}
				>
					<DialogHeader>
						<DialogTitle>Choose a paid subscription</DialogTitle>
						<DialogDescription>
							Assign an available subscription or start a new one for this agent.
						</DialogDescription>
					</DialogHeader>

					<div className="flex min-w-0 flex-col gap-5">
						<SubscriptionSourcePicker
							value={source}
							onChange={setSource}
							reusableSubscriptions={reusableSubscriptions.data ?? []}
							isLoading={reusableSubscriptions.isFetching}
							error={reusableSubscriptions.error}
							onRetry={() => void reusableSubscriptions.refetch()}
							disabled={isPending}
						/>

						{source?.mode === "new" ? (
							<>
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

								{selectedOffer && selectedPrice ? (
									<div className="flex flex-col gap-1 text-sm text-muted-foreground">
										<span>
											{computeTierLabel(planSlug)} · {billingTermLabel(billingTermMonths)}
										</span>
										<span className="text-base font-semibold text-foreground tabular-nums">
											{selectedPrice.primary}
										</span>
										<p className="text-xs tabular-nums">
											{cardTrial?.label ?? selectedPrice.secondary}
											{cardTrial && billingTermMonths > 1 ? (
												<> · {selectedPrice.secondary}</>
											) : null}
										</p>
									</div>
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
									createQuote.isFetching && !createQuote.data ? (
										<p className="text-sm text-muted-foreground" role="status">
											Getting the exact wallet debit…
										</p>
									) : blockingCreateQuoteError ? (
										<ApiErrorPanel
											normalizer={billingErrorNormalizer}
											error={blockingCreateQuoteError}
											onRetry={() => void createQuote.refetch()}
											title="Couldn’t get subscription quote"
										/>
									) : walletDebit ? (
										<div className="flex flex-col gap-3">
											<WalletDebitEquation
												balanceBeforeUsd={walletDebit.balanceBeforeUsd}
												debitAmountUsd={walletDebit.debitAmountUsd}
												balanceAfterUsd={walletDebit.balanceAfterUsd}
											/>
											{walletInsufficient ? (
												<Alert variant="destructive">
													<TriangleAlert aria-hidden />
													<AlertTitle>Not enough Wallet balance</AlertTitle>
													<AlertDescription className="flex flex-col items-start gap-3">
														<span>Top up the shortfall, then review a fresh wallet quote.</span>
														<Button
															type="button"
															size="sm"
															variant="outline"
															disabled={!wallet.data}
															onClick={() => walletTopUp.show(walletShortfallUsd)}
														>
															<WalletCards data-icon="inline-start" /> Top up Wallet
														</Button>
													</AlertDescription>
												</Alert>
											) : null}
										</div>
									) : null
								) : null}
							</>
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
								) : source?.mode === "existing" ? null : fundingSource === "wallet" ? (
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

			{source?.mode === "new" && wallet.data ? (
				<TopUpDialog {...walletTopUp.dialogProps} onComplete={() => void createQuote.refetch()} />
			) : null}
		</>
	);
}
