import { Link } from "@tanstack/react-router";
import { ArrowRight, type LucideIcon, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { type AgentOverviewModuleId, agentOverviewGroups } from "@/lib/agent-capabilities";
import { type AgentRouteSearch, agentSectionLink } from "@/lib/agent-routes";
import {
	AGENT_SECTION_NAVIGATION_ITEMS,
	type AgentNavigationVariant,
} from "@/lib/navigation-model";
import { cn } from "@/lib/utils";

export type AgentOverviewModuleContent = {
	description: ReactNode;
};

export function AgentOverviewStatusCard({
	agentId,
	section,
	routeSearch,
	title,
	icon: Icon,
	tint,
	description,
	children,
}: {
	agentId: string;
	section: "settings";
	routeSearch: AgentRouteSearch;
	title: string;
	icon: LucideIcon;
	tint: string;
	description: ReactNode;
	children?: ReactNode;
}) {
	return (
		<Card
			size="sm"
			role="article"
			data-overview-status={title.toLowerCase().replaceAll(" ", "-")}
			className="h-full gap-0 bg-muted/20 py-0"
		>
			<CardHeader className="p-0">
				<Link
					{...agentSectionLink(agentId, section, routeSearch)}
					aria-label={title}
					className="group flex items-center gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
				>
					<IconChip size="sm" tint={tint}>
						<Icon />
					</IconChip>
					<div className="min-w-0 flex-1">
						<CardTitle>{title}</CardTitle>
						<CardDescription>{description}</CardDescription>
					</div>
					<ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
				</Link>
			</CardHeader>
			{children ? (
				<CardContent className="flex flex-1 flex-col px-4 pb-4">{children}</CardContent>
			) : null}
		</Card>
	);
}

export function OverviewModuleError({ label, onRetry }: { label: string; onRetry?: () => void }) {
	return (
		<div className="space-y-2 text-sm text-muted-foreground" role="status">
			<p>Can’t load {label.toLowerCase()}</p>
			{onRetry ? (
				<Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={onRetry}>
					<RefreshCw /> Retry
				</Button>
			) : null}
		</div>
	);
}

export function OverviewDescriptionSkeleton({ label }: { label: string }) {
	return <Skeleton className="h-5 w-20" aria-label={`Loading ${label} summary`} role="status" />;
}

export function OverviewModuleUnavailable() {
	return <p className="text-sm text-muted-foreground">Unavailable right now</p>;
}

export function OverviewMetadata({
	items,
}: {
	items: readonly { label: string; value: ReactNode }[];
}) {
	return (
		<dl className="space-y-2 text-xs text-muted-foreground">
			{items.map((item) => (
				<div key={item.label} className="flex min-w-0 items-baseline justify-between gap-3">
					<dt>{item.label}</dt>
					<dd className="min-w-0 break-words text-right">{item.value}</dd>
				</div>
			))}
		</dl>
	);
}

export function AgentOverviewCapabilities({
	agentId,
	variant,
	routeSearch,
	content,
}: {
	agentId: string;
	variant: AgentNavigationVariant;
	routeSearch: AgentRouteSearch;
	content: Partial<Record<AgentOverviewModuleId, AgentOverviewModuleContent>>;
}) {
	const groups = agentOverviewGroups(variant);
	return (
		<div className="flex flex-col gap-8" data-agent-overview={variant}>
			{groups.map((group) => (
				<section key={group.id} aria-labelledby={`agent-overview-${group.id}`}>
					<div className="mb-3">
						<h2 id={`agent-overview-${group.id}`} className="text-sm font-semibold">
							{group.label}
						</h2>
					</div>
					<div
						data-overview-layout={group.layout}
						className={cn(
							"grid auto-rows-fr items-stretch gap-3",
							group.layout === "three-column"
								? "@2xl/main:grid-cols-2 @4xl/main:grid-cols-3"
								: "@2xl/main:grid-cols-2",
						)}
					>
						{group.modules.map((module) => {
							const item = AGENT_SECTION_NAVIGATION_ITEMS[module.section];
							const moduleContent = content[module.id];
							if (!moduleContent) return null;
							const Icon = item.icon;
							const title = module.id === "model-provider" ? "Model & Provider" : item.label;
							return (
								<Card
									size="sm"
									role="article"
									key={module.id}
									data-overview-module={module.id}
									className="h-full min-w-0 py-3"
								>
									<CardHeader className="h-full grid-rows-1 content-center gap-0">
										<Link
											{...agentSectionLink(agentId, module.section, routeSearch)}
											aria-label={title}
											className="group flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										>
											<IconChip size="sm" tint={item.tint}>
												<Icon />
											</IconChip>
											<div className="min-w-0 flex-1">
												<CardTitle>{title}</CardTitle>
												<CardDescription data-overview-primary-value>
													{moduleContent.description}
												</CardDescription>
											</div>
											<ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
										</Link>
									</CardHeader>
								</Card>
							);
						})}
					</div>
				</section>
			))}
		</div>
	);
}

export function AgentOverviewCapabilitiesSkeleton({
	variant,
}: {
	variant: AgentNavigationVariant;
}) {
	const groups = agentOverviewGroups(variant);
	return (
		<div className="flex flex-col gap-8" aria-hidden="true" data-agent-overview-skeleton={variant}>
			{groups.map((group) => (
				<section key={group.id}>
					<Skeleton className="mb-3 h-5 w-20" />
					<div
						data-overview-layout={group.layout}
						className={cn(
							"grid auto-rows-fr items-stretch gap-3",
							group.layout === "three-column"
								? "@2xl/main:grid-cols-2 @4xl/main:grid-cols-3"
								: "@2xl/main:grid-cols-2",
						)}
					>
						{group.modules.map((module) => (
							<Card
								size="sm"
								key={module.id}
								data-overview-module-skeleton={module.id}
								className="h-full min-w-0 py-3"
							>
								<CardHeader className="h-full grid-rows-1 content-center gap-0">
									<div className="flex min-w-0 items-center gap-3">
										<Skeleton className="size-8 shrink-0 rounded-lg" />
										<div className="min-w-0 flex-1">
											<Skeleton className="h-5 w-24" />
											<Skeleton className="h-5 w-20" />
										</div>
										<Skeleton className="size-4 shrink-0" />
									</div>
								</CardHeader>
							</Card>
						))}
					</div>
				</section>
			))}
		</div>
	);
}
