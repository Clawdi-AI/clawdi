"use client";

import { Link, type LinkProps } from "@tanstack/react-router";
import { Check, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The entity-card FAMILY. Consistency comes from SHARED PRIMITIVES, not one
 * rigid shape:
 *
 *   - `EntityIcon` (separate module)  — the real brand/app-icon tile
 *   - `IconChip` (separate module)    — the tinted symbolic glyph tile
 *   - `EntityHeader` / `EntityMeta`   — the `[icon] [title + meta]` lockup
 *   - `StatusBadge`, the p-4/gap-3/rounded-lg/border + hover/focus tokens
 *
 * Card TYPES compose those primitives but differ by the entity's role:
 *   - `EntityRow`        — compact list rows (channels, connectors)
 *   - `EntityChoiceCard` — selectable options (deploy wizard)
 *   - agent tiles, resource cards, pool items compose `EntityHeader` directly
 *     where they need a richer, bespoke body.
 */

export const ENTITY_CARD_BASE = "min-w-0 rounded-lg border bg-card p-4";

/** Top-level resource card tier: projects, vaults, skills, memories. */
export const HERO_CARD_BASE = "min-w-0 rounded-xl border bg-card p-5";

/** Responsive grid every top-level hero-card collection shares. */
export const HERO_GRID_CLASS = "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";

/** Responsive card grid every entity-card collection shares (providers,
 * channels, shared bots). */
export const ENTITY_GRID_CLASS = "grid gap-2 sm:grid-cols-2 xl:grid-cols-3";

/** Stretched link that makes a whole card navigate while keeping inner
 * controls independently clickable — pairs with a `relative z-0` wrapper. */
export const ENTITY_STRETCHED_LINK_CLASS =
	"absolute inset-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export const HERO_STRETCHED_LINK_CLASS =
	"absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Focus ring for whole-card buttons matching the stretched-link treatment. */
export const ENTITY_CARD_BUTTON_FOCUS_CLASS =
	"focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

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
		<div className={cn(ENTITY_CARD_BASE, className)}>
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
				<span key={keyFor(item, i)} className="inline-flex min-w-0 items-center">
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
}: {
	icon: ReactNode;
	title: ReactNode;
	titleAdornment?: ReactNode;
	meta?: ReactNode | ReactNode[];
	/** `start` aligns the icon to the top for multi-line bodies. */
	align?: "center" | "start";
	className?: string;
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
					<span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
					{titleAdornment ? <span className="shrink-0">{titleAdornment}</span> : null}
				</div>
				{meta !== undefined ? <EntityMeta items={meta} /> : null}
			</div>
		</div>
	);
}

type HeroCardLinkOptions = Pick<LinkProps, "to" | "params" | "search" | "hash">;

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
	ariaLabel,
	selected,
	interactive = true,
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
	link?: HeroCardLinkOptions;
	ariaLabel?: string;
	selected?: boolean;
	interactive?: boolean;
	className?: string;
	titleClassName?: string;
	descriptionClassName?: string;
	footerClassName?: string;
	children?: ReactNode;
}) {
	return (
		<div
			className={cn(
				HERO_CARD_BASE,
				"group relative z-0 flex min-h-36 flex-col gap-3 transition-all duration-150",
				selected
					? "border-foreground/40 bg-accent/50"
					: interactive && "hover:-translate-y-px hover:border-foreground/20",
				className,
			)}
		>
			{icon || actions ? (
				<div className="flex items-start justify-between gap-2">
					{icon ? <div className="shrink-0">{icon}</div> : <span aria-hidden />}
					{actions ? <div className="relative z-10 shrink-0">{actions}</div> : null}
				</div>
			) : null}
			<div className="min-w-0">
				<div className="flex min-w-0 items-center gap-1.5">
					<h3 className={cn("min-w-0 flex-1 truncate text-sm font-medium", titleClassName)}>
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
				<Link {...link} className={HERO_STRETCHED_LINK_CLASS}>
					<span className="sr-only">{ariaLabel ?? "Open"}</span>
				</Link>
			) : null}
		</div>
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
	href?: string;
	external?: boolean;
	ariaLabel?: string;
	/** Whole-row button. Ignored when `href` is set. */
	onClick?: () => void;
	disabled?: boolean;
	className?: string;
}

/**
 * Compact list row — `[icon][title + meta][status][chevron | actions]`. The
 * dense, single-line member of the family (channels, connectors). When `href`
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
	href,
	external,
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
			{actions ? (
				<div className="relative z-10 flex shrink-0 items-center gap-2">{actions}</div>
			) : null}
		</>
	);

	if (onClick && !href) {
		return (
			<button
				type="button"
				onClick={onClick}
				disabled={disabled}
				className={cn(
					ENTITY_CARD_BASE,
					"flex w-full items-center gap-3 text-left transition-colors hover:bg-muted/50",
					ENTITY_CARD_BUTTON_FOCUS_CLASS,
					disabled && "pointer-events-none opacity-60",
					className,
				)}
			>
				{body}
			</button>
		);
	}

	if (href) {
		const linkClass = ENTITY_STRETCHED_LINK_CLASS;
		return (
			<div className="group relative z-0 min-w-0">
				<div
					className={cn(
						ENTITY_CARD_BASE,
						"flex items-center gap-3 transition-colors group-hover:bg-muted/50",
						className,
					)}
				>
					{body}
					{!actions && !trailing ? (
						<ChevronRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
					) : null}
				</div>
				{external ? (
					<a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
						<span className="sr-only">{label}</span>
					</a>
				) : (
					<Link to={href} className={linkClass}>
						<span className="sr-only">{label}</span>
					</Link>
				)}
			</div>
		);
	}

	return <div className={cn(ENTITY_CARD_BASE, "flex items-center gap-3", className)}>{body}</div>;
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
	badge,
	selected,
	onClick,
	disabled,
	className,
}: {
	icon: ReactNode;
	title: ReactNode;
	description?: ReactNode;
	/** Trailing badge in the title row (e.g. "Default", an auth chip). */
	badge?: ReactNode;
	selected?: boolean;
	onClick?: () => void;
	disabled?: boolean;
	className?: string;
}) {
	const content = (
		<>
			{icon}
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
					{badge ? <span className="shrink-0">{badge}</span> : null}
				</div>
				{description ? (
					<p className="mt-0.5 break-words text-sm text-muted-foreground">{description}</p>
				) : null}
			</div>
			{selected ? <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden /> : null}
		</>
	);
	const cardClass = cn(
		ENTITY_CARD_BASE,
		"flex w-full items-start gap-3 text-left transition-colors",
		onClick && ENTITY_CARD_BUTTON_FOCUS_CLASS,
		selected
			? "border-primary bg-primary/5 ring-1 ring-primary/30"
			: onClick && "hover:bg-muted/50",
		disabled && "pointer-events-none opacity-60",
		className,
	);
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
