"use client";

import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	type OnChangeFn,
	type SortingState,
	useReactTable,
	type VisibilityState,
} from "@tanstack/react-table";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

const SKELETON_ROWS = Array.from({ length: 5 }, (_, i) => `row-${i}`);

export interface PaginationState {
	pageIndex: number; // 0-based for tanstack; translated to 1-based for API
	pageSize: number;
}

interface DataTableProps<TData, TValue> {
	columns: ColumnDef<TData, TValue>[];
	data: TData[];
	isLoading?: boolean;
	emptyMessage?: React.ReactNode;
	onRowClick?: (row: TData) => void;

	// Server-mode state. All required together — DataTable no longer keeps
	// its own pagination/sorting state, so the parent (page component) owns
	// it and can reflect it into the React Query key for refetches.
	sorting?: SortingState;
	onSortingChange?: OnChangeFn<SortingState>;
	pagination?: PaginationState;
	onPaginationChange?: OnChangeFn<PaginationState>;
	pageCount?: number;

	toolbar?: React.ReactNode | ((table: ReturnType<typeof useReactTable<TData>>) => React.ReactNode);
	footer?: React.ReactNode;
}

export function DataTable<TData, TValue>({
	columns,
	data,
	isLoading,
	emptyMessage = "No results.",
	onRowClick,
	sorting,
	onSortingChange,
	pagination,
	onPaginationChange,
	pageCount,
	toolbar,
	footer,
}: DataTableProps<TData, TValue>) {
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
	const table = useReactTable({
		data,
		columns,
		getCoreRowModel: getCoreRowModel(),
		manualSorting: true,
		manualPagination: true,
		pageCount: pageCount ?? -1,
		state: {
			...(sorting !== undefined ? { sorting } : {}),
			...(pagination !== undefined ? { pagination } : {}),
			columnVisibility,
		},
		onSortingChange,
		onPaginationChange,
		onColumnVisibilityChange: setColumnVisibility,
	});

	return (
		<div className="space-y-3">
			{typeof toolbar === "function" ? toolbar(table) : toolbar}

			<div className="overflow-hidden rounded-lg border bg-card">
				<Table className="table-fixed">
					<TableHeader className="bg-muted/40">
						{table.getHeaderGroups().map((headerGroup) => (
							<TableRow key={headerGroup.id} className="hover:bg-transparent">
								{headerGroup.headers.map((header) => (
									<TableHead key={header.id} style={{ width: header.getSize() }}>
										{header.isPlaceholder
											? null
											: flexRender(header.column.columnDef.header, header.getContext())}
									</TableHead>
								))}
							</TableRow>
						))}
					</TableHeader>
					<TableBody>
						{isLoading ? (
							SKELETON_ROWS.map((rowId) => (
								<TableRow key={rowId} className="hover:bg-transparent">
									{columns.map((col, j) => (
										<TableCell key={col.id ?? `col-${j}`}>
											<Skeleton className="h-4 w-full" />
										</TableCell>
									))}
								</TableRow>
							))
						) : table.getRowModel().rows.length ? (
							table.getRowModel().rows.map((row) => (
								<TableRow
									key={row.id}
									onClick={onRowClick ? () => onRowClick(row.original) : undefined}
									// `group` lets column cells do group-hover tricks (e.g. a
									// delete icon that reveals only on row hover).
									className={onRowClick ? "group cursor-pointer" : "group"}
								>
									{row.getVisibleCells().map((cell) => (
										<TableCell key={cell.id}>
											{flexRender(cell.column.columnDef.cell, cell.getContext())}
										</TableCell>
									))}
								</TableRow>
							))
						) : (
							<TableRow className="hover:bg-transparent">
								<TableCell
									colSpan={columns.length}
									className="h-24 text-center text-muted-foreground"
								>
									{emptyMessage}
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</div>

			{footer}
		</div>
	);
}
