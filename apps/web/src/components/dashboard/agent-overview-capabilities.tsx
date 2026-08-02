import { Link } from "@tanstack/react-router";
import { ArrowRight, CircleCheck, type LucideIcon, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { IconChip } from "@/components/icon-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { type AgentOverviewModuleId, agentOverviewGroups } from "@/lib/agent-capabilities";
import { type AgentRouteSearch, agentSectionLink } from "@/lib/agent-routes";
import {
	AGENT_SECTION_NAVIGATION_ITEMS,
	type AgentNavigationVariant,
} from "@/lib/navigation-model";
import { cn } from "@/lib/utils";

export type AgentOverviewModuleContent = {
	body: ReactNode;
};

export function AgentOverviewStatusCard({
	agentId,
	section,
	routeSearch,
	title,
	icon: Icon,
	tint,
	children,
}: {
	agentId: string;
	section: "settings";
	routeSearch: AgentRouteSearch;
	title: string;
	icon: LucideIcon;
	tint: string;
	children: ReactNode;
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
					className="group flex items-center gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
				>
					<IconChip size="sm" tint={tint}>
						<Icon />
					</IconChip>
					<h2 className="min-w-0 flex-1 text-sm font-semibold">{title}</h2>
					<ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
				</Link>
			</CardHeader>
			<CardContent className="flex flex-1 flex-col px-4 pb-4">{children}</CardContent>
		</Card>
	);
}

export function OverviewModuleSkeleton({
	label,
	rows = 2,
	showHeading = true,
}: {
	label: string;
	rows?: 1 | 2 | 3;
	showHeading?: boolean;
}) {
	return (
		<div
			data-testid="overview-module-skeleton"
			aria-label={`Loading ${label} summary`}
			role="status"
		>
			{showHeading ? <Skeleton className="h-5 w-24" /> : null}
			<div className={cn("space-y-2", showHeading && "mt-3")}>
				{Array.from({ length: rows }).map((_, index) => (
					<Skeleton key={`${label}-${index}`} className={cn("h-3", index ? "w-2/3" : "w-full")} />
				))}
			</div>
		</div>
	);
}

export function OverviewModuleError({ label, onRetry }: { label: string; onRetry?: () => void }) {
	return (
		<div className="space-y-3 text-sm" role="status">
			<p className="font-medium">Can’t load {label.toLowerCase()}</p>
			{onRetry ? (
				<Button type="button" variant="outline" size="sm" onClick={onRetry}>
					<RefreshCw /> Retry
				</Button>
			) : null}
		</div>
	);
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

export function OverviewResourceSummary({
	primary,
	items,
	children,
}: {
	primary: ReactNode;
	items?: readonly string[];
	children?: ReactNode;
}) {
	return (
		<div className="space-y-3" data-testid="overview-resource-summary">
			<p data-overview-primary-value className="text-base font-semibold">
				{primary}
			</p>
			{items?.length ? (
				<ul className="flex min-w-0 flex-wrap gap-1.5" data-testid="overview-resource-badges">
					{items.slice(0, 3).map((item, index) => (
						<li key={`${item}-${index}`} className="min-w-0 max-w-full">
							<Badge
								variant="secondary"
								className="max-w-full min-w-0"
								aria-label={item}
								title={item}
							>
								<span className="truncate">{item}</span>
							</Badge>
						</li>
					))}
				</ul>
			) : null}
			{children}
		</div>
	);
}

export function OverviewIdentityIconRail({
	label,
	testId,
	children,
}: {
	label: string;
	testId: string;
	children: ReactNode;
}) {
	return (
		<ul aria-label={label} className="flex flex-wrap gap-2" data-testid={testId}>
			{children}
		</ul>
	);
}

export function OverviewIdentityIconItem({
	connected = false,
	children,
}: {
	connected?: boolean;
	children: ReactNode;
}) {
	return (
		<li className="relative w-fit">
			{children}
			{connected ? (
				<span className="pointer-events-none absolute -right-1 -bottom-1 rounded-full bg-background text-primary">
					<CircleCheck className="size-4 fill-background" aria-hidden="true" />
				</span>
			) : null}
		</li>
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
							"grid items-stretch gap-3",
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
									className="h-full min-w-0 gap-0 py-0"
								>
									<CardHeader className="p-0">
										<Link
											{...agentSectionLink(agentId, module.section, routeSearch)}
											className="group flex items-center gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
										>
											<IconChip size="sm" tint={item.tint}>
												<Icon />
											</IconChip>
											<h3 className="min-w-0 flex-1 text-sm font-semibold">{title}</h3>
											<ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
										</Link>
									</CardHeader>
									<CardContent className="flex flex-1 flex-col px-4 pb-4">
										{moduleContent.body}
									</CardContent>
								</Card>
							);
						})}
					</div>
				</section>
			))}
		</div>
	);
}
