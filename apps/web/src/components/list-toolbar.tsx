"use client";

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
		<div className={cn("flex flex-wrap items-center gap-2", className)}>
			{search ? (
				<div className="min-w-0 flex-1 basis-full sm:max-w-sm sm:basis-64">{search}</div>
			) : null}
			{filters ? (
				<div className="flex min-w-0 flex-wrap items-center gap-1.5">{filters}</div>
			) : null}
			{actions ? (
				<div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
			) : null}
		</div>
	);
}
