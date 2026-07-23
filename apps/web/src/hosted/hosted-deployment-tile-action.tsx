"use client";

import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deploymentDisplayName } from "@/hosted/agent-identity";
import { HostedDeploymentDeleteAction } from "@/hosted/agents/deployment-delete-action";
import type { HostedDeployment } from "@/hosted/billing/contracts";

export function HostedDeploymentTileDeleteAction({ deployment }: { deployment: HostedDeployment }) {
	const name = deploymentDisplayName(deployment.resource.spec.name);

	return (
		<div data-hosted="true">
			<HostedDeploymentDeleteAction deployment={deployment}>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="text-muted-foreground"
					aria-label={`Delete ${name}`}
					title={`Delete ${name}`}
				>
					<MoreHorizontal />
				</Button>
			</HostedDeploymentDeleteAction>
		</div>
	);
}
