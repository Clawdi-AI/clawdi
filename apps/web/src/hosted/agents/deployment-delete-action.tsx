"use client";

import {
	agentDisplayName,
	deploymentDeleteCopy,
	deploymentDeleteSubscriptionPolicy,
	formatShortDate,
} from "@clawdi/shared/view";
import { useRouter } from "@tanstack/react-router";
import { type ReactElement, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";

type DeleteSubscriptionChoice = DeploymentDeleteRequest["subscription_choice"];

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
	const [choice, setChoice] = useState<DeleteSubscriptionChoice>("cancel_subscription");
	const [pending, setPending] = useState(false);
	const locked = useRef(false);
	const subscription = deployment.commercial_display?.compute_subscription;
	const { offerChoice, defaultChoice, storeNotice } =
		deploymentDeleteSubscriptionPolicy(deployment);
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
						subscription_choice: offerChoice ? choice : defaultChoice,
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

	const copy = deploymentDeleteCopy({
		name,
		choice,
		offerChoice,
		storeNotice,
		cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
		isTrial: subscription?.status === "trialing",
		periodEndLabel: periodEnd === "—" ? null : periodEnd,
	});

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
					<AlertDialogTitle>{copy.title}</AlertDialogTitle>
					<AlertDialogDescription>{copy.warning}</AlertDialogDescription>
				</AlertDialogHeader>

				{copy.choices.length > 0 ? (
					<fieldset className="grid gap-2" disabled={pending}>
						<legend className="sr-only">Subscription handling</legend>
						{copy.choices.map((option) => (
							<DeleteChoice
								key={option.value}
								checked={choice === option.value}
								onChange={() => setChoice(option.value)}
								title={option.title}
								description={option.description}
							/>
						))}
					</fieldset>
				) : copy.notice ? (
					<p className="text-sm text-muted-foreground">{copy.notice}</p>
				) : null}

				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>{copy.dismissLabel}</AlertDialogCancel>
					<AlertDialogAction
						onClick={(event) => {
							event.preventDefault();
							void runDelete();
						}}
						disabled={pending}
						className={buttonVariants({ variant: "destructive" })}
					>
						{pending ? <Spinner /> : null}
						{copy.confirmLabel}
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
