"use client";
import {
	ENTITY_CARD_ACTIONS_ALWAYS_CLASS,
	ENTITY_CARD_ACTIONS_CLASS,
	ENTITY_CARD_BASE,
	ENTITY_CARD_BUTTON_FOCUS_CLASS,
	ENTITY_CARD_CHASSIS_CLASS,
	ENTITY_CARD_STRETCHED_LINK_CLASS,
	type EntityCardVariant,
	HERO_STRETCHED_LINK_CLASS,
} from "@clawdi/shared/ui";

export {
	ENTITY_CARD_ACTIONS_CLASS,
	ENTITY_CARD_BASE,
	ENTITY_CARD_BUTTON_FOCUS_CLASS,
	ENTITY_CARD_CHASSIS_CLASS,
	ENTITY_CARD_GRID_CLASS,
	ENTITY_CARD_MASONRY_CLASS,
	ENTITY_CARD_STRETCHED_LINK_CLASS,
	ENTITY_CHOICE_GRID_CLASS,
	ENTITY_GRID_CLASS,
	ENTITY_STRETCHED_LINK_CLASS,
	type EntityCardVariant,
	HERO_CARD_BASE,
	HERO_GRID_CLASS,
	HERO_STRETCHED_LINK_CLASS,
} from "@clawdi/shared/ui";

import { entityCardClasses } from "@clawdi/shared/ui";

import { Link, type LinkProps } from "@tanstack/react-router";
import { Check, ChevronRight, Plus } from "lucide-react";
import type { FocusEventHandler, MouseEventHandler, ReactNode } from "react";
import { IconChip } from "@/components/icon-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The entity-card FAMILY. Consistency comes from SHARED PRIMITIVES, not one
 * rigid shape:
 *
 *   - `EntityIcon` (separate module)  — the real brand/app-icon tile
 *   - `IconChip` (separate module)    — the tinted symbolic glyph tile
 *   - `EntityHeader` / `EntityMeta`   — the `[icon] [title + meta]` lockup
 *   - `EntityCardChassis`             — container, interaction, and density tokens
 *
 * Card TYPES compose those primitives but differ by the entity's role:
 *   - `EntityCardChassis` — resource / compact container and interaction tokens
 *   - `EntityRow`        — compact list rows (channels, connectors)
 *   - `EntityChoiceCard` — selectable options (deploy wizard)
 *   - agent tiles, resource cards, pool items compose `EntityHeader` directly
 *     where they need a richer, bespoke body.
 */

export function entityCardChassisClass({
	variant,
	interactive = false,
	className,
}: {
	variant: EntityCardVariant;
	interactive?: boolean;
	className?: string;
}) {
	return cn(
		ENTITY_CARD_CHASSIS_CLASS[variant],
		entityCardClasses.chassis,
		interactive &&
			(variant === "resource"
				? entityCardClasses.resourceInteractive
				: entityCardClasses.compactInteractive),
		className,
	);
}

export function EntityCardChassis({
	variant,
	interactive = false,
	as: Component = "div",
	className,
	children,
}: {
	variant: EntityCardVariant;
	interactive?: boolean;
	as?: "div" | "article";
	className?: string;
	children: ReactNode;
}) {
	return (
		<Component
			className={entityCardChassisClass({ variant, interactive, className })}
			data-slot="entity-card"
			data-variant={variant}
			data-interactive={interactive || undefined}
		>
			{children}
		</Component>
	);
}

export function EntityCardActions({
	children,
	className,
	visibility = "responsive",
}: {
	children: ReactNode;
	className?: string;
	visibility?: "responsive" | "always";
}) {
	return (
		<div
			className={cn(
				visibility === "responsive" ? ENTITY_CARD_ACTIONS_CLASS : ENTITY_CARD_ACTIONS_ALWAYS_CLASS,
				entityCardClasses.actionsInteractive,
				className,
			)}
		>
			{children}
		</div>
	);
}

export type EntityCardLinkOptions = Pick<LinkProps, "to" | "params" | "search" | "hash"> & {
	onMouseEnter?: MouseEventHandler<HTMLAnchorElement>;
	onFocus?: FocusEventHandler<HTMLAnchorElement>;
};

