import type { DeploymentMutation, DeploymentRead } from "@clawdi/shared/api";
import {
	computeFundingMode,
	computeFundingSource,
	isComputeSubscriptionRenewing,
	storeAgentDeletionNotice,
} from "@clawdi/shared/view";

type HostedComputeSubscription = NonNullable<
	NonNullable<DeploymentRead["commercial_display"]>["compute_subscription"]
>;
type DeleteTarget = {
	current_plan_slug?: DeploymentRead["current_plan_slug"];
	commercial_display?: { compute_subscription?: HostedComputeSubscription | null } | null;
};
type SubscriptionChoice = Extract<
	DeploymentMutation,
	{ action: "delete" }
>["body"]["subscription_choice"];

/**
 * Mirrors Web's delete action (#1767): Included Basic is released with the Agent, a
 * renewing card/Wallet subscription is the owner's choice, and anything else is kept.
 * Deleting never cancels App Store/Google Play billing, so store rows offer no choice
 * and show the store notice instead.
 */
export function deploymentDeleteSubscriptionPolicy(deployment: DeleteTarget | null | undefined): {
	offerChoice: boolean;
	defaultChoice: SubscriptionChoice;
	storeNotice: string | null;
} {
	const subscription = deployment?.commercial_display?.compute_subscription;
	const fundingMode = computeFundingMode(deployment?.current_plan_slug, subscription);
	if (computeFundingSource(deployment?.current_plan_slug, subscription) === "store") {
		return {
			offerChoice: false,
			defaultChoice: "keep_subscription",
			storeNotice: storeAgentDeletionNotice(subscription?.store_management),
		};
	}
	return {
		offerChoice: fundingMode === "subscription" && isComputeSubscriptionRenewing(subscription),
		defaultChoice: fundingMode === "included_basic" ? "cancel_subscription" : "keep_subscription",
		storeNotice: null,
	};
}
