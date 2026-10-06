"use client";

import { dataTablePaginationClasses } from "@clawdi/shared/ui";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

interface Props {
	page: number; // 1-based
	pageSize: number;
	total: number;
	onPageChange: (page: number) => void;
	onPageSizeChange: (size: number) => void;
	pageSizeOptions?: number[];
}

export function DataTablePagination({
	page,
	pageSize,
	total,
	onPageChange,
	onPageSizeChange,
	pageSizeOptions = [10, 25, 50, 100],
}: Props) {
	const pageCount = Math.max(1, Math.ceil(total / pageSize));
	const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
	const last = Math.min(total, page * pageSize);

	return (
		<div className={dataTablePaginationClasses.root}>
			<div className={dataTablePaginationClasses.results}>
				{total === 0 ? "0 results" : `${first}–${last} of ${total}`}
			</div>

			<div className={dataTablePaginationClasses.controls}>
				<div className={dataTablePaginationClasses.pageSize}>
					<span className={dataTablePaginationClasses.results}>Rows</span>
					<Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
						<SelectTrigger size="sm" className={dataTablePaginationClasses.pageSizeTrigger}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{pageSizeOptions.map((n) => (
								<SelectItem key={n} value={String(n)}>
									{n}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className={dataTablePaginationClasses.navigation}>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={() => onPageChange(1)}
						disabled={page <= 1}
						aria-label="First page"
						className={dataTablePaginationClasses.boundaryAction}
					>
						<ChevronsLeft className={dataTablePaginationClasses.actionIcon} />
					</Button>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={() => onPageChange(page - 1)}
						disabled={page <= 1}
						aria-label="Previous page"
					>
						<ChevronLeft className={dataTablePaginationClasses.actionIcon} />
					</Button>
					<span className={dataTablePaginationClasses.pageCount}>
						{page} / {pageCount}
					</span>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={() => onPageChange(page + 1)}
						disabled={page >= pageCount}
						aria-label="Next page"
					>
						<ChevronRight className={dataTablePaginationClasses.actionIcon} />
					</Button>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={() => onPageChange(pageCount)}
						disabled={page >= pageCount}
						aria-label="Last page"
						className={dataTablePaginationClasses.boundaryAction}
					>
						<ChevronsRight className={dataTablePaginationClasses.actionIcon} />
					</Button>
				</div>
			</div>
		</div>
	);
}