export function EntityCardLink({
	variant,
	ariaLabel,
	className,
	onMouseEnter,
	onFocus,
	...link
}: EntityCardLinkOptions & {
	variant: EntityCardVariant;
	ariaLabel: string;
	className?: string;
}) {
	return (
		<Link
			{...link}
			className={cn(ENTITY_CARD_STRETCHED_LINK_CLASS[variant], className)}
			onMouseEnter={onMouseEnter}
			onFocus={onFocus}
		>
			<span className="sr-only">{ariaLabel}</span>
		</Link>
	);
}

type EntityChoiceCardVariant = "card" | "compact";
type EntityChoiceDetailsPlacement = "stacked" | "trailing" | "responsive";

export function entityChoiceCardClass({
	variant = "card",
	selected = false,
	interactive = false,
	disabled = false,
	className,
}: {
	variant?: EntityChoiceCardVariant;
	selected?: boolean;
	interactive?: boolean;
	disabled?: boolean;
	className?: string;
}) {
	return cn(
		variant === "compact" ? entityCardClasses.compactChoice : ENTITY_CARD_BASE,
		entityCardClasses.choiceRoot,
		variant === "compact" ? entityCardClasses.choiceCompactLayout : entityCardClasses.choiceLayout,
		interactive && ENTITY_CARD_BUTTON_FOCUS_CLASS,
		selected
			? entityCardClasses.choiceSelected
			: interactive &&
					(variant === "compact"
						? entityCardClasses.compactChoiceInteractive
						: entityCardClasses.choiceInteractive),
		disabled && entityCardClasses.disabled,
		className,
	);
}

/** Shared loading shape for entity cards and selectable entity options. */
export function EntityCardSkeleton({
	iconSize = "md",
	metaLines = 1,
	statusDot = false,
	titleBadge = false,
	trailingBadge = false,
	actions = false,
	className,
}: {
	iconSize?: "sm" | "md";
	metaLines?: 0 | 1 | 2;
	statusDot?: boolean;
	titleBadge?: boolean;
	trailingBadge?: boolean;
	actions?: boolean;
	className?: string;
}) {
	return (
		<div className={entityCardChassisClass({ variant: "compact", className })}>
			<div className={entityCardClasses.skeletonRow}>
				<Skeleton
					className={cn(
						entityCardClasses.shrink,
						iconSize === "sm"
							? entityCardClasses.smallSkeletonIcon
							: entityCardClasses.skeletonIcon,
					)}
				/>
				<div className={entityCardClasses.body}>
					<div className={entityCardClasses.titleRow}>
						{statusDot ? <Skeleton className={entityCardClasses.skeletonDot} /> : null}
						<Skeleton className={entityCardClasses.skeletonTitle} />
						{titleBadge ? <Skeleton className={entityCardClasses.skeletonBadge} /> : null}
					</div>
					{metaLines > 0 ? <Skeleton className={entityCardClasses.skeletonMeta} /> : null}
					{metaLines > 1 ? <Skeleton className={entityCardClasses.skeletonSecondMeta} /> : null}
				</div>
				{trailingBadge ? <Skeleton className={entityCardClasses.skeletonBadge} /> : null}
			</div>
			{actions ? (
				<div className={entityCardClasses.skeletonActions}>
					<Skeleton className={entityCardClasses.skeletonPrimaryAction} />
					<Skeleton className={entityCardClasses.skeletonSecondaryAction} />
					<Skeleton className={entityCardClasses.skeletonMoreAction} />
				</div>
			) : null}
		</div>
	);
}

/** Loading shape for top-level resource cards. */
export function HeroCardSkeleton({
	compact = false,
	footerItems = 2,
	className,
}: {
	compact?: boolean;
	footerItems?: 0 | 1 | 2;
	className?: string;
}) {
	return (
		<div
			className={entityCardChassisClass({
				variant: "resource",
				className: cn(
					entityCardClasses.heroSkeletonRoot,
					compact ? entityCardClasses.compactHeroSkeleton : entityCardClasses.heroSkeleton,
					className,
				),
			})}
			aria-hidden="true"
			data-slot="hero-card-skeleton"
		>
			<Skeleton
				className={
					compact ? entityCardClasses.compactHeroSkeletonIcon : entityCardClasses.skeletonIcon
				}
			/>
			<div className={entityCardClasses.heroSkeletonBody}>
				<Skeleton className={entityCardClasses.heroSkeletonTitle} />
				<Skeleton className={entityCardClasses.heroSkeletonDescription} />
			</div>
			{footerItems > 0 ? (
				<div className={entityCardClasses.heroSkeletonFooter}>
					<Skeleton className={entityCardClasses.heroSkeletonFirstFact} />
					{footerItems > 1 ? (
						<Skeleton className={entityCardClasses.heroSkeletonSecondFact} />
					) : null}
				</div>
			) : null}
		</div>
	);
}

