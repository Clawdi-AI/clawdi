/**
 * Layout primitives shared by detail pages (sessions, agents, skills,
 * memories). The pattern: an action row at top-right, an h1, a small
 * muted meta row, an optional stats row, then the page body.
 *
 * Each of these is "a div with an opinionated className" — but the
 * className appears 3+ times across detail pages, and getting it
 * slightly wrong on one page is exactly how the audit caught
 * gap drift between sessions/[id] and memories/[id]. Keeping the
 * pattern in one place means consistency by construction.
 *
 * Components are intentionally low-API. If a page needs more, it should
 * inline the JSX rather than expand these props — the goal is "every
 * detail page reads the same," not "build a detail-page DSL."
 */

import { AlertCircle } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

/** h1 used by detail pages. Centralized so the size/weight stays in one
 * place. Wrapping is the default — callers that want a single-line
 * truncation pass `className="truncate"` (skills detail does, memories
 * pass `whitespace-pre-wrap` for multi-line content). */
export function DetailTitle({ children, className }: { children: ReactNode; className?: string }) {
	return <h1 className={cn("font-semibold text-lg tracking-tight", className)}>{children}</h1>;
}

/** Subtitle row — small muted meta below the h1. The standard separator
 * between items is `·` (middle dot). Pages compose their own children. */
export function DetailMeta({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
			{children}
		</div>
	);
}

/** Stats row — Stat icons + ModelBadge, slightly bigger gaps than DetailMeta. */
export function DetailStats({ children }: { children: ReactNode }) {
	return <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{children}</div>;
}

/** Standard framed panel for detail pages. */
export function DetailPanel({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<section className={cn("rounded-lg border bg-card/60 p-4", className)}>{children}</section>
	);
}

export type DetailNavItem<T extends string> = {
	id: T;
	label: string;
	description?: string;
	href?: string;
	icon?: ComponentType<{ className?: string }>;
	count?: ReactNode;
};

export function DetailNavLayout({ nav, children }: { nav: ReactNode; children: ReactNode }) {
	return (
		<div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
			<aside className="min-w-0 lg:sticky lg:top-[calc(var(--header-height)+1rem)]">{nav}</aside>
			<div className="min-w-0">{children}</div>
		</div>
	);
}

export function DetailSectionNav<T extends string>({
	items,
	activeId,
	onSelect,
	label,
}: {
	items: DetailNavItem<T>[];
	activeId: T;
	onSelect: (id: T) => void;
	label: string;
}) {
	return (
		<nav
			aria-label={label}
			className="-mx-1 flex gap-1 overflow-x-auto border-b px-1 pb-2 lg:mx-0 lg:block lg:space-y-1 lg:overflow-visible lg:border-b-0 lg:px-0 lg:pb-0"
		>
			{items.map((item) => {
				const Icon = item.icon;
				const active = item.id === activeId;
				const className = cn(
					"flex min-w-40 shrink-0 items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 lg:w-full lg:min-w-0",
					active
						? "bg-accent text-accent-foreground"
						: "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
				);
				const content = (
					<>
						{Icon ? <Icon className="mt-0.5 size-4 shrink-0" /> : null}
						<span className="min-w-0 flex-1">
							<span className="flex min-w-0 items-center gap-2">
								<span className="truncate font-medium">{item.label}</span>
								{item.count !== undefined && item.count !== null ? (
									<span className="ml-auto shrink-0 text-xs tabular-nums opacity-70">
										{item.count}
									</span>
								) : null}
							</span>
							{item.description ? (
								<span className="mt-0.5 hidden text-xs leading-snug opacity-80 lg:block">
									{item.description}
								</span>
							) : null}
						</span>
					</>
				);
				if (item.href) {
					return (
						<a
							key={item.id}
							href={item.href}
							aria-current={active ? "page" : undefined}
							onClick={(event) => {
								if (
									event.defaultPrevented ||
									event.button !== 0 ||
									event.metaKey ||
									event.altKey ||
									event.ctrlKey ||
									event.shiftKey
								) {
									return;
								}
								event.preventDefault();
								onSelect(item.id);
							}}
							className={className}
						>
							{content}
						</a>
					);
				}
				return (
					<button
						key={item.id}
						type="button"
						aria-current={active ? "page" : undefined}
						onClick={() => onSelect(item.id)}
						className={className}
					>
						{content}
					</button>
				);
			})}
		</nav>
	);
}

/** Standard "X not found" alert used by 404 / not-owned states. */
export function DetailNotFound({ title, message }: { title: string; message: string }) {
	return (
		<Alert variant="destructive">
			<AlertCircle />
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}
