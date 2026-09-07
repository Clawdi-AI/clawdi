"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { type ReactNode, useCallback } from "react";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { connectorSearchSupportingText } from "@/components/connectors/connector-search";
import { ENTITY_GRID_CLASS, EntityCardSkeleton, EntityRow } from "@/components/entity-card";
import { SearchHighlightedText } from "@/components/search-highlighted-text";
import { useOpenApi } from "@/lib/api";
import {
	availableAppQueryOptions,
	type ConnectorMetadata,
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
	searchQuery,
	actions,
}: {
	app: ConnectorMetadata;
	isConnected?: boolean;
	scope?: ResourceNavigationScope;
	searchQuery?: string;
	actions?: ReactNode;
}) {
	const api = useOpenApi();
	const queryClient = useQueryClient();
	const prefetchDetail = useCallback(() => {
		void queryClient.prefetchQuery(availableAppQueryOptions(api, app.name));
		void queryClient.prefetchQuery(connectorToolsQueryOptions(api, app.name));
	}, [api, app.name, queryClient]);

	return (
		<EntityRow
			className="min-h-19"
			ariaLabel={app.display_name}
			icon={<ConnectorIcon logo={app.logo} name={app.display_name} size="md" />}
			title={
				searchQuery ? (
					<SearchHighlightedText text={app.display_name} query={searchQuery} />
				) : (
					app.display_name
				)
			}
			titleAdornment={
				isConnected ? (
					<Check className="size-3.5 shrink-0 text-success" aria-label="Connected" />
				) : undefined
			}
			meta={
				searchQuery ? (
					<SearchHighlightedText
						text={connectorSearchSupportingText(app, searchQuery)}
						query={searchQuery}
					/>
				) : (
					app.description
				)
			}
			actions={actions}
			link={{
				...connectorDetailLink(scope, app.name),
				onMouseEnter: prefetchDetail,
				onFocus: prefetchDetail,
			}}
		/>
	);
}

export function ConnectorCardSkeleton() {
	return <EntityCardSkeleton className="min-h-19" />;
}

export const CONNECTOR_GRID_CLASS = ENTITY_GRID_CLASS;
