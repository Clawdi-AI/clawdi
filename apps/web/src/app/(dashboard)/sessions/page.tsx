"use client";

import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { AlertCircle } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { sessionColumns } from "@/components/sessions/session-columns";
import {
	computeRange,
	type DateRange,
	type DateRangePreset,
	NO_DATE_FILTER,
	SessionAgentFilter,
	SessionDateFilter,
} from "@/components/sessions/session-filters";
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

const ALLOWED_DATE_PRESETS = new Set<DateRangePreset>(["today", "yesterday", "7d", "30d"]);

/**
 * Read URL params into the page's filter/sort/pagination state.
 * Pre-fix everything was useState-only — refresh wiped the user's
 * "I was looking at last 7 days, sorted by tokens, on page 3"
 * context. URL state lets the user share a filtered view link AND
 * keeps the back-button useful.
 */
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

// `useSearchParams` requires a Suspense boundary during static
// prerender (Next.js 13+). The inner component reads URL state;
// the default export wraps it. Without this, `next build` fails
// with "useSearchParams() should be wrapped in a suspense boundary
// at page /sessions".
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

	// Hydrate state from URL on first render. Subsequent updates flow
	// state → URL (via the syncToUrl effect below). We don't watch
	// the URL after mount — back/forward navigation isn't a frequent
	// pattern on this page and adding it would race with our own
	// pushes.
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

	// Sync state → URL on any change. Single replace per render so
	// rapid filter toggles don't blow up the back-stack.
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
		// `replace` not `push` — we don't want every keystroke
		// (debounced or not) clogging the history stack. Filter changes
		// are exploratory, not bookmark-worthy moments.
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

	// Available agents for the filter chips, derived from the user's
	// registered environments. If only one agent is registered, the
	// chip group hides itself (the filter has no value).
	const { data: envs } = useQuery({
		queryKey: ["environments-for-filter"],
		queryFn: async () => unwrap(await api.GET("/api/environments")),
	});
	const availableAgents = useMemo(() => {
		const set = new Set<string>();
		for (const e of envs ?? []) {
			if (e.agent_type) set.add(e.agent_type);
		}
		return Array.from(set).sort();
	}, [envs]);

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
						>
							<SessionDateFilter
								value={dateRange}
								onChange={(r) => {
									setDateRange(r);
									setPagination((p) => ({ ...p, pageIndex: 0 }));
								}}
							/>
							<SessionAgentFilter
								value={agent}
								availableAgents={availableAgents}
								onChange={(a) => {
									setAgent(a);
									setPagination((p) => ({ ...p, pageIndex: 0 }));
								}}
							/>
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
