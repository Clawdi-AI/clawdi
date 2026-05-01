"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { sessionColumns } from "@/components/sessions/session-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { DataTableToolbar } from "@/components/ui/data-table-toolbar";
import { unwrap, useApi } from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced";
import { errorMessage } from "@/lib/utils";

export default function SessionsPage() {
	const api = useApi();
	const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
	const [search, setSearch] = useState("");
	const debouncedSearch = useDebouncedValue(search, 250);

	const { data, isLoading, error } = useQuery({
		queryKey: ["sessions", pagination.pageIndex, pagination.pageSize, debouncedSearch],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/sessions", {
					params: {
						query: {
							page: pagination.pageIndex + 1,
							page_size: pagination.pageSize,
							q: debouncedSearch || undefined,
						},
					},
				}),
			),
	});

	const total = data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / pagination.pageSize));

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Sessions"
				actions={
					data ? (
						<Badge variant="secondary">
							{total} session{total === 1 ? "" : "s"}
						</Badge>
					) : null
				}
			/>

			{error ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Failed to load sessions</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : (
				<DataTable
					columns={sessionColumns}
					data={data?.items ?? []}
					isLoading={isLoading}
					emptyMessage={
						debouncedSearch
							? "No sessions match your search."
							: "No sessions yet. Once your agent has a conversation, it'll show up here."
					}
					getRowHref={(s) => `/sessions/${s.id}`}
					rowAriaLabel={(s) => `Open session ${s.local_session_id}`}
					pagination={pagination}
					onPaginationChange={setPagination}
					pageCount={pageCount}
					toolbar={
						<DataTableToolbar
							value={search}
							onChange={(v) => {
								setSearch(v);
								setPagination((p) => ({ ...p, pageIndex: 0 }));
							}}
							placeholder="Search summary, project, ID…"
						/>
					}
					footer={
						<DataTablePagination
							page={pagination.pageIndex + 1}
							pageSize={pagination.pageSize}
							total={total}
							onPageChange={(p) => setPagination((s) => ({ ...s, pageIndex: p - 1 }))}
							onPageSizeChange={(size) => setPagination(() => ({ pageIndex: 0, pageSize: size }))}
						/>
					}
				/>
			)}
		</div>
	);
}
