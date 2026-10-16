"use client";

import {
	planChangeCopy as copy,
	formatShortDate,
	planChangeTargetFingerprint,
} from "@clawdi/shared/view";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
	ComputePlanChangeQuoteResponse,
	ComputePlanChangeResult,
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
import { useProductAccess } from "@/lib/product-access";

const PLAN_CHANGE_WALLET_FUNDING_ERROR_COPY: WalletFundingErrorCopy = copy.walletFunding;

export {
	type PlanChangeTarget,
	planChangeBillingTerm,
	planChangeTargetUnavailableReason,
} from "@clawdi/shared/view";

import { type PlanChangeTarget, planChangeTargetUnavailableReason } from "@clawdi/shared/view";

export { planChangeTargetFingerprint };

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
			const result = await billingPortal.execute({ return_context: "compute" });
			const url = result.url || result.portal_url;
			if (url) {
				window.location.href = url;
				return;
			}
			toast.error(copy.portalUnavailableTitle, {
				description: copy.portalUnavailableDescription,
			});
			setPaymentMethodRequired(true);
		} catch (error) {
			setPaymentMethodRequired(true);
			toast.error(copy.openBillingFailed, { description: normalizeBillingError(error) });
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
			toast.error(copy.paymentSourceOnlyTitle, {
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
			toast.error(copy.oneChangeTitle, {
				description: copy.oneChangeDescription,
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
				toast.error(copy.quoteMismatchTitle, {
					description: copy.quoteMismatchDescription,
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
			toast.error(copy.quoteFailed, {
				description: normalizeBillingError(error),
			});
		}
	}

	function showResult(result: ComputePlanChangeResult) {
		if (result.kind === "scheduled") {
			toast.success(copy.downgradeScheduledTitle, {
				description: copy.downgradeScheduledDescription(formatShortDate(result.effectiveAt)),
			});
		} else if (result.changeKind === "funding_source_switch") {
			toast.success(copy.paymentMethodUpdatedTitle, {
				description: copy.paymentMethodUpdatedDescription(result.fundingSource),
			});
		} else {
			toast.success(copy.planChangedTitle, {
				description: copy.planChangedDescription,
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
			toast.info(copy.stillWaitingTitle, {
				description: copy.stillWaitingNotice,
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
			toast.error(copy.quoteStaleTitle, {
				description: copy.quoteStaleDescription,
			});
			return;
		}
		if (walletTopUp.handleFundingError(error)) return;
		toast.error(copy.updateFailed, {
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