/** Meta facts use middots on one truncating line or stable spacing when wrapping. */
export function EntityMeta({
	items,
	className,
	wrap = false,
}: {
	items: ReactNode | ReactNode[];
	className?: string;
	/** Keep each item intact and wrap between items instead of compressing the row. */
	wrap?: boolean;
}) {
	const arr = (Array.isArray(items) ? items : [items]).filter(
		(x) => x !== null && x !== undefined && x !== false && x !== "",
	);
	if (arr.length === 0) return null;
	// Stable, content-derived keys (string items key on their text; nodes on
	// position) so we never key on the raw map index.
	const keyFor = (item: ReactNode, i: number) =>
		typeof item === "string" || typeof item === "number" ? `t:${item}` : `n:${i}`;
	return (
		<div
			data-slot="entity-meta"
			className={cn(
				entityCardClasses.meta,
				wrap ? entityCardClasses.metaWrap : entityCardClasses.metaTruncate,
				className,
			)}
		>
			{arr.map((item, i) => (
				<span
					key={keyFor(item, i)}
					className={cn(entityCardClasses.metaItem, wrap && entityCardClasses.metaItemWrap)}
					title={typeof item === "string" || typeof item === "number" ? String(item) : undefined}
				>
					{i > 0 && !wrap ? <span className={entityCardClasses.metaSeparator}>·</span> : null}
					<span className={entityCardClasses.metaText}>{item}</span>
				</span>
			))}
		</div>
	);
}

/**
 * The shared lockup every card type reuses: `[EntityIcon] [title (+adornment) /
 * meta]`. This is where the cross-surface consistency lives.
 */
export function EntityHeader({
	icon,
	title,
	titleAdornment,
	meta,
	align = "center",
	className,
	titleClassName,
	titleAttribute,
}: {
	icon: ReactNode;
	title: ReactNode;
	titleAdornment?: ReactNode;
	meta?: ReactNode | ReactNode[];
	/** `start` aligns the icon to the top for multi-line bodies. */
	align?: "center" | "start";
	className?: string;
	titleClassName?: string;
	/** Full plain-text identity for a visually truncated title. */
	titleAttribute?: string;
}) {
	return (
		<div
			className={cn(
				entityCardClasses.header,
				align === "start" ? entityCardClasses.headerStart : entityCardClasses.headerCenter,
				className,
			)}
		>
			{icon}
			<div className={entityCardClasses.body}>
				<div className={entityCardClasses.headerTitleRow}>
					<span
						className={cn(entityCardClasses.title, titleClassName)}
						title={
							titleAttribute ??
							(typeof title === "string" || typeof title === "number" ? String(title) : undefined)
						}
					>
						{title}
					</span>
					{titleAdornment ? (
						<span className={entityCardClasses.shrink}>{titleAdornment}</span>
					) : null}
				</div>
				{meta !== undefined ? <EntityMeta items={meta} /> : null}
			</div>
		</div>
	);
}

/**
 * Top-level resource card — `[icon tile] / [title + badges] / [description] /
 * [middot meta footer]`. Projects, vaults, skills, and memories share this
 * tier so their grids read as one collection language.
 */
