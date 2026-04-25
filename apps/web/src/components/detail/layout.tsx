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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

/** h1 used by detail pages. Centralized so the size/weight stays in one
 * place. Wrapping is the default — callers that want a single-line
 * truncation pass `className="truncate"` (skills detail does, memories
 * pass `whitespace-pre-wrap` for multi-line content). */
export function DetailTitle({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return <h1 className={cn("font-semibold text-lg tracking-tight", className)}>{children}</h1>;
}

/** Subtitle row — small muted meta below the h1. The standard separator
 * between items is `·` (middle dot). Pages compose their own children. */
export function DetailMeta({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
			{children}
		</div>
	);
}

/** Stats row — Stat icons + ModelBadge, slightly bigger gaps than DetailMeta. */
export function DetailStats({ children }: { children: React.ReactNode }) {
	return <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{children}</div>;
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
