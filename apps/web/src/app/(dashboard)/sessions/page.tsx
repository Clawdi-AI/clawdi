"use client";

import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
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
import type { SessionListItem } from "@/lib/api-schemas";
import { useDebouncedValue } from "@/lib/use-debounced";
import { errorMessage, recencyBucketFor } from "@/lib/utils";

// Backend's allowed sort keys (kept narrow to defend against typos
// when the page sends a key the server's `_SESSION_SORT_COLUMNS`
// allow-list doesn't recognize).
const ALLOWED_SORT_KEYS = new Set([
	"last_activity_at",
	"started_at",
	"message_count",
	"tokens",
	"updated_at",
]);

export default function SessionsPage() {
	const api = useApi();
	const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
	const [search, setSearch] = useState("");
	const debouncedSearch = useDebouncedValue(search, 250);
	// Default sort matches backend default — newest activity first.
	// Tanstack stores SortingState as `[{id, desc}]` for the
	// single-column server-mode case we want.
	const [sorting, setSorting] = useState<SortingState>([{ id: "last_activity_at", desc: true }]);

	const sortKey = sorting[0]?.id;
	const validSortKey = sortKey && ALLOWED_SORT_KEYS.has(sortKey) ? sortKey : "last_activity_at";
	const sortOrder: "asc" | "desc" = sorting[0]?.desc === false ? "asc" : "desc";

	const { data, isLoading, error } = useQuery({
		queryKey: [
			"sessions",
			pagination.pageIndex,
			pagination.pageSize,
			debouncedSearch,
			validSortKey,
			sortOrder,
		],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/sessions", {
					params: {
						query: {
							page: pagination.pageIndex + 1,
							page_size: pagination.pageSize,
							q: debouncedSearch || undefined,
							sort: validSortKey,
							order: sortOrder,
						},
					},
				}),
			),
	});

	const total = data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / pagination.pageSize));

	// Bucket headers (Today / Yesterday / Previous 7 days / monthly /
	// yearly) only make sense when the user is viewing the natural
	// "by recency" sort. Other sorts (by message count, tokens) would
	// emit nonsensical buckets, so we suppress grouping for them.
	const groupable = validSortKey === "last_activity_at" || validSortKey === "started_at";
	const sortField: "last_activity_at" | "started_at" =
		validSortKey === "started_at" ? "started_at" : "last_activity_at";

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
					sorting={sorting}
					onSortingChange={(updater) => {
						setSorting(typeof updater === "function" ? updater(sorting) : updater);
						// Sort change resets to page 1 — paginating into a
						// stale offset of a different ordering is a classic
						// "row skipped/duplicated" bug.
						setPagination((p) => ({ ...p, pageIndex: 0 }));
					}}
					pagination={pagination}
					onPaginationChange={setPagination}
					pageCount={pageCount}
					getRowGroup={
						groupable
							? (s: SessionListItem) =>
									recencyBucketFor(sortField === "started_at" ? s.started_at : s.last_activity_at)
							: undefined
					}
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
