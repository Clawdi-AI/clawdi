"use client";

import { filterChipClasses } from "@clawdi/shared/ui";

import type { ReactNode } from "react";
import { ENTITY_CARD_BUTTON_FOCUS_CLASS } from "@/components/entity-card";
import { cn } from "@/lib/utils";

export function filterChipClass(active: boolean, className?: string) {
	return cn(
		filterChipClasses.root,
		ENTITY_CARD_BUTTON_FOCUS_CLASS,
		active ? filterChipClasses.active : filterChipClasses.inactive,
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
