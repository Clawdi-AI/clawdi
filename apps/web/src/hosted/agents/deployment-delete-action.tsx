"use client";

import { useRouter } from "@tanstack/react-router";
import { type ReactElement, useRef, useState } from "react";
import { agentDisplayName } from "@/components/dashboard/agent-label";
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
import { useDeleteDeployment } from "@/hosted/agents/deployment-hooks";
import type { DeploymentDeleteRequest, HostedDeployment } from "@/hosted/billing/contracts";
import {
	computeFundingMode,
	computeSubscriptionCancellationCopy,
	isComputeSubscriptionRenewing,
} from "@/hosted/billing/subscription/subscription-utils";
import { formatShortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export function HostedDeploymentDeleteAction({
	children,
	deployment,
	onAccepted,
}: {
	children: ReactElement;
	deployment: HostedDeployment;
	onAccepted?: () => Promise<void> | void;
}) {
	const router = useRouter();
	const deleteDeployment = useDeleteDeployment(
		onAccepted ?? (() => router.navigate({ href: "/", replace: true })),
	);
	const [open, setOpen] = useState(false);
	const [choice, setChoice] =
		useState<DeploymentDeleteRequest["subscription_choice"]>("cancel_subscription");
	const [pending, setPending] = useState(false);
	const locked = useRef(false);
	const subscription = deployment.commercial_display?.compute_subscription;
	const includedBasic =
		computeFundingMode(deployment.current_plan_slug, subscription) === "included_basic";
	const offerChoice =
		computeFundingMode(deployment.current_plan_slug, subscription) === "subscription" &&
		isComputeSubscriptionRenewing(subscription);
	const periodEnd = formatShortDate(subscription?.current_period_end);
	const name = agentDisplayName({
		name: deployment.resource.name,
		agent_type: deployment.resource.spec.runtime,
	});

	async function runDelete() {
		if (locked.current) return;
		locked.current = true;
		setPending(true);
		try {
			try {
				await deleteDeployment.mutateAsync({
					id: deployment.resource.id,
					resourceVersion: deployment.resource.metadata.resourceVersion,
					request: {
						subscription_choice: offerChoice
							? choice
							: includedBasic
								? "cancel_subscription"
								: "keep_subscription",
					},
				});
			} catch {
				// The mutation owns failure feedback. Keep this detail page in place.
				return;
			}
			setOpen(false);
		} finally {
			setPending(false);
			locked.current = false;
		}
	}

	const keepDescription = `Keep subscription — it becomes available to choose for a future Agent.${
		periodEnd === "—" ? "" : ` Valid through ${periodEnd}.`
	}`;
	const cancelDescription = computeSubscriptionCancellationCopy({
		isTrial: subscription?.status === "trialing",
		periodEndLabel: periodEnd === "—" ? null : periodEnd,
		hasRetainedDeployment: false,
	}).description;

	return (
		<AlertDialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (pending) return;
				if (nextOpen) setChoice("cancel_subscription");
				setOpen(nextOpen);
			}}
		>
			<AlertDialogTrigger render={children} />
			<AlertDialogContent data-hosted="true">
				<AlertDialogHeader>
					<AlertDialogTitle>{`Delete ${name}?`}</AlertDialogTitle>
					<AlertDialogDescription>
						This permanently deletes the agent and its saved data. This can’t be undone.
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
