"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
	ComputePlanChangeQuoteRequest,
	ComputePlanChangeQuoteResponse,
	ComputePlanChangeResult,
	ComputePlanSlug,
	Plan,
} from "@/hosted/billing/contracts";
import {
	isPaymentMethodRequiredError,
	normalizeBillingError,
	PlanChangePendingError,
	PlanChangeTerminalError,
} from "@/hosted/billing/errors";
import { useChangePlan, useCheckPlanChange, useQuotePlanChange } from "@/hosted/billing/hooks";
import { useSensitiveBillingPortal } from "@/hosted/billing/sensitive-actions";
import {
	isCombinedPaidPlanChange,
	isFundingSourceOnlySelection,
	isValidPaidPlanChangeQuote,
	type PlanChangeSelection,
	planChangeUnavailableReason,
	shouldRecoverWalletToCardSwitch,
	shouldResetUnacceptedPlanChangeQuote,
	visiblePlanChangeOperationName,
} from "@/hosted/billing/subscription/plan-change.logic";
import { PlanChangeDialog } from "@/hosted/billing/subscription/plan-change-dialog";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import {
	useWalletTopUpDialog,
	type WalletFundingErrorCopy,
} from "@/hosted/billing/wallet/wallet-funding";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";
import { formatShortDate } from "@/lib/format";
import { useProductAccess } from "@/lib/product-access";

const PLAN_CHANGE_WALLET_FUNDING_ERROR_COPY = {
	insufficientBalance: "Top up the shortfall, then request a fresh plan-change quote.",
	refundDebt: "Top up before confirming this wallet-funded plan change.",
} satisfies WalletFundingErrorCopy;

export type PlanChangeTarget = {
	deploymentId: string;
	currentPlanSlug: ComputePlanSlug;
	initialPlanSlug: ComputePlanSlug;
	currentBillingTermMonths: ComputePlanChangeQuoteRequest["target_billing_term_months"];
	currentFundingSource: PlanChangeSelection["funding_source"];
	status: string;
	paymentSourceOnly: boolean;
	cancelAtPeriodEnd: boolean;
	isPaidCompute: boolean;
	allowCombinedChange: boolean;
	projectedOperationName: string | null;
};

export function planChangeBillingTerm(
	value: number,
): ComputePlanChangeQuoteRequest["target_billing_term_months"] {
	return value === 12 ? 12 : 1;
}

export function planChangeTargetUnavailableReason({
	canCreateCloudAgents,
	target,
}: {
	canCreateCloudAgents: boolean;
	target: PlanChangeTarget;
}): string | null {
	return planChangeUnavailableReason({
		canCreateCloudAgents,
		cancelAtPeriodEnd: target.cancelAtPeriodEnd,
		status: target.status,
		hasSubscriptionTarget: target.deploymentId.trim().length > 0,
	});
}

export function planChangeTargetFingerprint(target: PlanChangeTarget): string {
	return [
		target.deploymentId.trim(),
		target.currentPlanSlug,
		target.initialPlanSlug,
		target.currentBillingTermMonths,
		target.currentFundingSource,
		target.status,
		target.paymentSourceOnly ? "payment-source-only" : "full-management",
		target.cancelAtPeriodEnd ? "canceling" : "renewing",
		target.isPaidCompute ? "paid-compute" : "included-compute",
		target.allowCombinedChange ? "combined-change" : "single-change",
	].join(":");
}

export function PlanChangeController({
	...props
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onPendingChange?: (pending: boolean) => void;
	target: PlanChangeTarget;
	plans: Plan[];
}) {
	return <PlanChangeControllerState key={planChangeTargetFingerprint(props.target)} {...props} />;
}

