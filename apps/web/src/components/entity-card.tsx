"use client";

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

export type EntityCardVariant = "resource" | "compact";

/** Stable chassis tokens. Resource cards preserve richer content; compact
 * cards favor dense catalogs without leaving the entity-card family. */
export const ENTITY_CARD_CHASSIS_CLASS: Record<EntityCardVariant, string> = {
	resource: "min-w-0 rounded-xl border bg-card p-5",
	compact: "min-w-0 rounded-lg border bg-card p-4",
};

export const ENTITY_CARD_GRID_CLASS: Record<EntityCardVariant, string> = {
	resource: "grid gap-4 sm:grid-cols-2 xl:grid-cols-3",
	compact: "grid gap-2 sm:grid-cols-2 xl:grid-cols-3",
};

/** Variable-height resource notes keep the same responsive columns and gap
 * while avoiding the empty vertical space of equal-height grid rows. */
export const ENTITY_CARD_MASONRY_CLASS =
	"columns-1 gap-4 sm:columns-2 xl:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid";

/** Compatibility names for established non-resource callers. New resource
 * components should use the semantic chassis/grid contract above. */
export const ENTITY_CARD_BASE = ENTITY_CARD_CHASSIS_CLASS.compact;
export const HERO_CARD_BASE = ENTITY_CARD_CHASSIS_CLASS.resource;
export const HERO_GRID_CLASS = ENTITY_CARD_GRID_CLASS.resource;
export const ENTITY_GRID_CLASS = ENTITY_CARD_GRID_CLASS.compact;

/** Form-local choice cards follow their named main container instead of the viewport. */
export const ENTITY_CHOICE_GRID_CLASS = "grid gap-2 @2xl/main:grid-cols-2";

/** Stretched link that makes a whole card navigate while keeping inner
 * controls independently clickable — pairs with a `relative z-0` wrapper. */
export const ENTITY_CARD_STRETCHED_LINK_CLASS: Record<EntityCardVariant, string> = {
	compact:
		"absolute inset-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
	resource:
		"absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
};

export const ENTITY_STRETCHED_LINK_CLASS = ENTITY_CARD_STRETCHED_LINK_CLASS.compact;
export const HERO_STRETCHED_LINK_CLASS = ENTITY_CARD_STRETCHED_LINK_CLASS.resource;

/** Focus ring for whole-card buttons matching the stretched-link treatment. */
export const ENTITY_CARD_BUTTON_FOCUS_CLASS =
	"focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * Card actions stay visible and comfortably tappable on touch screens, then
 * recede until hover or keyboard focus on larger screens. Keep this in the
 * shared slot so Project, Skill, Vault, and note-style Memory cards do not
 * each invent a different action rhythm.
 */
export const ENTITY_CARD_ACTIONS_CLASS =
	"relative z-10 flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity duration-150 max-sm:[&_button]:min-h-11 max-sm:[&_button[aria-label]]:min-w-11 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100";
