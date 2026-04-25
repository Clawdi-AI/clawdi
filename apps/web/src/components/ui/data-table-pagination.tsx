"use client";

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
		<div className="flex flex-col-reverse items-center justify-between gap-3 px-1 sm:flex-row">
			<div className="text-sm text-muted-foreground">
				{total === 0 ? "0 results" : `${first}–${last} of ${total}`}
			</div>

			<div className="flex items-center gap-6">
				<div className="flex items-center gap-2">
					<span className="text-sm text-muted-foreground">Rows</span>
					<Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
						<SelectTrigger size="sm" className="w-[72px]">
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

				<div className="flex items-center gap-1">
					<Button
						variant="outline"
						size="icon-sm"
						onClick={() => onPageChange(1)}
						disabled={page <= 1}
						aria-label="First page"
					>
						<ChevronsLeft className="size-4" />
					</Button>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={() => onPageChange(page - 1)}
						disabled={page <= 1}
						aria-label="Previous page"
					>
						<ChevronLeft className="size-4" />
					</Button>
					<span className="px-2 text-sm tabular-nums">
						{page} / {pageCount}
					</span>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={() => onPageChange(page + 1)}
						disabled={page >= pageCount}
						aria-label="Next page"
					>
						<ChevronRight className="size-4" />
					</Button>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={() => onPageChange(pageCount)}
						disabled={page >= pageCount}
						aria-label="Last page"
					>
						<ChevronsRight className="size-4" />
					</Button>
				</div>
			</div>
		</div>
	);
}
