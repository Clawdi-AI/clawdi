"use client";

import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Spinner } from "@/components/ui/spinner";
import { deploymentDisplayName } from "@/hosted/agent-identity";
import { useDeleteDeployment } from "@/hosted/agents/deployment-hooks";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { useActionLock } from "@/hosted/billing/use-action-lock";

export function HostedDeploymentTileDeleteAction({ deployment }: { deployment: HostedDeployment }) {
	const deleteDeployment = useDeleteDeployment();
	const runAction = useActionLock();
	const name = deploymentDisplayName(deployment.name);

	return (
		<div data-hosted="true">
			<ConfirmAction
				title={`Delete ${name}?`}
				description={<p>The hosted deployment is torn down. This can’t be undone.</p>}
				confirmLabel="Delete deployment"
				destructive
				onConfirm={() =>
					runAction(async () => {
						await deleteDeployment.mutateAsync(deployment.id);
					})
				}
			>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="text-muted-foreground"
					disabled={deleteDeployment.isPending}
					aria-label={`Delete ${name}`}
					title={`Delete ${name}`}
				>
					{deleteDeployment.isPending ? <Spinner /> : <MoreHorizontal />}
				</Button>
			</ConfirmAction>
		</div>
	);
}
