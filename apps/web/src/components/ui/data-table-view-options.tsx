"use client";

import type { Table } from "@tanstack/react-table";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Column-visibility picker — matches dashboard-01's "Customize Columns"
 * dropdown. Lets the user hide noisy columns on tight viewports. Only
 * toggles columns with `accessorFn`/`accessorKey` that declare
 * `enableHiding !== false`.
 */
export function DataTableViewOptions<TData>({ table }: { table: Table<TData> }) {
	const hideable = table
		.getAllColumns()
		.filter((col) => typeof col.accessorFn !== "undefined" && col.getCanHide());

	if (hideable.length === 0) return null;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="sm" className="ml-auto">
					<SlidersHorizontal />
					<span className="hidden lg:inline">Columns</span>
					<ChevronDown />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-48">
				<DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{hideable.map((col) => (
					<DropdownMenuCheckboxItem
						key={col.id}
						className="capitalize"
						checked={col.getIsVisible()}
						onCheckedChange={(v) => col.toggleVisibility(!!v)}
					>
						{col.id.replace(/_/g, " ")}
					</DropdownMenuCheckboxItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
