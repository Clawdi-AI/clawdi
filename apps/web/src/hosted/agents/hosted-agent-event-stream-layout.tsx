"use client";

import { getRouteApi, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { useDeploymentEventStream } from "@/hosted/use-deployment-event-stream";
import { DeploymentEventStreamActiveProvider } from "@/lib/deployment-event-stream-context";

const route = getRouteApi("/_protected/_dashboard/agents/$id");

export function HostedAgentEventStreamLayout() {
	const { id: agentId } = route.useParams();
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
				<Outlet />
			</div>
		</DeploymentEventStreamActiveProvider>
	);
}
