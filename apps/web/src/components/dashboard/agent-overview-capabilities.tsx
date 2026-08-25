import { Link, type LinkProps } from "@tanstack/react-router";
import { ArrowRight, type LucideIcon, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { type AgentOverviewModuleId, agentOverviewGroups } from "@/lib/agent-capabilities";
import { agentSectionLink } from "@/lib/agent-routes";
import {
	AGENT_SECTION_NAVIGATION_ITEMS,
	type AgentNavigationVariant,
	type AgentSectionId,
} from "@/lib/navigation-model";
import { cn } from "@/lib/utils";

export type AgentOverviewModuleContent = {
	description: ReactNode;
	/** Override the default section route; null keeps an unresolved resource non-interactive. */
	link?: OverviewLinkOptions | null;
};

type OverviewLinkOptions = Pick<LinkProps, "to" | "params" | "search" | "hash">;

export function AgentOverviewStatusCard({
	agentId,
	section,
	title,
	icon: Icon,
	tint,
	description,
	children,
}: {
	agentId: string;
	section: "settings";
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
					{...agentSectionLink(agentId, section)}
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
	visibleSectionIds,
	content,
}: {
	agentId: string;
	variant: AgentNavigationVariant;
	visibleSectionIds?: readonly AgentSectionId[];
	content: Partial<Record<AgentOverviewModuleId, AgentOverviewModuleContent>>;
}) {
	const groups = agentOverviewGroups(variant, visibleSectionIds);
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
							const title = module.id === "model-provider" ? "Model & Provider" : item.label;
							return (
								<OverviewNavigationCard
									key={module.id}
									id={module.id}
									title={title}
									description={moduleContent.description}
									icon={item.icon}
									tint={item.tint}
									link={
										moduleContent.link === undefined
											? agentSectionLink(agentId, module.section)
											: moduleContent.link
									}
								/>
							);
						})}
					</div>
				</section>
			))}
		</div>
	);
}

function OverviewNavigationCard({
	id,
	title,
	description,
	icon: Icon,
	tint,
	link,
}: {
	id: string;
	title: string;
	description: ReactNode;
	icon: LucideIcon;
	tint: string;
	link: OverviewLinkOptions | null;
}) {
	const content = (
		<>
			<IconChip size="sm" tint={tint}>
				<Icon />
			</IconChip>
			<div className="min-w-0 flex-1">
				<CardTitle>{title}</CardTitle>
				<CardDescription data-overview-primary-value>{description}</CardDescription>
			</div>
			{link ? (
				<ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
			) : null}
		</>
	);
	return (
		<Card size="sm" role="article" data-overview-module={id} className="h-full min-w-0 py-3">
			<CardHeader className="h-full grid-rows-1 content-center gap-0">
				{link ? (
					<Link
						{...link}
						aria-label={title}
						className="group flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{content}
					</Link>
				) : (
					<div className="flex min-w-0 items-center gap-3">{content}</div>
				)}
			</CardHeader>
		</Card>
	);
}

export function AgentOverviewCapabilitiesSkeleton({
	variant,
	visibleSectionIds,
}: {
	variant: AgentNavigationVariant;
	visibleSectionIds?: readonly AgentSectionId[];
}) {
	const groups = agentOverviewGroups(variant, visibleSectionIds);
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
