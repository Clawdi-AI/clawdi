import { Link, type LinkProps } from "@tanstack/react-router";
import { ArrowRight, type LucideIcon, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { AgentOverviewSectionHeading } from "@/components/dashboard/agent-overview-layout";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { type AgentOverviewModuleId, agentOverviewGroups } from "@/lib/agent-capabilities";
import { agentSectionLink } from "@/lib/agent-routes";
import {
	AGENT_SECTION_NAVIGATION_ITEMS,
	type AgentNavigationVariant,
} from "@/lib/navigation-model";

export type AgentOverviewModuleContent = {
	description: ReactNode;
	/** Override the default section route; null keeps an unresolved resource non-interactive. */
	link?: OverviewLinkOptions | null;
};

type OverviewLinkOptions = Pick<LinkProps, "to" | "params" | "search" | "hash">;

export const OVERVIEW_CHANNELS_DESCRIPTION = "Telegram, Discord, or WhatsApp";

export function AgentOverviewStatusCard({
	agentId,
	section,
	title,
	icon: Icon,
	tint,
	description,
	children,
	loading = false,
}: {
	agentId: string;
	section: "settings";
	title: string;
	icon: LucideIcon;
	tint: string;
	description: ReactNode;
	children?: ReactNode;
	loading?: boolean;
}) {
	const heading = (
		<OverviewCardHeading
			title={title}
			description={description}
			icon={Icon}
			tint={tint}
			loading={loading}
		/>
	);
	return (
		<Card
			size="sm"
			role="article"
			data-overview-status={title.toLowerCase().replaceAll(" ", "-")}
			data-testid={loading ? "overview-status-card-skeleton" : undefined}
			aria-busy={loading || undefined}
			className="h-full min-w-0 gap-0 border border-foreground/10 py-0 ring-0"
		>
			<CardHeader className="p-0">
				{loading ? (
					<div className="flex items-center gap-3 px-4 py-3">{heading}</div>
				) : (
					<Link
						{...agentSectionLink(agentId, section)}
						aria-label={title}
						className="group flex items-center gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					>
						{heading}
					</Link>
				)}
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

export function OverviewDescriptionSkeleton({
	label,
	children,
}: {
	label: string;
	children?: string;
}) {
	return (
		<Skeleton
			className={children ? "text-transparent" : "h-lh w-20 max-w-full"}
			aria-label={`Loading ${label} summary`}
			role="status"
		>
			{children}
		</Skeleton>
	);
}

function OverviewCardHeading({
	title,
	description,
	icon: Icon,
	tint,
	loading,
	arrow = true,
}: {
	title: string;
	description: ReactNode;
	icon: LucideIcon;
	tint: string;
	loading: boolean;
	arrow?: boolean;
}) {
	return (
		<>
			<IconChip size="sm" tint={loading ? "bg-muted animate-pulse" : tint}>
				{loading ? null : <Icon />}
			</IconChip>
			<div className="min-w-0 flex-1">
				<CardTitle>{loading ? <Skeleton className="h-lh w-24 max-w-full" /> : title}</CardTitle>
				<CardDescription data-overview-primary-value>
					{loading ? (
						<OverviewDescriptionSkeleton label={title}>
							{typeof description === "string" ? description : undefined}
						</OverviewDescriptionSkeleton>
					) : (
						description
					)}
				</CardDescription>
			</div>
			{arrow && loading ? (
				<Skeleton className="size-4 shrink-0" />
			) : arrow ? (
				<ArrowRight
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
				/>
			) : null}
		</>
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
				<div key={item.label} className="flex min-w-0 items-start justify-between gap-3">
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
	content,
	loading = false,
}: {
	agentId: string;
	variant: AgentNavigationVariant;
	content: Partial<Record<AgentOverviewModuleId, AgentOverviewModuleContent>>;
	loading?: boolean;
}) {
	const groups = agentOverviewGroups(variant);
	return (
		<div
			className="flex flex-col gap-8"
			data-agent-overview={variant}
			data-agent-overview-skeleton={loading ? variant : undefined}
		>
			{groups.map((group) => (
				<section
					key={group.id}
					className="flex flex-col gap-3"
					aria-labelledby={`agent-overview-${group.id}`}
				>
					<AgentOverviewSectionHeading>
						<h2 id={`agent-overview-${group.id}`} className="text-sm font-semibold">
							{loading ? <Skeleton className="h-lh w-20" /> : group.label}
						</h2>
					</AgentOverviewSectionHeading>
					<div
						data-overview-layout="two-column"
						className="grid auto-rows-fr items-stretch gap-3 @2xl/main:grid-cols-2"
					>
						{group.modules.map((module) => {
							const item = AGENT_SECTION_NAVIGATION_ITEMS[module.section];
							const moduleContent = content[module.id];
							if (!moduleContent && !loading) return null;
							return (
								<OverviewNavigationCard
									key={module.id}
									id={module.id}
									loading={loading}
									title={item.label}
									description={moduleContent?.description}
									icon={item.icon}
									tint={item.tint}
									link={
										moduleContent?.link === undefined
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

export function OverviewNavigationCard({
	id,
	title,
	description,
	icon: Icon,
	tint,
	link,
	disabled = false,
	loading = false,
}: {
	id: string;
	title: string;
	description: ReactNode;
	icon: LucideIcon;
	tint: string;
	link: OverviewLinkOptions | null;
	disabled?: boolean;
	loading?: boolean;
}) {
	const content = (
		<OverviewCardHeading
			title={title}
			description={description}
			icon={Icon}
			tint={tint}
			loading={loading}
			arrow={Boolean(link || disabled || loading)}
		/>
	);
	return (
		<Card
			size="sm"
			role="article"
			data-overview-module={id}
			data-overview-module-skeleton={loading ? id : undefined}
			aria-busy={loading || undefined}
			className="h-full min-w-0 border border-foreground/10 py-3 ring-0"
		>
			<CardHeader className="h-full grid-rows-1 content-center gap-0">
				{loading ? (
					<div className="flex min-w-0 items-center gap-3">{content}</div>
				) : disabled ? (
					<button
						type="button"
						disabled
						aria-label={title}
						className="flex min-w-0 items-center gap-3 text-left opacity-50"
					>
						{content}
					</button>
				) : link ? (
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
}: {
	variant: AgentNavigationVariant;
}) {
	return <AgentOverviewCapabilities agentId="" variant={variant} content={{}} loading />;
}
