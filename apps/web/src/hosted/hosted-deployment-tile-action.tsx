"use client";

import { Link } from "@tanstack/react-router";
import { Play, RefreshCw, Trash2, WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { deploymentDisplayName } from "@/hosted/agent-identity";
import { HostedDeploymentDeleteAction } from "@/hosted/agents/deployment-delete-action";
import { useDeploymentLifecycle } from "@/hosted/agents/deployment-hooks";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { deploymentFailurePresentation } from "@/hosted/deployment-failure";
import { canDelete, canStart, deploymentStatusFromResource } from "@/hosted/deployment-status";
import { settingsLink } from "@/lib/settings-routes";

export function HostedDeploymentTileAction({
	deployment,
	remediationHref,
	isRetrying = false,
	onRetry,
}: {
	deployment: HostedDeployment;
	remediationHref?: string;
	isRetrying?: boolean;
	onRetry?: () => void;
}) {
	const lifecycle = useDeploymentLifecycle();
	const runAction = useActionLock();
	const name = deploymentDisplayName(
		deployment.resource.spec.name,
		deployment.resource.spec.runtime,
	);
	const status = deploymentStatusFromResource(deployment.resource.status);
	const startEnabled = status.kind === "stopped" && canStart(status);
	const deleteEnabled = canDelete(status);
	if (status.kind === "unknown") {
		return onRetry ? (
			<div data-hosted="true">
				<Button type="button" variant="outline" size="xs" disabled={isRetrying} onClick={onRetry}>
					{isRetrying ? <Spinner /> : <RefreshCw />}
					Check status
				</Button>
			</div>
		) : null;
	}

	const failure = deploymentFailurePresentation(deployment);
	const remediation = failure?.remediation;
	const retryDelete = remediation?.kind === "retry_delete";
	const showRestart = remediation?.kind === "restart" && !remediation.requiresWalletTopUp;
	const showDelete = !remediationHref || !remediation || remediation.kind === "none" || retryDelete;
	const lifecyclePending = lifecycle.isPending;

	function runLifecycle(action: "start" | "restart") {
		void runAction(async () => {
			await lifecycle.mutateAsync({ id: deployment.resource.id, action });
		}).catch(() => undefined);
	}

	return (
		<div data-hosted="true" className="flex items-center gap-1">
			{remediation?.requiresWalletTopUp && remediation.kind === "restart" ? (
				<Button
					render={<Link {...settingsLink("billing-wallet")} />}
					nativeButton={false}
					variant="outline"
					size="xs"
					aria-label={`Open Wallet for ${name}`}
					title={`Open Wallet for ${name}`}
				>
					<WalletCards />
					Open Wallet
				</Button>
			) : null}
			{(remediation?.kind === "review_plan_change" || remediation?.kind === "review_provider") &&
			remediationHref ? (
				<Button
					render={<a href={remediationHref} />}
					nativeButton={false}
					variant="outline"
					size="xs"
					aria-label={`${remediation.label} for ${name}`}
					title={`${remediation.label} for ${name}`}
				>
					{remediation.label}
				</Button>
			) : null}
			{showRestart ? (
				<Button
					type="button"
					variant="outline"
					size="xs"
					disabled={lifecyclePending}
					aria-label={`${remediation.label} for ${name}`}
					title={`${remediation.label} for ${name}`}
					onClick={() => runLifecycle("restart")}
				>
					{lifecyclePending && lifecycle.variables?.action === "restart" ? (
						<Spinner />
					) : (
						<RefreshCw />
					)}
					{remediation.label}
				</Button>
			) : null}
			{startEnabled ? (
				<Button
					type="button"
					size="xs"
					disabled={lifecyclePending}
					aria-label={`Start ${name}`}
					title={`Start ${name}`}
					onClick={() => runLifecycle("start")}
				>
					{lifecyclePending ? <Spinner /> : <Play />}
					Start
				</Button>
			) : null}
			{showDelete ? (
				<HostedDeploymentDeleteAction deployment={deployment}>
					<Button
						type="button"
						variant={retryDelete ? "outline" : "ghost"}
						size={retryDelete ? "xs" : "icon-xs"}
						className="text-muted-foreground hover:text-destructive"
						disabled={!deleteEnabled}
						aria-label={retryDelete ? `${remediation.label} for ${name}` : `Delete ${name}`}
						title={retryDelete ? `${remediation.label} for ${name}` : `Delete ${name}`}
					>
						<Trash2 />
						{retryDelete ? remediation.label : null}
					</Button>
				</HostedDeploymentDeleteAction>
			) : null}
		</div>
	);
}
