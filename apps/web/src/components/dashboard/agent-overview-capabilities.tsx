import { Link } from "@tanstack/react-router";
import { ArrowRight, type LucideIcon, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
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
		<article
			data-overview-status={title.toLowerCase().replaceAll(" ", "-")}
			className="flex h-full flex-col rounded-lg border bg-muted/20"
		>
			<Link
				{...agentSectionLink(agentId, section, routeSearch)}
				className="group flex items-center gap-3 p-4 pb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
			>
				<IconChip size="sm" tint={tint}>
					<Icon />
				</IconChip>
				<h2 className="min-w-0 flex-1 text-sm font-semibold">{title}</h2>
				<ArrowRight className="size-4 text-muted-foreground" />
			</Link>
			<div className="flex flex-1 flex-col px-4 pb-4">{children}</div>
		</article>
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

export function OverviewMetadata({
	items,
}: {
	items: readonly { label: string; value: ReactNode }[];
}) {
	return (
		<dl className="space-y-2 text-sm">
			{items.map((item) => (
				<div key={item.label} className="flex min-w-0 items-baseline justify-between gap-3">
					<dt className="text-xs text-muted-foreground">{item.label}</dt>
					<dd className="min-w-0 break-words text-right font-medium">{item.value}</dd>
				</div>
			))}
		</dl>
	);
}

export function OverviewMetrics({
	items,
	columns = 3,
}: {
	items: readonly { label: string; value: ReactNode }[];
	columns?: 2 | 3;
}) {
	return (
		<dl className={cn("grid gap-2", columns === 2 ? "grid-cols-2" : "grid-cols-3")}>
			{items.map((item) => (
				<div key={item.label} className="rounded-md bg-muted/60 px-2.5 py-2">
					<dt className="text-[11px] text-muted-foreground">{item.label}</dt>
					<dd className="mt-0.5 truncate text-sm font-medium">{item.value}</dd>
				</div>
			))}
		</dl>
	);
}

export function OverviewSummaryRows({ items, empty }: { items: readonly string[]; empty: string }) {
	return items.length ? (
		<ul className="divide-y rounded-md border text-sm">
			{items.slice(0, 3).map((item) => (
				<li key={item} className="truncate px-3 py-2 font-medium">
					{item}
				</li>
			))}
		</ul>
	) : (
		<p className="text-sm text-muted-foreground">{empty}</p>
	);
}

export function OverviewChips({ items, empty }: { items: readonly string[]; empty: string }) {
	return items.length ? (
		<ul className="flex flex-wrap gap-1.5">
			{items.slice(0, 3).map((item) => (
				<li
					key={item}
					className="max-w-full truncate rounded-full bg-muted px-2.5 py-1 text-xs font-medium"
				>
					{item}
				</li>
			))}
		</ul>
	) : (
		<p className="text-sm text-muted-foreground">{empty}</p>
	);
}

const MODULE_PRESENTATION: Record<
	AgentOverviewModuleId,
	{ label?: string; icon?: LucideIcon; tint?: string; source?: boolean }
> = {
	projects: {},
	skills: {},
	memories: {},
	vaults: {},
	connectors: {},
	"model-provider": { label: "Model & Provider" },
	channels: {},
};

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
						className={cn("grid gap-3", group.columns === 3 ? "md:grid-cols-3" : "md:grid-cols-2")}
					>
						{group.modules.map((module) => {
							const item = AGENT_SECTION_NAVIGATION_ITEMS[module.section];
							const presentation = MODULE_PRESENTATION[module.id];
							const moduleContent = content[module.id];
							const Icon = presentation.icon ?? item.icon;
							const title = presentation.label ?? item.label;
							return (
								<article
									key={module.id}
									data-overview-module={module.id}
									className={cn(
										"min-w-0 overflow-hidden rounded-lg border bg-card",
										presentation.source && "bg-muted/20",
										module.size === "wide" && "md:col-span-2",
									)}
								>
									<Link
										{...agentSectionLink(agentId, module.section, routeSearch)}
										className="group flex items-center gap-3 p-4 pb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
									>
										<IconChip size="sm" tint={presentation.tint ?? item.tint}>
											<Icon />
										</IconChip>
										<h3 className="min-w-0 flex-1 text-sm font-semibold">{title}</h3>
										<ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
									</Link>
									<div className="px-4 pb-4">{moduleContent?.body ?? null}</div>
								</article>
							);
						})}
					</div>
				</section>
			))}
		</div>
	);
}