function PlanChangeControllerState({
	open,
	onOpenChange,
	onPendingChange,
	target,
	plans,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onPendingChange?: (pending: boolean) => void;
	target: PlanChangeTarget;
	plans: Plan[];
}) {
	const hostedAccess = useProductAccess();
	const quotePlanChange = useQuotePlanChange();
	const billingPortal = useSensitiveBillingPortal();
	const [acceptedOperationName, setAcceptedOperationName] = useState<string | null>(null);
	const [ignoredOperationNames, setIgnoredOperationNames] = useState<readonly string[]>([]);
	const [quote, setQuote] = useState<ComputePlanChangeQuoteResponse | null>(null);
	const [paymentMethodRequired, setPaymentMethodRequired] = useState(false);
	const walletTopUp = useWalletTopUpDialog(PLAN_CHANGE_WALLET_FUNDING_ERROR_COPY);
	const deploymentId = target.deploymentId.trim();
	const projectedOperationName = visiblePlanChangeOperationName(
		target.projectedOperationName,
		ignoredOperationNames,
	);
	const pendingOperationName = acceptedOperationName ?? projectedOperationName;
	const changePlan = useChangePlan(setAcceptedOperationName);
	const checkPlanChange = useCheckPlanChange();
	const wallet = useWalletSnapshot({
		enabled:
			target.currentFundingSource === "wallet" || (hostedAccess.canCreateCloudAgents && open),
	});
	const unavailableReason = planChangeTargetUnavailableReason({
		canCreateCloudAgents: hostedAccess.canCreateCloudAgents,
		target,
	});
	useEffect(() => {
		onPendingChange?.(pendingOperationName !== null);
	}, [onPendingChange, pendingOperationName]);

	useEffect(() => {
		if (hostedAccess.isLoading || hostedAccess.canCreateCloudAgents) return;
		onOpenChange(false);
		setAcceptedOperationName(null);
		walletTopUp.reset();
	}, [hostedAccess.canCreateCloudAgents, hostedAccess.isLoading, onOpenChange, walletTopUp.reset]);

	function ignoreOperation(operationName: string | null) {
		if (operationName === null) return;
		setIgnoredOperationNames((current) =>
			current.includes(operationName) ? current : [...current, operationName],
		);
	}

	async function openPaymentMethods() {
		ignoreOperation(pendingOperationName);
		setQuote(null);
		setPaymentMethodRequired(false);
		setAcceptedOperationName(null);
		try {
			const result = await billingPortal.execute({});
			const url = result.url || result.portal_url;
			if (url) {
				window.location.href = url;
				return;
			}
			toast.error("Billing portal unavailable", {
				description: "Refresh this page and try again in a moment.",
			});
			setPaymentMethodRequired(true);
		} catch (error) {
			setPaymentMethodRequired(true);
			toast.error("Couldn’t open billing", { description: normalizeBillingError(error) });
		}
	}

	async function requestQuote(selection: PlanChangeSelection) {
		if (!deploymentId || unavailableReason !== null) return;
		if (
			target.paymentSourceOnly &&
			!isFundingSourceOnlySelection(
				selection,
				target.currentPlanSlug,
				target.currentBillingTermMonths,
				target.currentFundingSource,
			)
		) {
			toast.error("Only the payment source can be changed", {
				description:
					"This subscription can’t change plan or billing term while past due. Choose a different payment source to continue.",
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
			toast.error("Choose one subscription change", {
				description:
					"Change the plan or billing term using the current payment source, or change only the payment source.",
			});
			return;
		}
		try {
			if (pendingOperationName === null && !(await hostedAccess.recheckCanCreateCloudAgents())) {
				onOpenChange(false);
				return;
			}
			const nextQuote = await quotePlanChange.mutateAsync({
				deployment_id: deploymentId,
				...selection,
			});
			if (
				target.isPaidCompute &&
				!isValidPaidPlanChangeQuote(
					nextQuote,
					selection,
					target.currentPlanSlug,
					target.currentBillingTermMonths,
					target.currentFundingSource,
				)
			) {
				setQuote(null);
				setAcceptedOperationName(null);
				setPaymentMethodRequired(false);
				toast.error("Couldn’t verify subscription change", {
					description: "The quote did not match the requested change. Request a fresh quote.",
				});
				return;
			}
			setAcceptedOperationName(null);
			setPaymentMethodRequired(false);
			setQuote(nextQuote);
		} catch (error) {
			if (
				target.isPaidCompute &&
				shouldRecoverWalletToCardSwitch(
					error,
					selection,
					target.currentPlanSlug,
					target.currentBillingTermMonths,
					target.currentFundingSource,
				)
			) {
				setQuote(null);
				setAcceptedOperationName(null);
				setPaymentMethodRequired(true);
				return;
			}
			toast.error("Couldn’t quote subscription change", {
				description: normalizeBillingError(error),
			});
		}
	}

	function showResult(result: ComputePlanChangeResult) {
		if (result.kind === "scheduled") {
			toast.success("Downgrade scheduled", {
				description: `Your current compute remains active until ${formatShortDate(result.effectiveAt)}.`,
			});
		} else if (result.changeKind === "funding_source_switch") {
			toast.success("Payment method updated", {
				description:
					result.fundingSource === "wallet"
						? "Future renewals will use Wallet."
						: "Future renewals will use Card.",
			});
		} else {
			toast.success("Plan changed", {
				description: "Your compute subscription has been updated.",
			});
		}
		setAcceptedOperationName(null);
		ignoreOperation(result.operationName);
		setQuote(null);
		setPaymentMethodRequired(false);
		onOpenChange(false);
	}

	function handleError(error: unknown) {
		if (error instanceof PlanChangePendingError) {
			setAcceptedOperationName(error.operationName);
			toast.info("Still waiting for confirmation", {
				description:
					"We don’t have a final result yet. Don’t submit another subscription change. Check again in a few minutes; if it still hasn’t finished, contact support. Checking only reads the status and does not submit another request or charge.",
			});
			return;
		}
		if (error instanceof PlanChangeTerminalError) {
			setAcceptedOperationName(null);
			ignoreOperation(error.operationName ?? pendingOperationName);
			setQuote(null);
			setPaymentMethodRequired(false);
			if (
				error.fundingSource === "stripe" &&
				error.changeKind === "funding_source_switch" &&
				isPaymentMethodRequiredError(error)
			) {
				setPaymentMethodRequired(true);
				return;
			}
		}
		if (shouldResetUnacceptedPlanChangeQuote(error)) {
			setQuote(null);
			setPaymentMethodRequired(false);
			toast.error("Subscription quote is no longer current", {
				description: "Review the latest choices and request a fresh quote.",
			});
			return;
		}
		if (walletTopUp.handleFundingError(error)) return;
		toast.error("Couldn’t update subscription", {
			description: normalizeBillingError(error),
		});
	}

	async function confirm(operationId: string) {
		if (!quote) return;
		try {
			if (!(await hostedAccess.recheckCanCreateCloudAgents())) {
				onOpenChange(false);
				return;
			}
			showResult(await changePlan.mutateAsync({ operation_id: operationId }));
		} catch (error) {
			handleError(error);
		}
	}

	async function checkStatus() {
		if (!pendingOperationName) return;
		try {
			showResult(await checkPlanChange.mutateAsync(pendingOperationName));
		} catch (error) {
			handleError(error);
		}
	}

	return (
		<div data-hosted="true" className="contents">
			{wallet.data ? (
				<TopUpDialog {...walletTopUp.dialogProps} onComplete={() => setQuote(null)} />
			) : null}
			<PlanChangeDialog
				open={open}
				onOpenChange={onOpenChange}
				plans={plans}
				currentPlanSlug={target.currentPlanSlug}
				initialPlanSlug={target.initialPlanSlug}
				currentBillingTermMonths={target.currentBillingTermMonths}
				currentFundingSource={target.currentFundingSource}
				allowCombinedChange={target.allowCombinedChange}
				paymentSourceOnly={target.paymentSourceOnly}
				quote={quote}
				walletBalanceUsd={wallet.data?.balance_usd ?? null}
				isQuoting={quotePlanChange.isPending}
				isConfirming={changePlan.isPending || checkPlanChange.isPending}
				hasAcceptedChange={pendingOperationName !== null}
				onQuote={(selection) => void requestQuote(selection)}
				onConfirm={(operationId) => void confirm(operationId)}
				onCheckStatus={() => void checkStatus()}
				onTopUp={() => walletTopUp.show()}
				paymentMethodRequired={paymentMethodRequired}
				isManagingPaymentMethods={billingPortal.isPending}
				onManagePaymentMethods={() => void openPaymentMethods()}
				onExitComplete={() => {
					if (pendingOperationName === null) {
						setQuote(null);
						setPaymentMethodRequired(false);
					}
				}}
			/>
		</div>
	);
}