export function HeroCard({
	icon,
	title,
	badges,
	description,
	footer,
	actions,
	actionsVisibility = "responsive",
	link,
	onClick,
	ariaLabel,
	className,
	titleClassName,
	titleAttribute,
	descriptionClassName,
	footerClassName,
	footerWrap = false,
	children,
}: {
	icon?: ReactNode;
	title: ReactNode;
	badges?: ReactNode;
	description?: ReactNode;
	footer?: ReactNode | ReactNode[];
	actions?: ReactNode;
	/** Action visibility rhythm; `responsive` recedes until hover/focus on desktop. */
	actionsVisibility?: "responsive" | "always";
	link?: EntityCardLinkOptions;
	/** Whole-card button for state-driven detail views. Ignored when `link` is set. */
	onClick?: () => void;
	ariaLabel?: string;
	className?: string;
	titleClassName?: string;
	/** Plain-text identity when the visible title contains search highlighting. */
	titleAttribute?: string;
	descriptionClassName?: string;
	footerClassName?: string;
	/** Wrap dense footer facts between intact items. */
	footerWrap?: boolean;
	children?: ReactNode;
}) {
	return (
		<EntityCardChassis
			variant="resource"
			interactive={Boolean(link || onClick)}
			className={cn(entityCardClasses.hero, className)}
		>
			{icon || actions ? (
				<div className={entityCardClasses.heroTop}>
					{icon ? <div className={entityCardClasses.shrink}>{icon}</div> : <span aria-hidden />}
					{actions ? (
						<EntityCardActions visibility={actionsVisibility}>{actions}</EntityCardActions>
					) : null}
				</div>
			) : null}
			<div className={entityCardClasses.heroBody}>
				<div className={entityCardClasses.titleRow}>
					<h3
						className={cn(entityCardClasses.title, titleClassName)}
						title={
							titleAttribute ??
							(typeof title === "string" || typeof title === "number" ? String(title) : undefined)
						}
					>
						{title}
					</h3>
					{badges ? <div className={entityCardClasses.heroBadges}>{badges}</div> : null}
				</div>
				{description ? (
					<p className={cn(entityCardClasses.heroDescription, descriptionClassName)}>
						{description}
					</p>
				) : null}
			</div>
			{children}
			{footer !== undefined ? (
				<EntityMeta
					items={footer}
					className={cn(entityCardClasses.heroFooter, footerClassName)}
					wrap={footerWrap}
				/>
			) : null}
			{link ? (
				<EntityCardLink variant="resource" {...link} ariaLabel={ariaLabel ?? "Open"} />
			) : onClick ? (
				<button
					type="button"
					onClick={onClick}
					className={cn(HERO_STRETCHED_LINK_CLASS, "cursor-pointer")}
				>
					<span className="sr-only">{ariaLabel ?? "Open"}</span>
				</button>
			) : null}
		</EntityCardChassis>
	);
}

interface EntityRowProps {
	icon: ReactNode;
	title: ReactNode;
	titleAdornment?: ReactNode;
	meta?: ReactNode | ReactNode[];
	/** Right-aligned status chip (StatusBadge). Non-interactive. */
	status?: ReactNode;
	/** Right-aligned interactive controls; suppresses the chevron. */
	actions?: ReactNode;
	/** Extra right-aligned interactive content (e.g. a manage link). */
	trailing?: ReactNode;
	/** Whole-row navigation (stretched link). */
	link?: EntityCardLinkOptions;
	ariaLabel?: string;
	/** Whole-row button. Ignored when `link` is set. */
	onClick?: () => void;
	disabled?: boolean;
	className?: string;
}

/**
 * Compact list row — `[icon][title + meta][status][chevron | actions]`. The
 * dense, single-line member of the family (channels, connectors). When `link`
 * is set the whole row navigates via a stretched link while `actions`/`trailing`
 * stay independently clickable.
 */
export function EntityRow({
	icon,
	title,
	titleAdornment,
	meta,
	status,
	actions,
	trailing,
	link,
	ariaLabel,
	onClick,
	disabled,
	className,
}: EntityRowProps) {
	const label = ariaLabel ?? (typeof title === "string" ? title : "Open");
	const body = (
		<>
			<EntityHeader icon={icon} title={title} titleAdornment={titleAdornment} meta={meta} />
			{status ? <div className={entityCardClasses.shrink}>{status}</div> : null}
			{trailing ? <div className={entityCardClasses.trailing}>{trailing}</div> : null}
			{actions ? <EntityCardActions visibility="always">{actions}</EntityCardActions> : null}
		</>
	);

	if (onClick && !link) {
		return (
			<button
				type="button"
				onClick={onClick}
				disabled={disabled}
				className={cn(
					entityCardChassisClass({ variant: "compact", interactive: true }),
					entityCardClasses.rowButton,
					ENTITY_CARD_BUTTON_FOCUS_CLASS,
					disabled && entityCardClasses.disabled,
					className,
				)}
			>
				{body}
			</button>
		);
	}

	if (link) {
		return (
			<div className={entityCardClasses.rowLinkContainer}>
				<EntityCardChassis
					variant="compact"
					className={cn(entityCardClasses.rowLinkBody, className)}
				>
					{body}
					{!actions && !trailing ? (
						<ChevronRight className={entityCardClasses.chevron} aria-hidden />
					) : null}
				</EntityCardChassis>
				<EntityCardLink variant="compact" {...link} ariaLabel={label} />
			</div>
		);
	}

	return (
		<EntityCardChassis variant="compact" className={cn(entityCardClasses.row, className)}>
			{body}
		</EntityCardChassis>
	);
}

