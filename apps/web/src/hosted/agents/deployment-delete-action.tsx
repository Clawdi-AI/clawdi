"use client";

import { type ReactElement, useRef, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { deploymentDisplayName } from "@/hosted/agent-identity";
import {
	type DeploymentDeleteChoice,
	deleteDeploymentWithSubscriptionChoice,
	offersSubscriptionDeleteChoice,
} from "@/hosted/agents/deployment-delete-action.logic";
import { useDeleteDeployment } from "@/hosted/agents/deployment-hooks";
import type { ComputeSubscriptionActionResult, HostedDeployment } from "@/hosted/billing/contracts";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { useCancelSubscription } from "@/hosted/billing/hooks";
import { formatShortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export function HostedDeploymentDeleteAction({
	children,
	deployment,
	onDeleted,
}: {
	children: ReactElement;
	deployment: HostedDeployment;
	onDeleted?: () => Promise<void> | void;
}) {
	const deleteDeployment = useDeleteDeployment();
	const cancelSubscription = useCancelSubscription();
	const [open, setOpen] = useState(false);
	const [choice, setChoice] = useState<DeploymentDeleteChoice>("keep_subscription");
	const [pending, setPending] = useState(false);
	const locked = useRef(false);
	const subscription = deployment.commercial_display?.compute_subscription;
	const offerChoice = offersSubscriptionDeleteChoice(deployment);
	const periodEnd = formatShortDate(subscription?.current_period_end);
	const name = deploymentDisplayName(deployment.resource.spec.name);

	async function runDelete() {
		if (locked.current) return;
		locked.current = true;
		setPending(true);
		const cancellationState: {
			recorded: boolean;
			result: ComputeSubscriptionActionResult | null;
		} = { recorded: false, result: null };
		let deletionCompleted = false;
		try {
			await deleteDeploymentWithSubscriptionChoice({
				choice: offerChoice ? choice : "keep_subscription",
				cancelSubscription: async () => {
					cancellationState.result = await cancelSubscription.mutateAsync({
						deployment_id: deployment.resource.id,
					});
					cancellationState.recorded = true;
				},
				deleteDeployment: async () => {
					await deleteDeployment.mutateAsync(deployment.resource.id);
					deletionCompleted = true;
				},
			});
			if (cancellationState.recorded) {
				toast.success("Subscription cancellation scheduled", {
					description: cancellationState.result?.current_period_end
						? `It stops at the end of the current period on ${formatShortDate(
								cancellationState.result.current_period_end,
							)}.`
						: "It stops at the end of the current billing period.",
				});
			}
			setOpen(false);
			await onDeleted?.();
		} catch (error) {
			if (deletionCompleted) {
				toast.error("Agent deleted, but navigation failed", {
					description: "Refresh the page to update the agent list.",
				});
			} else if (offerChoice && choice === "cancel_subscription") {
				if (cancellationState.recorded) {
					toast.warning("Subscription cancellation kept; agent not deleted", {
						description:
							"The subscription will still stop at period end. Retry deleting the agent.",
					});
				} else {
					toast.error("Couldn’t cancel subscription", {
						description: `The agent was not deleted. ${normalizeBillingError(error)}`,
					});
				}
			}
		} finally {
			setPending(false);
			locked.current = false;
		}
	}

	const keepDescription = `Keep subscription — redeploy reuses it, no re-charge.${
		periodEnd === "—" ? "" : ` Valid through ${periodEnd}.`
	}`;
	const cancelDescription = `Stops at period end${periodEnd === "—" ? "." : ` on ${periodEnd}.`}`;

	return (
		<AlertDialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (pending) return;
				if (nextOpen) setChoice("keep_subscription");
				setOpen(nextOpen);
			}}
		>
			<AlertDialogTrigger render={children} />
			<AlertDialogContent data-hosted="true">
				<AlertDialogHeader>
					<AlertDialogTitle>{`Delete ${name}?`}</AlertDialogTitle>
					<AlertDialogDescription>
						The hosted agent and its deployment are torn down. This can’t be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>

				{offerChoice ? (
					<fieldset className="grid gap-2" disabled={pending}>
						<legend className="sr-only">Subscription handling</legend>
						<DeleteChoice
							checked={choice === "keep_subscription"}
							onChange={() => setChoice("keep_subscription")}
							title="Delete agent"
							description={keepDescription}
						/>
						<DeleteChoice
							checked={choice === "cancel_subscription"}
							onChange={() => setChoice("cancel_subscription")}
							title="Delete agent and cancel subscription"
							description={cancelDescription}
						/>
					</fieldset>
				) : subscription?.cancel_at_period_end ? (
					<p className="text-sm text-muted-foreground">
						The subscription is already scheduled to stop at period end; deleting the agent does not
						undo that cancellation.
					</p>
				) : null}

				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>Go back</AlertDialogCancel>
					<AlertDialogAction
						onClick={(event) => {
							event.preventDefault();
							void runDelete();
						}}
						disabled={pending}
						className={buttonVariants({ variant: "destructive" })}
					>
						{pending ? <Spinner /> : null}
						{offerChoice && choice === "keep_subscription"
							? "Delete agent (keep subscription)"
							: offerChoice
								? "Delete agent and cancel subscription"
								: "Delete agent"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

function DeleteChoice({
	checked,
	description,
	onChange,
	title,
}: {
	checked: boolean;
	description: string;
	onChange: () => void;
	title: string;
}) {
	return (
		<label
			className={cn(
				"flex cursor-pointer gap-3 rounded-lg border p-3 text-left transition-colors",
				checked ? "border-primary bg-primary/5" : "hover:bg-muted/50",
			)}
		>
			<input
				type="radio"
				name="subscription-delete-choice"
				checked={checked}
				onChange={onChange}
				className="mt-1 size-4 accent-primary"
			/>
			<span className="grid gap-0.5">
				<span className="text-sm font-medium text-foreground">{title}</span>
				<span className="text-xs text-muted-foreground">{description}</span>
			</span>
		</label>
	);
}
