"use client";

import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { AlertCircle } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { agentTypeLabel } from "@/components/dashboard/agent-label";
import { PageHeader } from "@/components/page-header";
import { sessionColumns } from "@/components/sessions/session-columns";
import {
	computeRange,
	DATE_FILTER_OPTIONS,
	type DateRange,
	type DateRangePreset,
	NO_DATE_FILTER,
} from "@/components/sessions/session-filters";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DataTableFacetedFilter } from "@/components/ui/data-table-faceted-filter";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { DataTableToolbar } from "@/components/ui/data-table-toolbar";
import { unwrap, useApi } from "@/lib/api";
import type { SessionListItem } from "@/lib/api-schemas";
import { useDebouncedValue } from "@/lib/use-debounced";
import { errorMessage, recencyBucketFor } from "@/lib/utils";

const ALLOWED_SORT_KEYS = new Set([
	"last_activity_at",
	"started_at",
	"message_count",
	"tokens",
	"updated_at",
]);

const ALLOWED_DATE_PRESETS = new Set<DateRangePreset>(["today", "yesterday", "7d", "30d"]);

function readStateFromUrl(params: URLSearchParams): {
	search: string;
	sort: string;
	order: "asc" | "desc";
	page: number;
	pageSize: number;
	preset: DateRangePreset | null;
	agent: string | null;
} {
	const sort = params.get("sort") ?? "last_activity_at";
	const validSort = ALLOWED_SORT_KEYS.has(sort) ? sort : "last_activity_at";
	const order = params.get("order") === "asc" ? "asc" : "desc";
	const presetParam = params.get("range") as DateRangePreset | null;
	const preset = presetParam && ALLOWED_DATE_PRESETS.has(presetParam) ? presetParam : null;
	const pageNum = Number.parseInt(params.get("page") ?? "1", 10);
	const sizeNum = Number.parseInt(params.get("pageSize") ?? "25", 10);
	return {
		search: params.get("q") ?? "",
		sort: validSort,
		order,
		page: Number.isFinite(pageNum) && pageNum >= 1 ? pageNum : 1,
		pageSize: Number.isFinite(sizeNum) && sizeNum >= 1 && sizeNum <= 200 ? sizeNum : 25,
		preset,
		agent: params.get("agent"),
	};
}

export default function SessionsPage() {
	return (
		<Suspense
			fallback={
				<div className="space-y-5 px-4 lg:px-6">
					<PageHeader title="Sessions" />
				</div>
			}
		>
			<SessionsListInner />
		</Suspense>
	);
}

function SessionsListInner() {
	const api = useApi();
	const router = useRouter();
	const searchParams = useSearchParams();

	const initial = useMemo(() => readStateFromUrl(searchParams), []);

	const [pagination, setPagination] = useState({
		pageIndex: initial.page - 1,
		pageSize: initial.pageSize,
	});
	const [search, setSearch] = useState(initial.search);
	const debouncedSearch = useDebouncedValue(search, 250);
	const [sorting, setSorting] = useState<SortingState>([
		{ id: initial.sort, desc: initial.order !== "asc" },
	]);
	const [dateRange, setDateRange] = useState<DateRange>(
		initial.preset ? computeRange(initial.preset) : NO_DATE_FILTER,
	);
	const [agent, setAgent] = useState<string | null>(initial.agent);

	const sortKey = sorting[0]?.id;
	const validSortKey = sortKey && ALLOWED_SORT_KEYS.has(sortKey) ? sortKey : "last_activity_at";
	const sortOrder: "asc" | "desc" = sorting[0]?.desc === false ? "asc" : "desc";

	const isFiltered = dateRange.preset !== null || agent !== null || debouncedSearch !== "";

	const syncToUrl = useCallback(() => {
		const params = new URLSearchParams();
		if (debouncedSearch) params.set("q", debouncedSearch);
		if (validSortKey !== "last_activity_at") params.set("sort", validSortKey);
		if (sortOrder !== "desc") params.set("order", sortOrder);
		if (pagination.pageIndex > 0) params.set("page", String(pagination.pageIndex + 1));
		if (pagination.pageSize !== 25) params.set("pageSize", String(pagination.pageSize));
		if (dateRange.preset) params.set("range", dateRange.preset);
		if (agent) params.set("agent", agent);
		const qs = params.toString();
		router.replace(qs ? `/sessions?${qs}` : "/sessions", { scroll: false });
	}, [
		debouncedSearch,
		validSortKey,
		sortOrder,
		pagination.pageIndex,
		pagination.pageSize,
		dateRange.preset,
		agent,
		router,
	]);

	useEffect(() => {
		syncToUrl();
	}, [syncToUrl]);

	const { data, isLoading, error } = useQuery({
		queryKey: [
			"sessions",
			pagination.pageIndex,
			pagination.pageSize,
			debouncedSearch,
			validSortKey,
			sortOrder,
			dateRange.since,
			dateRange.until,
			agent,
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
							since: dateRange.since ?? undefined,
							until: dateRange.until ?? undefined,
							agent: agent ?? undefined,
						},
					},
				}),
			),
	});

	const { data: envs } = useQuery({
		queryKey: ["environments-for-filter"],
		queryFn: async () => unwrap(await api.GET("/api/environments")),
	});
	const agentOptions = useMemo(() => {
		const set = new Set<string>();
		for (const e of envs ?? []) {
			if (e.agent_type) set.add(e.agent_type);
		}
		// Include the active agent filter even if no env matches it
		// (env was deleted but URL still says ?agent=X).
		if (agent) set.add(agent);
		return Array.from(set)
			.sort()
			.map((a) => ({ label: agentTypeLabel(a), value: a }));
	}, [envs, agent]);

	const total = data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / pagination.pageSize));

	const groupable = validSortKey === "last_activity_at" || validSortKey === "started_at";
	const sortField: "last_activity_at" | "started_at" =
		validSortKey === "started_at" ? "started_at" : "last_activity_at";

	const resetFilters = () => {
		setSearch("");
		setDateRange(NO_DATE_FILTER);
		setAgent(null);
		setPagination((p) => ({ ...p, pageIndex: 0 }));
	};

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
						isFiltered
							? "No sessions match your filters."
							: "No sessions yet. Once your agent has a conversation, it'll show up here."
					}
					getRowHref={(s) => `/sessions/${s.id}`}
					rowAriaLabel={(s) => `Open session ${s.local_session_id}`}
					sorting={sorting}
					onSortingChange={(updater) => {
						setSorting(typeof updater === "function" ? updater(sorting) : updater);
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
						>
							<DataTableFacetedFilter
								title="Last activity"
								options={DATE_FILTER_OPTIONS}
								selected={dateRange.preset ? [dateRange.preset] : []}
								onChange={(arr) => {
									const next = arr[0] as DateRangePreset | undefined;
									setDateRange(next ? computeRange(next) : NO_DATE_FILTER);
									setPagination((p) => ({ ...p, pageIndex: 0 }));
								}}
							/>
							{agentOptions.length > 0 ? (
								<DataTableFacetedFilter
									title="Agent"
									options={agentOptions}
									selected={agent ? [agent] : []}
									onChange={(arr) => {
										setAgent(arr[0] ?? null);
										setPagination((p) => ({ ...p, pageIndex: 0 }));
									}}
								/>
							) : null}
							{isFiltered ? (
								<Button variant="ghost" size="sm" className="h-8 px-2" onClick={resetFilters}>
									Reset
								</Button>
							) : null}
						</DataTableToolbar>
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
