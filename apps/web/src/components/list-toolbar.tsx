"use client";

import { listToolbarClasses } from "@clawdi/shared/ui";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ListToolbar({
	search,
	filters,
	actions,
	className,
}: {
	search?: ReactNode;
	filters?: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn(listToolbarClasses.root, className)}>
			{search ? <div className={listToolbarClasses.search}>{search}</div> : null}
			{filters ? <div className={listToolbarClasses.filters}>{filters}</div> : null}
			{actions ? <div className={listToolbarClasses.actions}>{actions}</div> : null}
		</div>
	);
}
