"use client";

import { computeDunningBannerClasses as styles } from "@clawdi/shared/ui";
import { computeDunningCopy, computeDunningDescription } from "@clawdi/shared/view";
import { Link } from "@tanstack/react-router";
import { History, Info, LifeBuoy, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { ComputeSubscriptionActionList } from "@/hosted/billing/subscription/compute-subscription-action-list";
import { resolveComputeSubscriptionActions } from "@/hosted/billing/subscription/compute-subscription-actions";
import { activePlanChangeOperationName } from "@/hosted/billing/subscription/plan-change.logic";
import { pendingComputePlanSlug } from "@/hosted/billing/subscription/subscription-utils";
import { agentSectionHref } from "@/lib/agent-routes";
import { useProductAccess } from "@/lib/product-access";
import { computeDunningState } from "./compute-dunning.logic";

export function ComputeDunningBanner({
	deployment,
	showPrimaryAction = true,
}: {
	deployment: HostedDeployment;
	showPrimaryAction?: boolean;
}) {
	const state = computeDunningState(deployment);
	const subscription = deployment.commercial_display?.compute_subscription;
	const actions = state?.recoveryTarget
		? resolveComputeSubscriptionActions({
				entitlement: {
					deploymentId: deployment.resource.id,
					planSlug: deployment.current_plan_slug,
					fundingSource: subscription?.funding_source ?? state.fundingSource,
					priceCents: subscription?.price_cents,
					status: subscription?.status ?? state.paymentState,
					paymentState: state.paymentState,
					cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false,
					pendingPlanSlug: pendingComputePlanSlug(subscription),
					actions: subscription?.actions,
				},
				management: { action: "hidden", target: null, unavailableReason: null },
				recoveryTarget: state.recoveryTarget,
				hasPendingOperation: activePlanChangeOperationName(deployment) !== null,
			})
		: [];
	const primaryAction = actions[0] ?? null;
	const hostedAccess = useProductAccess();
	const transactionsLink = (
		<Link to="." search={{ settings: "billing-wallet" }} hash="transactions" />
	);
	const startNewHref = agentSectionHref(deployment.agent_id, "settings", {
		settings: "billing-plan",
		subscription_action: "start_new",
	});
	const checkChangeHref = agentSectionHref(deployment.agent_id, "settings", {
		settings: "billing-plan",
	});

	if (!state) return null;

	const destructive = state.tone === "destructive";
	const bannerDescription = computeDunningDescription(state);

	const BannerIcon = state.tone === "neutral" ? Info : TriangleAlert;

	return (
		<Alert
			data-hosted="true"
			variant={destructive ? "destructive" : "default"}
			className={
				destructive ? undefined : state.tone === "warning" ? styles.warning : styles.neutral
			}
		>
			<BannerIcon aria-hidden />
			<AlertTitle>{state.title}</AlertTitle>
			<AlertDescription className={styles.description}>
				<span>{bannerDescription}</span>
				{!showPrimaryAction || hostedAccess.isLoading ? null : !hostedAccess.canCreateCloudAgents &&
					primaryAction?.kind === "start_new" ? (
					<span className={styles.unavailable}>{computeDunningCopy.startUnavailable}</span>
				) : primaryAction ? (
					<ComputeSubscriptionActionList
						actions={[primaryAction]}
						target={{ kind: "deployment", deploymentId: deployment.resource.id }}
						onStartNew={{
							kind: "link",
							href: startNewHref,
							label: computeDunningCopy.startNew,
						}}
						checkChangeHref={checkChangeHref}
						startNewIcon="plus"
						primaryVariant={destructive ? "destructive" : "default"}
					/>
				) : null}
				{state.secondaryTarget === "transactions" ? (
					<Button render={transactionsLink} nativeButton={false} size="sm" variant="outline">
						<History data-icon="inline-start" /> {computeDunningCopy.transactions}
					</Button>
				) : state.secondaryTarget === "support" ? (
					<Button
						render={<a href="mailto:support@clawdi.ai" />}
						nativeButton={false}
						size="sm"
						variant="outline"
					>
						<LifeBuoy data-icon="inline-start" /> {computeDunningCopy.support}
					</Button>
				) : null}
			</AlertDescription>
		</Alert>
	);
}
