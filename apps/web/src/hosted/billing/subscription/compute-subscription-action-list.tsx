"use client";

import { CalendarX2, Link2Off, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Spinner } from "@/components/ui/spinner";
import type {
	ComputeCancelScheduledPlanChangeRequest,
	ComputeSubscriptionActionResult,
} from "@/hosted/billing/contracts";
import { normalizeBillingError } from "@/hosted/billing/errors";
import {
	useCancelScheduledPlanChange,
	useCancelSubscription,
	useResumeSubscription,
} from "@/hosted/billing/hooks";
import type { ComputeSubscriptionAction } from "@/hosted/billing/subscription/compute-subscription-actions";
import { ComputeSubscriptionPlanAction } from "@/hosted/billing/subscription/compute-subscription-card";
import {
	ComputeSubscriptionRecoveryAction,
	type ComputeSubscriptionStartNewAction,
} from "@/hosted/billing/subscription/compute-subscription-recovery-action";
import { isComputeSubscriptionActionUnconfirmed } from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";

export type ComputeSubscriptionActionTarget =
	| { kind: "deployment"; deploymentId: string }
	| { kind: "subscription"; subscriptionId: string; deploymentId: string | null };

export type ComputeSubscriptionCancelCopy = {
	title: string;
	description: ReactNode;
	confirmLabel: string;
	successDescription?: (result: ComputeSubscriptionActionResult) => string | undefined;
};

export function computeSubscriptionActionRequest(
	target: ComputeSubscriptionActionTarget,
): ComputeCancelScheduledPlanChangeRequest {
	return target.kind === "deployment"
		? { deployment_id: target.deploymentId }
		: { subscription_id: target.subscriptionId };
}

export function scheduledPlanCancellationNotice(result: ComputeSubscriptionActionResult): {
	kind: "success" | "info";
	title: string;
	description: string;
} {
	switch (result.action_state) {
		case "removed":
			return {
				kind: "success",
				title: "Scheduled plan change canceled",
				description: "Your current plan will stay in place.",
			};
		case "pending":
			return {
				kind: "info",
				title: "Cancellation is still processing",
				description:
					"The scheduled plan change is still being removed. Subscription details will refresh automatically.",
			};
		case "reconciling":
			return {
				kind: "info",
				title: "Subscription details are updating",
				description:
					"The cancellation was accepted, but subscription details are still updating. Check again in a moment.",
			};
		default:
			return {
				kind: "info",
				title: "Cancellation status is still updating",
				description: "Refresh the subscription details before trying again.",
			};
	}
}

export function subscriptionMutationNotice(
	result: ComputeSubscriptionActionResult,
	action: "cancel" | "resume",
	successDescription?: string,
): { kind: "success" | "info"; title: string; description?: string } {
	const confirmed =
		action === "cancel"
			? result.cancel_at_period_end || result.status === "canceled"
			: !result.cancel_at_period_end && ["active", "trialing", "past_due"].includes(result.status);
	if (isComputeSubscriptionActionUnconfirmed(result) || !confirmed) {
		return {
			kind: "info",
			title: action === "cancel" ? "Cancellation is still processing" : "Renewal is still updating",
			description: "Check the latest subscription details in a moment before trying again.",
		};
	}
	return {
		kind: "success",
		title:
			action === "resume"
				? "Subscription renewal restored"
				: result.cancel_at_period_end
					? "Cancellation scheduled"
					: "Subscription canceled",
		description: successDescription,
	};
}

