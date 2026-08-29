"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, Plug } from "lucide-react";
import { useCallback, useState } from "react";
import { getConnectorAuthFlow } from "@/components/connectors/auth-flow.logic";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { ConnectorCredentialsDialog } from "@/components/connectors/credentials-dialog";
import { ENTITY_GRID_CLASS, EntityCardSkeleton, EntityRow } from "@/components/entity-card";
import { Button } from "@/components/ui/button";
import { useOpenApi } from "@/lib/api";
import {
	availableAppQueryOptions,
	type ConnectorAvailableApp,
	connectorToolsQueryOptions,
} from "@/lib/connectors-data";
import {
	connectorDetailLink,
	LIBRARY_RESOURCE_SCOPE,
	type ResourceNavigationScope,
} from "@/lib/resource-navigation";

/**
 * Single connector row — part of the shared entity-card family (EntityRow), so
 * the catalog matches channels/agents/providers. Used by the catalog grid AND
 * the "Connected" rail so an active connection always renders the same way.
 * Click navigates to the detail page for connect / disconnect / inspect.
 */
export function ConnectorCard({
	app,
	isConnected = false,
	scope = LIBRARY_RESOURCE_SCOPE,
}: {
	app: ConnectorAvailableApp;
	isConnected?: boolean;
	scope?: ResourceNavigationScope;
}) {
	const api = useOpenApi();
	const queryClient = useQueryClient();
	const [credentialsOpen, setCredentialsOpen] = useState(false);
	const canConnectCredentials =
		!isConnected && !app.connect_disabled && getConnectorAuthFlow(app.auth_type) === "credentials";
	const prefetchDetail = useCallback(() => {
		void queryClient.prefetchQuery(availableAppQueryOptions(api, app.name));
		void queryClient.prefetchQuery(connectorToolsQueryOptions(api, app.name));
	}, [api, app.name, queryClient]);

	return (
		<EntityRow
			ariaLabel={app.display_name}
			icon={<ConnectorIcon logo={app.logo} name={app.display_name} size="md" />}
			title={app.display_name}
			titleAdornment={
				isConnected ? (
					<Check className="size-3.5 shrink-0 text-success" aria-label="Connected" />
				) : undefined
			}
			meta={app.description}
			actions={
				canConnectCredentials ? (
					<>
						<Button variant="outline" size="sm" onClick={() => setCredentialsOpen(true)}>
							<Plug className="size-3.5" />
							Connect
						</Button>
						<ConnectorCredentialsDialog
							open={credentialsOpen}
							onOpenChange={setCredentialsOpen}
							appName={app.name}
							displayName={app.display_name}
						/>
					</>
				) : undefined
			}
			link={{
				...connectorDetailLink(scope, app.name),
				onMouseEnter: prefetchDetail,
				onFocus: prefetchDetail,
			}}
		/>
	);
}

export function ConnectorCardSkeleton() {
	return <EntityCardSkeleton />;
}

export const CONNECTOR_GRID_CLASS = ENTITY_GRID_CLASS;
