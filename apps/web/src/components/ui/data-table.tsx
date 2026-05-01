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
import Link from "next/link";
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
import { cn } from "@/lib/utils";

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
	/**
	 * Make every row clickable and navigable. Preferred over `onRowClick`
	 * for *navigation* — the row gets a stretched Next.js `<Link>` overlay
	 * so middle-click opens a new tab, hover triggers prefetch, and
	 * keyboard tab-order works. Use `onRowClick` only for non-nav side
	 * effects (selection, expand-in-place, etc).
	 */
	getRowHref?: (row: TData) => string;
	/** Used as the stretched link's aria-label so screen readers know
	 * what activating the row does. Required when `getRowHref` is set. */
	rowAriaLabel?: (row: TData) => string;
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

	/**
	 * Optional row grouping. When provided, the table inserts a
	 * full-width separator row above each group of consecutive rows
	 * sharing the same `key`. Used by /sessions to surface "Today /
	 * Yesterday / Previous 7 days / …" buckets the way ChatGPT and
	 * Claude.ai surface their conversation lists. Pre-fix users had
	 * to scan 25 individual relative-time strings to find the
	 * recency they cared about.
	 *
	 * The caller is responsible for ensuring `data` is sorted such
	 * that group keys form contiguous runs — this just emits a
	 * separator on transitions.
	 */
	getRowGroup?: (row: TData) => { key: string; label: string };
}

export function DataTable<TData, TValue>({
	columns,
	data,
	isLoading,
	emptyMessage = "No results.",
	getRowHref,
	rowAriaLabel,
	onRowClick,
	sorting,
	onSortingChange,
	pagination,
	onPaginationChange,
	pageCount,
	toolbar,
	footer,
	getRowGroup,
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
							(() => {
								// Emit a separator row when the group key
								// transitions. Only fires when getRowGroup
								// is supplied; ungrouped tables behave
								// exactly as before. Caller is responsible
								// for ensuring sorted data so keys form
								// contiguous runs.
								let prevKey: string | null = null;
								const out: React.ReactNode[] = [];
								for (const row of table.getRowModel().rows) {
									if (getRowGroup) {
										const g = getRowGroup(row.original);
										if (g.key !== prevKey) {
											out.push(
												<TableRow
													key={`group-${g.key}`}
													className="hover:bg-transparent"
													aria-hidden
												>
													<TableCell
														colSpan={columns.length}
														className="bg-muted/20 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
													>
														{g.label}
													</TableCell>
												</TableRow>,
											);
											prevKey = g.key;
										}
									}
									const href = getRowHref?.(row.original);
									const interactive = !!href || !!onRowClick;
									out.push(
										<TableRow
											key={row.id}
											onClick={onRowClick ? () => onRowClick(row.original) : undefined}
											// `group` lets cells do group-hover tricks (e.g. a delete
											// icon that reveals only on row hover).
											// `relative` hosts the stretched <Link> overlay below.
											className={cn("group", interactive && "cursor-pointer", href && "relative")}
										>
											{row.getVisibleCells().map((cell, idx) => (
												<TableCell key={cell.id}>
													{idx === 0 && href ? (
														// Stretched-link pattern: an absolute anchor
														// covers the whole row so middle-click opens a
														// new tab and hover triggers Next.js prefetch.
														// Sits behind cell content; cells are static-
														// positioned so their text doesn't intercept the
														// click. Interactive elements inside cells need
														// `relative z-10` to escape the link's hit area.
														<Link
															href={href}
															aria-label={rowAriaLabel?.(row.original) ?? "Open"}
															className="absolute inset-0"
														/>
													) : null}
													{flexRender(cell.column.columnDef.cell, cell.getContext())}
												</TableCell>
											))}
										</TableRow>,
									);
								}
								return out;
							})()
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