export function ComputeSubscriptionActionList({
	actions,
	target,
	onPlanChange,
	onStartNew,
	cancelCopy,
	checkChangeHref,
	primaryVariant,
	startNewIcon,
}: {
	actions: readonly ComputeSubscriptionAction[];
	target: ComputeSubscriptionActionTarget;
	onPlanChange?: () => void;
	onStartNew: ComputeSubscriptionStartNewAction | null;
	cancelCopy?: ComputeSubscriptionCancelCopy;
	checkChangeHref?: string;
	primaryVariant?: "default" | "destructive";
	startNewIcon?: "plus" | "settings";
}) {
	const cancelSubscription = useCancelSubscription();
	const resumeSubscription = useResumeSubscription();
	const cancelScheduledPlanChange = useCancelScheduledPlanChange();
	const runAction = useActionLock();
	const pending =
		cancelSubscription.isPending ||
		resumeSubscription.isPending ||
		cancelScheduledPlanChange.isPending;
	const actionTarget = computeSubscriptionActionRequest(target);
	const paymentRecoveryDeploymentId = target.deploymentId;

	async function cancel() {
		try {
			const result = await cancelSubscription.mutateAsync(actionTarget);
			const notice = subscriptionMutationNotice(
				result,
				"cancel",
				cancelCopy?.successDescription?.(result),
			);
			toast[notice.kind](notice.title, { description: notice.description });
		} catch (error) {
			toast.error("Couldn't cancel subscription", { description: normalizeBillingError(error) });
			throw error;
		}
	}

	async function resume() {
		try {
			const result = await resumeSubscription.mutateAsync(actionTarget);
			const notice = subscriptionMutationNotice(result, "resume");
			toast[notice.kind](notice.title, { description: notice.description });
		} catch (error) {
			toast.error("Couldn't resume subscription", { description: normalizeBillingError(error) });
			throw error;
		}
	}

	async function cancelScheduledChange() {
		try {
			const result = await cancelScheduledPlanChange.mutateAsync(actionTarget);
			const notice = scheduledPlanCancellationNotice(result);
			toast[notice.kind](notice.title, { description: notice.description });
		} catch (error) {
			toast.error("Couldn't cancel scheduled plan change", {
				description: normalizeBillingError(error),
			});
			throw error;
		}
	}

	return actions.map((candidate) => {
		switch (candidate.kind) {
			case "upgrade":
			case "manage":
				return (
					<ComputeSubscriptionPlanAction
						key={candidate.kind}
						action={candidate.kind}
						onClick={() => onPlanChange?.()}
						disabled={!onPlanChange || candidate.disabledReason !== null}
					/>
				);
			case "check_change":
				if (checkChangeHref) {
					return (
						<Button
							data-hosted="true"
							key={candidate.kind}
							render={<a href={checkChangeHref} />}
							nativeButton={false}
							size="sm"
							variant={primaryVariant ?? "outline"}
							disabled={candidate.disabledReason !== null}
						>
							<RefreshCw data-icon="inline-start" />
							Check subscription change status
						</Button>
					);
				}
				return (
					<Button
						data-hosted="true"
						key={candidate.kind}
						type="button"
						variant="outline"
						size="sm"
						disabled={!onPlanChange || candidate.disabledReason !== null}
						onClick={onPlanChange}
					>
						<RefreshCw data-icon="inline-start" />
						Check subscription change status
					</Button>
				);
			case "fix_payment":
			case "top_up":
			case "start_new":
				return (
					<ComputeSubscriptionRecoveryAction
						key={candidate.kind}
						target={candidate.recoveryTarget}
						deploymentId={paymentRecoveryDeploymentId}
						startNewAction={onStartNew}
						disabled={candidate.disabledReason !== null}
						variant={primaryVariant}
						startNewIcon={startNewIcon}
					/>
				);
			case "resume":
				return (
					<Button
						data-hosted="true"
						key={candidate.kind}
						type="button"
						variant="outline"
						size="sm"
						disabled={pending || candidate.disabledReason !== null}
						onClick={() => void runAction(resume).catch(() => undefined)}
					>
						{resumeSubscription.isPending ? <Spinner /> : <RefreshCw />}
						Keep subscription
					</Button>
				);
			case "end_trial":
			case "cancel":
				if (!cancelCopy) return null;
				return (
					<ConfirmAction
						key={candidate.kind}
						title={cancelCopy.title}
						description={cancelCopy.description}
						confirmLabel={cancelCopy.confirmLabel}
						destructive
						onConfirm={() => runAction(cancel)}
					>
						<Button
							data-hosted="true"
							type="button"
							variant="outline"
							size="sm"
							disabled={pending || candidate.disabledReason !== null}
						>
							{cancelSubscription.isPending ? <Spinner /> : <Link2Off />}
							{candidate.kind === "end_trial" ? "End trial now" : "Cancel subscription"}
						</Button>
					</ConfirmAction>
				);
			case "cancel_scheduled_change":
				return (
					<Button
						data-hosted="true"
						key={candidate.kind}
						type="button"
						variant="outline"
						size="sm"
						disabled={pending || candidate.disabledReason !== null}
						onClick={() => void runAction(cancelScheduledChange).catch(() => undefined)}
					>
						{cancelScheduledPlanChange.isPending ? <Spinner /> : <CalendarX2 />}
						Cancel scheduled change
					</Button>
				);
		}
		return null;
	});
}
