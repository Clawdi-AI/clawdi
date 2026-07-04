"use client";

import type { ReactNode } from "react";
import { ENTITY_CARD_BUTTON_FOCUS_CLASS } from "@/components/entity-card";
import { cn } from "@/lib/utils";

export function filterChipClass(active: boolean, className?: string) {
	return cn(
		"inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
		ENTITY_CARD_BUTTON_FOCUS_CLASS,
		active
			? "border-primary bg-primary/10 text-primary"
			: "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
		className,
	);
}

export function FilterChip({
	active,
	onClick,
	children,
	className,
}: {
	active: boolean;
	onClick: () => void;
	children: ReactNode;
	className?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={filterChipClass(active, className)}
		>
			{children}
		</button>
	);
}
