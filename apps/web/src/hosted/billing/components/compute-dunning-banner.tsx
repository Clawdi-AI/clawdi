"use client";

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
import { formatShortDate } from "@/lib/format";
import { useProductAccess } from "@/lib/product-access";
import { computeDunningState, fallbackReasonSentence } from "./compute-dunning.logic";

export function ComputeDunningBanner({ deployment }: { deployment: HostedDeployment }) {
	const state = computeDunningState(deployment);
	const subscription = deployment.commercial_display?.compute_subscription;
	const actions = state
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
	const bannerDescription = [
		state.fallbackOccurredAt && state.fallbackPlanLabel && state.fallbackReason
			? fallbackReasonSentence(
					state.fallbackReason,
					state.fallbackPlanLabel,
					formatShortDate(state.fallbackOccurredAt),
				)
			: null,
		state.description,
	]
		.filter(Boolean)
		.join(" ");

	const BannerIcon = state.tone === "neutral" ? Info : TriangleAlert;

	return (
		<Alert
			data-hosted="true"
			variant={destructive ? "destructive" : "default"}
			className={
				destructive
					? undefined
					: state.tone === "warning"
						? "border-warning/30 bg-warning-muted"
						: "border-info-muted bg-info-muted text-info-muted-foreground"
			}
		>
			<BannerIcon aria-hidden />
			<AlertTitle>{state.title}</AlertTitle>
			<AlertDescription className="flex flex-col items-start gap-3">
				<span>{bannerDescription}</span>
				{hostedAccess.isLoading ? null : !hostedAccess.canCreateCloudAgents &&
					primaryAction?.kind === "start_new" ? (
					<span className="text-xs text-muted-foreground">
						Starting a new subscription is temporarily unavailable. This agent remains visible and
						manageable.
					</span>
				) : primaryAction ? (
					<ComputeSubscriptionActionList
						actions={[primaryAction]}
						target={{ kind: "deployment", deploymentId: deployment.resource.id }}
						onStartNew={{
							kind: "link",
							href: startNewHref,
							label: "Start a new subscription",
						}}
						checkChangeHref={checkChangeHref}
						startNewIcon="plus"
						primaryVariant={destructive ? "destructive" : "default"}
					/>
				) : null}
				{state.secondaryTarget === "transactions" ? (
					<Button render={transactionsLink} nativeButton={false} size="sm" variant="outline">
						<History data-icon="inline-start" /> View transactions
					</Button>
				) : state.secondaryTarget === "support" ? (
					<Button
						render={<a href="mailto:support@clawdi.ai" />}
						nativeButton={false}
						size="sm"
						variant="outline"
					>
						<LifeBuoy data-icon="inline-start" /> Contact support
					</Button>
				) : null}
			</AlertDescription>
		</Alert>
	);
}
