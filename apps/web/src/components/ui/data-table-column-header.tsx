"use client";

import type { Column } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props<T, V> {
	column: Column<T, V>;
	children: React.ReactNode;
	className?: string;
}

export function DataTableColumnHeader<T, V>({ column, children, className }: Props<T, V>) {
	if (!column.getCanSort()) {
		return <div className={cn("text-sm font-medium", className)}>{children}</div>;
	}

	const sort = column.getIsSorted();

	return (
		<button
			type="button"
			onClick={() => column.toggleSorting(sort === "asc")}
			aria-label={
				sort === "asc" ? "Sort descending" : sort === "desc" ? "Clear sort" : "Sort ascending"
			}
			className={cn(
				"-ml-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium hover:bg-accent hover:text-accent-foreground",
				className,
			)}
		>
			{children}
			{sort === "asc" ? (
				<ArrowUp className="size-3.5" />
			) : sort === "desc" ? (
				<ArrowDown className="size-3.5" />
			) : (
				<ChevronsUpDown className="size-3.5 opacity-50" />
			)}
		</button>
	);
}
