"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useCallback } from "react";
import { ConnectorConnectAction } from "@/components/connectors/connector-connect-action";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { ENTITY_GRID_CLASS, EntityCardSkeleton, EntityRow } from "@/components/entity-card";
import { useOpenApi } from "@/lib/api";
import {
	availableAppQueryOptions,
	type ConnectorAvailableApp,
	connectorToolsQueryOptions,
} from "@/lib/connectors-data";
import {
	connectorDetailHrefForScope,
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
				!isConnected ? (
					<ConnectorConnectAction
						app={app}
						redirectHref={connectorDetailHrefForScope(scope, app.name)}
					/>
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
