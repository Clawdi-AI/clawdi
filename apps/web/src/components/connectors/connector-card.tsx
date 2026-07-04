"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronRight } from "lucide-react";
import { useCallback } from "react";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import {
	ENTITY_CARD_BASE,
	ENTITY_GRID_CLASS,
	ENTITY_STRETCHED_LINK_CLASS,
	EntityRow,
} from "@/components/entity-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "@/lib/api";
import { availableAppQueryOptions, connectorToolsQueryOptions } from "@/lib/connectors-data";
import { connectorDetailHref } from "@/lib/project-resource-model";
import { cn } from "@/lib/utils";

/**
 * Single connector row — part of the shared entity-card family (EntityRow), so
 * the catalog matches channels/agents/providers. Used by the catalog grid AND
 * the "Connected" rail so an active connection always renders the same way.
 * Click navigates to the detail page for connect / disconnect / inspect.
 */
export function ConnectorCard({
	app,
	isConnected = false,
}: {
	app: { name: string; display_name: string; description: string; logo: string };
	isConnected?: boolean;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const prefetchDetail = useCallback(() => {
		void queryClient.prefetchQuery(availableAppQueryOptions(api, app.name));
		void queryClient.prefetchQuery(connectorToolsQueryOptions(api, app.name));
	}, [api, app.name, queryClient]);
	const href = connectorDetailHref(app.name);

	return (
		<div className="group relative z-0 min-w-0">
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
				trailing={<ChevronRight className="size-4 text-muted-foreground/60" aria-hidden />}
				className="transition-colors group-hover:bg-muted/50"
			/>
			<Link
				to={href}
				className={ENTITY_STRETCHED_LINK_CLASS}
				onMouseEnter={prefetchDetail}
				onFocus={prefetchDetail}
			>
				<span className="sr-only">{app.display_name}</span>
			</Link>
		</div>
	);
}

export function ConnectorCardSkeleton() {
	return (
		<div className={cn(ENTITY_CARD_BASE, "flex items-center gap-3")}>
			<Skeleton className="size-10 shrink-0 rounded-lg" />
			<div className="min-w-0 flex-1 space-y-1.5">
				<Skeleton className="h-3.5 w-28" />
				<Skeleton className="h-3 w-full max-w-xs" />
			</div>
		</div>
	);
}

export const CONNECTOR_GRID_CLASS = ENTITY_GRID_CLASS;
