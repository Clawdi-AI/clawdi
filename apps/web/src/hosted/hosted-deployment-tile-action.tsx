"use client";

import { Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Spinner } from "@/components/ui/spinner";
import { deploymentDisplayName } from "@/hosted/agent-identity";
import { useDeleteDeployment, useDeploymentLifecycle } from "@/hosted/agents/deployment-hooks";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { canDelete, canStart, parseDeploymentStatus } from "@/hosted/deployment-status";

export function HostedDeploymentTileAction({ deployment }: { deployment: HostedDeployment }) {
	const deleteDeployment = useDeleteDeployment();
	const lifecycle = useDeploymentLifecycle();
	const runAction = useActionLock();
	const name = deploymentDisplayName(
		deployment.resource.spec.name,
		deployment.resource.spec.runtime,
	);
	const status = parseDeploymentStatus(deployment.resource.status.summary_state);
	const startEnabled = status.kind === "stopped" && canStart(status);
	const deleteEnabled = canDelete(status);

	return (
		<div data-hosted="true" className="flex items-center gap-1">
			{startEnabled ? (
				<Button
					type="button"
					size="xs"
					disabled={lifecycle.isPending}
					aria-label={`Start ${name}`}
					title={`Start ${name}`}
					onClick={() =>
						void runAction(async () => {
							await lifecycle.mutateAsync({ id: deployment.resource.id, action: "start" });
						}).catch(() => undefined)
					}
				>
					{lifecycle.isPending ? <Spinner /> : <Play />}
					Start
				</Button>
			) : null}
			<ConfirmAction
				title={`Delete ${name}?`}
				description={<p>The hosted deployment is torn down. This can’t be undone.</p>}
				confirmLabel="Delete deployment"
				destructive
				onConfirm={() =>
					runAction(async () => {
						await deleteDeployment.mutateAsync(deployment.resource.id);
					})
				}
			>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					className="text-muted-foreground hover:text-destructive"
					disabled={deleteDeployment.isPending || !deleteEnabled}
					aria-label={`Delete ${name}`}
					title={`Delete ${name}`}
				>
					{deleteDeployment.isPending ? <Spinner /> : <Trash2 />}
				</Button>
			</ConfirmAction>
		</div>
	);
}
