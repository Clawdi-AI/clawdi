"use client";

import { CircleStop } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useCancelDeploymentOperation } from "@/hosted/agents/deployment-hooks";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { canCancelOperation } from "@/hosted/deployment-status";

/**
 * Escalation action for a deployment transition that stayed stuck well past
 * the convergence window: request cancellation of the in-flight accepted
 * operation. Only rendered where the backend would accept the cancel request
 * (`canCancelOperation` mirrors the cancel acceptance contract).
 */
export function DeploymentCancelAction({ deployment }: { deployment: HostedDeployment }) {
	const operation = deployment.accepted_operation;
	const cancel = useCancelDeploymentOperation();
	if (!operation || !canCancelOperation(operation)) return null;

	return (
		<Button
			type="button"
			data-hosted="true"
			variant="outline"
			size="sm"
			disabled={cancel.isPending}
			onClick={() => cancel.mutate({ operationName: operation.name })}
		>
			{cancel.isPending ? <Spinner className="size-3.5" /> : <CircleStop className="size-3.5" />}
			Cancel this change
		</Button>
	);
}
