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
		<div className={dataTablePaginationClasses.flexFlexColReverseItems}>
			<div className={dataTablePaginationClasses.textSmTextMutedForeground}>
				{total === 0 ? "0 results" : `${first}–${last} of ${total}`}
			</div>

			<div className={dataTablePaginationClasses.flexWFullFlexCol}>
				<div className={dataTablePaginationClasses.flexItemsCenterGap2}>
					<span className={dataTablePaginationClasses.textSmTextMutedForeground}>Rows</span>
					<Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
						<SelectTrigger size="sm" className={dataTablePaginationClasses.w72Px}>
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

				<div className={dataTablePaginationClasses.flexItemsCenterGap1}>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={() => onPageChange(1)}
						disabled={page <= 1}
						aria-label="First page"
						className={dataTablePaginationClasses.hiddenSmInlineFlex}
					>
						<ChevronsLeft className={dataTablePaginationClasses.size4} />
					</Button>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={() => onPageChange(page - 1)}
						disabled={page <= 1}
						aria-label="Previous page"
					>
						<ChevronLeft className={dataTablePaginationClasses.size4} />
					</Button>
					<span className={dataTablePaginationClasses.minW12Px2}>
						{page} / {pageCount}
					</span>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={() => onPageChange(page + 1)}
						disabled={page >= pageCount}
						aria-label="Next page"
					>
						<ChevronRight className={dataTablePaginationClasses.size4} />
					</Button>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={() => onPageChange(pageCount)}
						disabled={page >= pageCount}
						aria-label="Last page"
						className={dataTablePaginationClasses.hiddenSmInlineFlex}
					>
						<ChevronsRight className={dataTablePaginationClasses.size4} />
					</Button>
				</div>
			</div>
		</div>
	);
}