const ENTITY_CARD_ACTIONS_ALWAYS_CLASS =
	"relative z-10 flex shrink-0 items-center gap-2 max-sm:[&_button]:min-h-11 max-sm:[&_button[aria-label]]:min-w-11";

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
		"group relative z-0 transition-all duration-150",
		interactive &&
			(variant === "resource"
				? "hover:-translate-y-px hover:border-foreground/20 focus-within:-translate-y-px focus-within:border-foreground/20"
				: "hover:bg-muted/50 focus-within:bg-muted/50"),
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
		variant === "compact"
			? "min-w-0 rounded-md border border-border bg-muted/30 p-2.5"
			: ENTITY_CARD_BASE,
		"flex w-full text-left transition-colors",
		variant === "compact" ? "items-center gap-2.5" : "items-start gap-3",
		interactive && ENTITY_CARD_BUTTON_FOCUS_CLASS,
		selected
			? "border-primary bg-primary/5 ring-1 ring-primary/30"
			: interactive && (variant === "compact" ? "hover:bg-muted/60" : "hover:bg-muted/50"),
		disabled && "pointer-events-none opacity-60",
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
			<div className="flex items-start gap-3">
				<Skeleton
					className={cn("shrink-0", iconSize === "sm" ? "size-8 rounded-md" : "size-10 rounded-lg")}
				/>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-1.5">
						{statusDot ? <Skeleton className="size-1.5 shrink-0 rounded-full" /> : null}
						<Skeleton className="h-4 min-w-16 flex-1 max-w-32" />
						{titleBadge ? <Skeleton className="h-5 w-16 shrink-0 rounded-full" /> : null}
					</div>
					{metaLines > 0 ? <Skeleton className="mt-2 h-3 w-40 max-w-[80%]" /> : null}
					{metaLines > 1 ? <Skeleton className="mt-1.5 h-3 w-full max-w-56" /> : null}
				</div>
				{trailingBadge ? <Skeleton className="h-5 w-16 shrink-0 rounded-full" /> : null}
			</div>
			{actions ? (
				<div className="mt-3 flex items-center gap-2">
					<Skeleton className="h-8 w-20 rounded-md" />
					<Skeleton className="h-8 w-14 rounded-md" />
					<Skeleton className="ml-auto size-8 rounded-md" />
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
				className: cn("flex flex-col", compact ? "min-h-28 gap-2" : "min-h-36 gap-3", className),
			})}
			aria-hidden="true"
			data-slot="hero-card-skeleton"
		>
			<Skeleton className={compact ? "size-8 rounded-lg" : "size-10 rounded-lg"} />
			<div className="min-w-0 space-y-2">
				<Skeleton className="h-4 w-40 max-w-full" />
				<Skeleton className="h-3 w-56 max-w-[85%]" />
			</div>
			{footerItems > 0 ? (
				<div className="mt-auto flex items-center gap-3">
					<Skeleton className="h-3 w-16" />
					{footerItems > 1 ? <Skeleton className="h-3 w-28 max-w-[45%]" /> : null}
				</div>
			) : null}
		</div>
	);
}

