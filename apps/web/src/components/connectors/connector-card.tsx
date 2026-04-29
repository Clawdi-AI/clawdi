"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Single connector tile. Used by the catalog grid AND the
 * "Connected" rail at the top of the list page so an active
 * connection always renders the same way regardless of which page
 * of the catalog the app sits on. Click navigates to the detail
 * page for connect / disconnect / inspect tools.
 */
export function ConnectorCard({
	app,
	isConnected = false,
}: {
	app: { name: string; display_name: string; description: string; logo: string };
	isConnected?: boolean;
}) {
	return (
		<Link href={`/connectors/${app.name}`} className="group">
			<Card
				className={cn(
					"h-full gap-0 rounded-lg border-border/60 py-0 shadow-none",
					"transition-colors hover:border-ring/50 hover:bg-accent/40",
				)}
			>
				<CardContent className="flex h-full items-start gap-3 p-3">
					<ConnectorIcon logo={app.logo} name={app.display_name} size="md" />
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5">
							<span className="truncate text-sm font-medium leading-5">{app.display_name}</span>
							{isConnected ? (
								<Check
									className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500"
									aria-label="Connected"
								/>
							) : null}
						</div>
						<p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
							{app.description}
						</p>
					</div>
				</CardContent>
			</Card>
		</Link>
	);
}

export function ConnectorCardSkeleton() {
	return (
		<Card className="gap-0 rounded-lg border-border/60 py-0 shadow-none">
			<CardContent className="flex items-start gap-3 p-3">
				<Skeleton className="size-10 shrink-0 rounded-lg" />
				<div className="min-w-0 flex-1 space-y-1.5">
					<Skeleton className="h-3.5 w-28" />
					<Skeleton className="h-3 w-full" />
					<Skeleton className="h-3 w-3/4" />
				</div>
			</CardContent>
		</Card>
	);
}

/** 12 = LCM of 1/2/3/4 col grid breakpoints — last row always full. */
export const CONNECTOR_GRID_CLASS =
	"grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";
