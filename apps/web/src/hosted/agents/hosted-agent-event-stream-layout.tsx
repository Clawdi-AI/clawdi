"use client";

import { getRouteApi, Outlet, useMatches } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { ConsoleTab } from "@/hosted/agents/hosted-agent-detail";
import { deploymentRuntimeUiIsReady } from "@/hosted/deployment-status";
import { runtimeConsoleUrl } from "@/hosted/runtimes";
import { useDeploymentEventStream } from "@/hosted/use-deployment-event-stream";
import { agentSectionHref, parseAgentPathname } from "@/lib/agent-routes";
import { useSessionIdentity } from "@/lib/auth-client";
import { DeploymentEventStreamActiveProvider } from "@/lib/deployment-event-stream-context";

const route = getRouteApi("/_protected/_dashboard/agents/$id");

export function HostedAgentEventStreamLayout() {
	const { id: agentId } = route.useParams();
	const identity = useSessionIdentity();
	const pathname = useMatches({ select: (matches) => matches.at(-1)?.pathname ?? "/" });
	const consoleActive = parseAgentPathname(pathname)?.section === "console";
	const [eventStreamActive, setEventStreamActive] = useState(false);
	const {
		deployment,
		deploymentTransitionTimedOut,
		deploymentTransitionEscalated,
		isFetching,
		retryDeploymentTransition,
	} = useAgentDeployment(agentId, eventStreamActive);
	const persistentConsole =
		identity &&
		deployment?.resource.spec.runtime === "openclaw" &&
		deploymentRuntimeUiIsReady(deployment)
			? deployment
			: null;
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
				{persistentConsole ? (
					<div
						key={JSON.stringify([
							identity,
							agentId,
							persistentConsole.resource.id,
							persistentConsole.resource.metadata.generation,
							runtimeConsoleUrl(persistentConsole),
						])}
						hidden={!consoleActive}
						inert={!consoleActive}
						data-testid={consoleActive ? "hosted-agent-live-surface" : undefined}
						className={
							consoleActive ? "flex min-h-0 w-full flex-1 flex-col overflow-hidden" : "hidden"
						}
					>
						<ConsoleTab
							deployment={persistentConsole}
							runtime="openclaw"
							terminalHref={agentSectionHref(agentId, "terminal")}
							deploymentTransitionTimedOut={deploymentTransitionTimedOut}
							deploymentTransitionEscalated={deploymentTransitionEscalated}
							isCheckingDeployment={isFetching}
							onCheckDeploymentAgain={() => void retryDeploymentTransition()}
						/>
					</div>
				) : null}
				<Outlet />
			</div>
		</DeploymentEventStreamActiveProvider>
	);
}