/** Meta line — array items render middot-separated on one truncating line. */
export function EntityMeta({
	items,
	className,
}: {
	items: ReactNode | ReactNode[];
	className?: string;
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
			className={cn(
				"mt-0.5 flex min-w-0 items-center overflow-hidden text-sm text-muted-foreground",
				className,
			)}
		>
			{arr.map((item, i) => (
				<span
					key={keyFor(item, i)}
					className="inline-flex min-w-0 items-center"
					title={typeof item === "string" || typeof item === "number" ? String(item) : undefined}
				>
					{i > 0 ? <span className="mx-1.5 shrink-0 text-muted-foreground/40">·</span> : null}
					<span className="min-w-0 truncate">{item}</span>
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
				"flex min-w-0 gap-3",
				align === "start" ? "items-start" : "items-center",
				className,
			)}
		>
			{icon}
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<span
						className={cn("min-w-0 flex-1 truncate text-sm font-medium", titleClassName)}
						title={
							titleAttribute ??
							(typeof title === "string" || typeof title === "number" ? String(title) : undefined)
						}
					>
						{title}
					</span>
					{titleAdornment ? <span className="shrink-0">{titleAdornment}</span> : null}
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
	link,
	onClick,
	ariaLabel,
	className,
	titleClassName,
	descriptionClassName,
	footerClassName,
	children,
}: {
	icon?: ReactNode;
	title: ReactNode;
	badges?: ReactNode;
	description?: ReactNode;
	footer?: ReactNode | ReactNode[];
	actions?: ReactNode;
	link?: EntityCardLinkOptions;
	/** Whole-card button for state-driven detail views. Ignored when `link` is set. */
	onClick?: () => void;
	ariaLabel?: string;
	className?: string;
	titleClassName?: string;
	descriptionClassName?: string;
	footerClassName?: string;
	children?: ReactNode;
}) {
	return (
		<EntityCardChassis
			variant="resource"
			interactive={Boolean(link || onClick)}
			className={cn("flex min-h-36 flex-col gap-3", className)}
		>
			{icon || actions ? (
				<div className="flex items-start justify-between gap-2">
					{icon ? <div className="shrink-0">{icon}</div> : <span aria-hidden />}
					{actions ? <EntityCardActions>{actions}</EntityCardActions> : null}
				</div>
			) : null}
			<div className="min-w-0">
				<div className="flex min-w-0 items-center gap-1.5">
					<h3
						className={cn("min-w-0 flex-1 truncate text-sm font-medium", titleClassName)}
						title={
							typeof title === "string" || typeof title === "number" ? String(title) : undefined
						}
					>
						{title}
					</h3>
					{badges ? <div className="flex shrink-0 items-center gap-1.5">{badges}</div> : null}
				</div>
				{description ? (
					<p
						className={cn(
							"mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground",
							descriptionClassName,
						)}
					>
						{description}
					</p>
				) : null}
			</div>
			{children}
			{footer !== undefined ? (
				<EntityMeta
					items={footer}
					className={cn("mt-auto text-xs text-muted-foreground tabular-nums", footerClassName)}
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
			{status ? <div className="shrink-0">{status}</div> : null}
			{trailing ? <div className="relative z-10 shrink-0">{trailing}</div> : null}
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
					"flex w-full items-center gap-3 text-left",
					ENTITY_CARD_BUTTON_FOCUS_CLASS,
					disabled && "pointer-events-none opacity-60",
					className,
				)}
			>
				{body}
			</button>
		);
	}

	if (link) {
		return (
			<div className="group relative z-0 min-w-0">
				<EntityCardChassis
					variant="compact"
					className={cn(
						"flex items-center gap-3 group-hover:bg-muted/50 group-focus-within:bg-muted/50",
						className,
					)}
				>
					{body}
					{!actions && !trailing ? (
						<ChevronRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
					) : null}
				</EntityCardChassis>
				<EntityCardLink variant="compact" {...link} ariaLabel={label} />
			</div>
		);
	}

	return (
		<EntityCardChassis variant="compact" className={cn("flex items-center gap-3", className)}>
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
	/** Trailing badge in the title row (e.g. "Default", an auth chip). */
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
			<span aria-hidden="true" className="flex shrink-0">
				{icon}
			</span>
			<div
				className={cn(
					"min-w-0 flex-1",
					details && detailsPlacement === "trailing" && "flex items-start gap-3",
					details &&
						detailsPlacement === "responsive" &&
						"flex flex-col gap-2 @md/choice:flex-row @md/choice:items-start @md/choice:gap-3",
				)}
			>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-2">
						<span
							className="min-w-0 flex-1 truncate text-sm font-medium"
							title={
								typeof title === "string" || typeof title === "number" ? String(title) : undefined
							}
						>
							{title}
						</span>
						{badge ? <span className="shrink-0">{badge}</span> : null}
					</div>
					{description ? (
						<p
							className={cn(
								"mt-0.5 text-muted-foreground",
								variant === "compact" ? "truncate text-xs leading-4" : "break-words text-sm",
							)}
						>
							{description}
						</p>
					) : null}
				</div>
				{details ? (
					<div
						className={cn(
							"min-w-0",
							detailsPlacement === "trailing"
								? "max-w-[45%] shrink-0"
								: detailsPlacement === "responsive"
									? "w-full @md/choice:w-auto @md/choice:max-w-[52%] @md/choice:shrink-0"
									: "mt-2",
						)}
					>
						{details}
					</div>
				) : null}
			</div>
			{selected ? (
				<Check
					className={cn(
						"mt-0.5 size-4 shrink-0 text-primary",
						detailsPlacement === "responsive" && "hidden @md/choice:block",
					)}
					aria-hidden
				/>
			) : detailsPlacement === "trailing" ? (
				<span className="size-4 shrink-0" aria-hidden />
			) : detailsPlacement === "responsive" ? (
				<span className="hidden size-4 shrink-0 @md/choice:block" aria-hidden />
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
			selected={false}
			onClick={onClick}
			href={href}
			icon={
				<IconChip tint="bg-muted text-muted-foreground">
					<Plus />
				</IconChip>
			}
			title={title}
			description={description}
			className="h-full border-dashed bg-card"
		/>
	);
}
