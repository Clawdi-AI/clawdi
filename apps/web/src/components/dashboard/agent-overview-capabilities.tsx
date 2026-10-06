import { agentOverviewCapabilitiesClasses } from "@clawdi/shared/ui";
import { agentOverviewCopy } from "@clawdi/shared/view";
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
import { cn } from "@/lib/utils";

export type AgentOverviewModuleContent = {
	description: ReactNode;
	/** Override the default section route; null keeps an unresolved resource non-interactive. */
	link?: OverviewLinkOptions | null;
};

type OverviewLinkOptions = Pick<LinkProps, "to" | "params" | "search" | "hash">;

export const OVERVIEW_CHANNELS_DESCRIPTION = agentOverviewCopy.channelsDescription;

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
			className={agentOverviewCapabilitiesClasses.module}
		>
			<CardHeader className={agentOverviewCapabilitiesClasses.header}>
				{loading ? (
					<div className={agentOverviewCapabilitiesClasses.loadingHeading}>{heading}</div>
				) : (
					<Link
						{...agentSectionLink(agentId, section)}
						aria-label={title}
						className={agentOverviewCapabilitiesClasses.headingLink}
					>
						{heading}
					</Link>
				)}
			</CardHeader>
			{children ? (
				<CardContent className={agentOverviewCapabilitiesClasses.content}>{children}</CardContent>
			) : null}
		</Card>
	);
}

export function OverviewModuleError({ label, onRetry }: { label: string; onRetry?: () => void }) {
	return (
		<div className={agentOverviewCapabilitiesClasses.error} role="status">
			<p>Can’t load {label.toLowerCase()}</p>
			{onRetry ? (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className={agentOverviewCapabilitiesClasses.retry}
					onClick={onRetry}
				>
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
	prominent = false,
}: {
	title: string;
	description: ReactNode;
	icon: LucideIcon;
	tint: string;
	loading: boolean;
	arrow?: boolean;
	prominent?: boolean;
}) {
	return (
		<>
			<IconChip size={prominent ? "md" : "sm"} tint={loading ? "bg-muted animate-pulse" : tint}>
				{loading ? null : <Icon />}
			</IconChip>
			<div className={agentOverviewCapabilitiesClasses.headingBody}>
				<CardTitle>
					{loading ? (
						<Skeleton className={agentOverviewCapabilitiesClasses.titleSkeleton} />
					) : (
						title
					)}
				</CardTitle>
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
				<Skeleton className={agentOverviewCapabilitiesClasses.arrowSkeleton} />
			) : arrow ? (
				<ArrowRight
					aria-hidden="true"
					className={cn(
						agentOverviewCapabilitiesClasses.arrow,
						prominent
							? agentOverviewCapabilitiesClasses.arrowProminent
							: agentOverviewCapabilitiesClasses.arrowDefault,
					)}
				/>
			) : null}
		</>
	);
}

export function OverviewModuleUnavailable() {
	return <p className={agentOverviewCapabilitiesClasses.unavailable}>Unavailable right now</p>;
}

export function OverviewMetadata({
	items,
}: {
	items: readonly { label: string; value: ReactNode }[];
}) {
	return (
		<dl className={agentOverviewCapabilitiesClasses.metadata}>
			{items.map((item) => (
				<div key={item.label} className={agentOverviewCapabilitiesClasses.metadataRow}>
					<dt>{item.label}</dt>
					<dd className={agentOverviewCapabilitiesClasses.metadataValue}>{item.value}</dd>
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
			className={agentOverviewCapabilitiesClasses.root}
			data-agent-overview={variant}
			data-agent-overview-skeleton={loading ? variant : undefined}
		>
			{groups.map((group) => (
				<section
					key={group.id}
					className={agentOverviewCapabilitiesClasses.section}
					aria-labelledby={`agent-overview-${group.id}`}
				>
					<AgentOverviewSectionHeading>
						<h2
							id={`agent-overview-${group.id}`}
							className={agentOverviewCapabilitiesClasses.sectionTitle}
						>
							{loading ? (
								<Skeleton className={agentOverviewCapabilitiesClasses.sectionTitleSkeleton} />
							) : (
								group.label
							)}
						</h2>
					</AgentOverviewSectionHeading>
					<div
						data-overview-layout="two-column"
						className={agentOverviewCapabilitiesClasses.modules}
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
	prominent = false,
}: {
	id: string;
	title: string;
	description: ReactNode;
	icon: LucideIcon;
	tint: string;
	link: OverviewLinkOptions | null;
	disabled?: boolean;
	loading?: boolean;
	/** Visually emphasizes the card as a primary entry point. */
	prominent?: boolean;
}) {
	const content = (
		<OverviewCardHeading
			title={title}
			description={description}
			icon={Icon}
			tint={tint}
			loading={loading}
			arrow={Boolean(link || disabled || loading)}
			prominent={prominent}
		/>
	);
	return (
		<Card
			size="sm"
			role="article"
			data-overview-module={id}
			data-overview-module-skeleton={loading ? id : undefined}
			aria-busy={loading || undefined}
			data-overview-prominent={prominent || undefined}
			className={cn(
				agentOverviewCapabilitiesClasses.statusCard,
				prominent
					? agentOverviewCapabilitiesClasses.statusCardProminent
					: agentOverviewCapabilitiesClasses.statusCardDefault,
			)}
		>
			<CardHeader className={agentOverviewCapabilitiesClasses.statusHeader}>
				{loading ? (
					<div className={agentOverviewCapabilitiesClasses.statusContent}>{content}</div>
				) : disabled ? (
					<button
						type="button"
						disabled
						aria-label={title}
						className={agentOverviewCapabilitiesClasses.disabledStatus}
					>
						{content}
					</button>
				) : link ? (
					<Link
						{...link}
						aria-label={title}
						className={agentOverviewCapabilitiesClasses.statusLink}
					>
						{content}
					</Link>
				) : (
					<div className={agentOverviewCapabilitiesClasses.statusContent}>{content}</div>
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
