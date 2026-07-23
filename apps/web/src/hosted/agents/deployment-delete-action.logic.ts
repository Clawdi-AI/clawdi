import type { HostedDeployment } from "@/hosted/billing/contracts";
import {
	computeFundingMode,
	isComputeSubscriptionRenewing,
} from "@/hosted/billing/subscription/subscription-utils";

export type DeploymentDeleteChoice = "keep_subscription" | "cancel_subscription";

export function offersSubscriptionDeleteChoice(deployment: HostedDeployment): boolean {
	const subscription = deployment.commercial_display?.compute_subscription;
	return (
		computeFundingMode(deployment.current_plan_slug, subscription) === "subscription" &&
		isComputeSubscriptionRenewing(subscription)
	);
}

export async function deleteDeploymentWithSubscriptionChoice({
	choice,
	cancelSubscription,
	deleteDeployment,
}: {
	choice: DeploymentDeleteChoice;
	cancelSubscription: () => Promise<void>;
	deleteDeployment: () => Promise<void>;
}): Promise<void> {
	// Deleting first unbinds the subscription, so a later cancellation request
	// could no longer resolve it by deployment_id. Persist cancellation intent
	// before teardown and never delete when that first mutation fails.
	if (choice === "cancel_subscription") await cancelSubscription();
	await deleteDeployment();
}
