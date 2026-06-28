"use client";

import { cn } from "@/lib/utils";

/**
 * Minimal usage meter built from theme tokens (the repo ships no shadcn
 * Progress primitive, and a one-off bar keeps this isolated under hosted/).
 * Track = `bg-muted`, fill = `bg-primary`, flipping to `bg-warning` once usage
 * crosses `warnAt`. Exposes the ARIA `progressbar` role so screen readers
 * announce used credits against the included total.
 */
export function UsageMeter({
	used,
	total,
	label,
	warnAt = 0.85,
	className,
}: {
	used: number;
	total: number;
	label: string;
	warnAt?: number;
	className?: string;
}) {
	const ratio = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
	const pct = Math.round(ratio * 100);
	const warn = ratio >= warnAt;
	return (
		<div
			data-hosted="true"
			className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={Math.max(0, total)}
			aria-valuenow={Math.max(0, Math.min(used, total))}
		>
			<div
				className={cn(
					"h-full rounded-full transition-[width] duration-500",
					warn ? "bg-warning" : "bg-primary",
				)}
				style={{ width: `${pct}%` }}
			/>
		</div>
	);
}
