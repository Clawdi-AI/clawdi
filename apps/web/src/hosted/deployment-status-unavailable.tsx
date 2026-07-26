"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { deploymentStatusFromResource } from "@/hosted/deployment-status";

export function DeploymentStatusUnavailableState({
	deployment,
	isRetrying,
	onRetry,
}: {
	deployment: HostedDeployment;
	isRetrying: boolean;
	onRetry: () => void;
}) {
	const status = deploymentStatusFromResource(deployment.resource.status);
	if (status.kind !== "unknown") return null;

	return (
		<div data-hosted="true" data-testid="deployment-status-unavailable">
			<EmptyState
				icon={AlertCircle}
				title="Deployment status unavailable"
				description="We can’t determine this agent’s deployment state right now. Actions and live tools are paused until a status is available."
				action={
					<Button type="button" variant="outline" size="sm" disabled={isRetrying} onClick={onRetry}>
						{isRetrying ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
						Check again
					</Button>
				}
			/>
		</div>
	);
}