/**
 * Selectable option — icon + title + description + a selected check/ring. The
 * picker member of the family (deploy-wizard framework / provider / channel
 * choices).
 */
export function EntityChoiceCard({
	icon,
	title,
	description,
	details,
	detailsPlacement = "stacked",
	badge,
	selected,
	onClick,
	href,
	disabled,
	variant = "card",
	className,
}: {
	icon: ReactNode;
	title: ReactNode;
	description?: ReactNode;
	/** Optional detail block below the description (for example, pricing). */
	details?: ReactNode;
	/** Keep dense, comparable details beside the main copy when space allows. */
	detailsPlacement?: EntityChoiceDetailsPlacement;
	/** Trailing badge in the title row (e.g. "Recommended", an auth chip). */
	badge?: ReactNode;
	selected?: boolean;
	onClick?: () => void;
	href?: string;
	disabled?: boolean;
	/** Compact, low-chrome treatment for dense chooser grids. */
	variant?: "card" | "compact";
	className?: string;
}) {
	const content = (
		<>
			<span aria-hidden="true" className={entityCardClasses.choiceIcon}>
				{icon}
			</span>
			<div
				className={cn(
					entityCardClasses.body,
					details && detailsPlacement === "trailing" && entityCardClasses.skeletonRow,
					details && detailsPlacement === "responsive" && entityCardClasses.choiceResponsiveDetails,
				)}
			>
				<div className={entityCardClasses.body}>
					<div className={entityCardClasses.headerTitleRow}>
						<span
							className={entityCardClasses.title}
							title={
								typeof title === "string" || typeof title === "number" ? String(title) : undefined
							}
						>
							{title}
						</span>
						{badge ? <span className={entityCardClasses.shrink}>{badge}</span> : null}
					</div>
					{description ? (
						<p
							className={cn(
								entityCardClasses.choiceDescription,
								variant === "compact"
									? entityCardClasses.compactChoiceDescription
									: entityCardClasses.fullChoiceDescription,
							)}
						>
							{description}
						</p>
					) : null}
				</div>
				{details ? (
					<div
						className={cn(
							entityCardClasses.heroBody,
							detailsPlacement === "trailing"
								? entityCardClasses.choiceTrailingDetails
								: detailsPlacement === "responsive"
									? entityCardClasses.choiceResponsiveDetailsBody
									: entityCardClasses.choiceStackedDetails,
						)}
					>
						{details}
					</div>
				) : null}
			</div>
			{selected !== undefined ? (
				<span
					data-slot="entity-choice-indicator"
					className={entityCardClasses.choiceIndicator}
					aria-hidden
				>
					{selected ? <Check className={entityCardClasses.choiceCheck} /> : null}
				</span>
			) : null}
		</>
	);
	const cardClass = entityChoiceCardClass({
		variant,
		selected,
		interactive: Boolean(onClick || href),
		disabled,
		className: cn(detailsPlacement === "responsive" && "@container/choice", className),
	});
	if (href) {
		return (
			<Link to={href} className={cardClass}>
				{content}
			</Link>
		);
	}
	if (!onClick) {
		return <div className={cardClass}>{content}</div>;
	}
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-pressed={selected}
			className={cardClass}
		>
			{content}
		</button>
	);
}

/** Dashed add action used at the end of form-local entity choice grids. */
export function EntityAddCard({
	title,
	description,
	onClick,
	href,
}: {
	title: string;
	description: string;
	onClick?: () => void;
	href?: string;
}) {
	return (
		<EntityChoiceCard
			onClick={onClick}
			href={href}
			icon={
				<IconChip tint={entityCardClasses.addTint}>
					<Plus />
				</IconChip>
			}
			title={title}
			description={description}
			className={entityCardClasses.add}
		/>
	);
}
