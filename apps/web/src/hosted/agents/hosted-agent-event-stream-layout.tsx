"use client";

import { type ReactNode, useEffect, useState } from "react";
import { useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { useDeploymentEventStream } from "@/hosted/use-deployment-event-stream";
import { DeploymentEventStreamActiveProvider } from "@/lib/deployment-event-stream-context";

export function HostedAgentEventStreamLayout({
	agentId,
	children,
}: {
	agentId: string;
	children: ReactNode;
}) {
	const [eventStreamActive, setEventStreamActive] = useState(false);
	const { deployment } = useAgentDeployment(agentId, eventStreamActive);
	const deploymentEvents = useDeploymentEventStream({
		deploymentId: deployment?.resource.id ?? null,
		agentId,
		enabled: Boolean(deployment),
	});

	useEffect(() => {
		setEventStreamActive(deploymentEvents.active);
	}, [deploymentEvents.active]);

	return (
		<DeploymentEventStreamActiveProvider active={deploymentEvents.active}>
			<div data-hosted="true" className="contents">
				{children}
			</div>
		</DeploymentEventStreamActiveProvider>
	);
}
