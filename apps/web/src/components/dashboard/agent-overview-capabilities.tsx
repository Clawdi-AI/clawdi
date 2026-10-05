import { agentOverviewCapabilitiesClasses } from "@clawdi/shared/ui";
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
			className={agentOverviewCapabilitiesClasses.hFullMinW}
		>
			<CardHeader className={agentOverviewCapabilitiesClasses.p}>
				{loading ? (
					<div className={agentOverviewCapabilitiesClasses.flexItemsCenterGap}>{heading}</div>
				) : (
					<Link
						{...agentSectionLink(agentId, section)}
						aria-label={title}
						className={agentOverviewCapabilitiesClasses.groupFlexItemsCenter}
					>
						{heading}
					</Link>
				)}
			</CardHeader>
			{children ? (
				<CardContent className={agentOverviewCapabilitiesClasses.flexFlexFlexCol}>
					{children}
				</CardContent>
			) : null}
		</Card>
	);
}

export function OverviewModuleError({ label, onRetry }: { label: string; onRetry?: () => void }) {
	return (
		<div className={agentOverviewCapabilitiesClasses.spaceYTextSm} role="status">
			<p>Can’t load {label.toLowerCase()}</p>
			{onRetry ? (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className={agentOverviewCapabilitiesClasses.hPx}
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
			<div className={agentOverviewCapabilitiesClasses.minWFlex}>
				<CardTitle>
					{loading ? <Skeleton className={agentOverviewCapabilitiesClasses.hLhWMax} /> : title}
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
				<Skeleton className={agentOverviewCapabilitiesClasses.sizeShrink} />
			) : arrow ? (
				<ArrowRight
					aria-hidden="true"
					className={agentOverviewCapabilitiesClasses.sizeShrinkTextMuted}
				/>
			) : null}
		</>
	);
}

export function OverviewModuleUnavailable() {
	return <p className={agentOverviewCapabilitiesClasses.textSmTextMuted}>Unavailable right now</p>;
}

export function OverviewMetadata({
	items,
}: {
	items: readonly { label: string; value: ReactNode }[];
}) {
	return (
		<dl className={agentOverviewCapabilitiesClasses.spaceYTextXs}>
			{items.map((item) => (
				<div key={item.label} className={agentOverviewCapabilitiesClasses.flexMinWItems}>
					<dt>{item.label}</dt>
					<dd className={agentOverviewCapabilitiesClasses.minWBreakWords}>{item.value}</dd>
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
			className={agentOverviewCapabilitiesClasses.flexFlexColGap}
			data-agent-overview={variant}
			data-agent-overview-skeleton={loading ? variant : undefined}
		>
			{groups.map((group) => (
				<section
					key={group.id}
					className={agentOverviewCapabilitiesClasses.flexFlexColGap2}
					aria-labelledby={`agent-overview-${group.id}`}
				>
					<AgentOverviewSectionHeading>
						<h2
							id={`agent-overview-${group.id}`}
							className={agentOverviewCapabilitiesClasses.textSmFontSemibold}
						>
							{loading ? (
								<Skeleton className={agentOverviewCapabilitiesClasses.hLhW} />
							) : (
								group.label
							)}
						</h2>
					</AgentOverviewSectionHeading>
					<div
						data-overview-layout="two-column"
						className={agentOverviewCapabilitiesClasses.gridAutoRowsFr}
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
			className={agentOverviewCapabilitiesClasses.hFullMinW2}
		>
			<CardHeader className={agentOverviewCapabilitiesClasses.hFullGridRows}>
				{loading ? (
					<div className={agentOverviewCapabilitiesClasses.flexMinWItems2}>{content}</div>
				) : disabled ? (
					<button
						type="button"
						disabled
						aria-label={title}
						className={agentOverviewCapabilitiesClasses.flexMinWItems3}
					>
						{content}
					</button>
				) : link ? (
					<Link
						{...link}
						aria-label={title}
						className={agentOverviewCapabilitiesClasses.groupFlexMinW}
					>
						{content}
					</Link>
				) : (
					<div className={agentOverviewCapabilitiesClasses.flexMinWItems2}>{content}</div>
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
