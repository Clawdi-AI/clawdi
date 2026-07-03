"use client";

import { cn } from "@/lib/utils";

/* Visible project-scope tab chip (vault + skills pages): a dropdown hides
 * the project dimension; a chip row teaches it. Pair with identityFor()
 * for the emoji. */

export function ProjectTab({
	active,
	onClick,
	label,
	emoji,
	count,
	trailing,
}: {
	active: boolean;
	onClick: () => void;
	label: string;
	emoji?: string;
	/** Object count inside this scope — rendered as a quiet tabular suffix. */
	count?: number;
	trailing?: React.ReactNode;
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={cn(
				"inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus:outline-none",
				active
					? "border-foreground/20 bg-accent font-medium text-foreground"
					: "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
			)}
		>
			{emoji ? (
				<span aria-hidden className="select-none text-xs leading-none">
					{emoji}
				</span>
			) : null}
			{label}
			{count !== undefined ? (
				<span
					className={cn(
						"text-xs tabular-nums",
						active ? "text-muted-foreground" : "text-muted-foreground/70",
					)}
				>
					{count}
				</span>
			) : null}
			{trailing}
		</button>
	);
}
