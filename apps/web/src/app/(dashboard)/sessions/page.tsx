"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { AlertCircle } from "lucide-react";
import { createParser, parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs";
import { Suspense, useMemo, useState } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { agentTypeLabel } from "@/components/dashboard/agent-label";
import { PageHeader } from "@/components/page-header";
import { sessionColumns } from "@/components/sessions/session-columns";
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
import { cn, errorMessage, recencyBucketFor } from "@/lib/utils";

const SORT_KEYS = [
	"last_activity_at",
	"started_at",
	"message_count",
	"tokens",
	"updated_at",
] as const;
type SortKey = (typeof SORT_KEYS)[number];

// 1-indexed, strict integer parser. Returning null falls back to the
// nuqs default (1). Pre-fix `Number.parseInt("3junk")` would silently
// land 3 — `Number()` rejects mixed input.
const parseAsPositiveInt = createParser({
	parse: (raw: string) => {
		const n = Number(raw);
		return Number.isInteger(n) && n >= 1 ? n : null;
	},
	serialize: (n: number) => String(n),
});

/**
 * Wrap the body in `<Suspense>` because nuqs's `useQueryStates`
 * reads `useSearchParams` under the hood, and Next.js App Router
 * bails out of static generation when a page calls that. Pattern
 * mirrors `connectors/page.tsx`.
 */
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

	// All filter / sort / pagination state lives in the URL via
	// nuqs. `clearOnDefault: true` keeps `/sessions` clean when
	// values match the defaults — only meaningful state appears
	// in the querystring, so URLs stay short for the common path.
	const [params, setParams] = useQueryStates(
		{
			q: parseAsString.withDefault(""),
			sort: parseAsStringLiteral(SORT_KEYS).withDefault("last_activity_at"),
			order: parseAsStringLiteral(["asc", "desc"] as const).withDefault("desc"),
			page: parseAsPositiveInt.withDefault(1),
			pageSize: parseAsPositiveInt.withDefault(25),
			agent: parseAsString.withDefault(""),
		},
		{ clearOnDefault: true, history: "replace" },
	);

	const debouncedSearch = useDebouncedValue(params.q, 250);

	// Tanstack-react-table owns sorting state internally; mirror it
	// onto our nuqs-backed sort/order params via the table's
	// onSortingChange.
	const sorting: SortingState = [{ id: params.sort, desc: params.order !== "asc" }];

	const isFiltered = params.agent !== "" || debouncedSearch !== "";

	const { data, isLoading, isFetching, error } = useQuery({
		queryKey: [
			"sessions",
			params.page,
			params.pageSize,
			debouncedSearch,
			params.sort,
			params.order,
			params.agent,
		],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/sessions", {
					params: {
						query: {
							page: params.page,
							page_size: params.pageSize,
							q: debouncedSearch || undefined,
							sort: params.sort,
							order: params.order,
							agent: params.agent || undefined,
						},
					},
				}),
			),
		// Keep previous results visible during refetch; the
		// `isFetching && !isLoading` opacity transition below is
		// the only "loading" signal the user sees.
		placeholderData: keepPreviousData,
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
		// Active filter included even when no env matches — env
		// could've been deleted but the URL still says ?agent=X.
		if (params.agent) set.add(params.agent);
		return Array.from(set)
			.sort()
			.map((a) => ({
				label: agentTypeLabel(a),
				value: a,
				icon: ({ className }: { className?: string }) => (
					<AgentIcon agent={a} size="xs" className={className} />
				),
			}));
	}, [envs, params.agent]);

	const total = data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / params.pageSize));

	const groupable = params.sort === "last_activity_at" || params.sort === "started_at";

	// Tanstack table's pagination state is 0-indexed; nuqs is
	// 1-indexed. Convert at the boundary.
	const [paginationState, setPaginationState] = useState({
		pageIndex: params.page - 1,
		pageSize: params.pageSize,
	});
	if (
		paginationState.pageIndex !== params.page - 1 ||
		paginationState.pageSize !== params.pageSize
	) {
		setPaginationState({ pageIndex: params.page - 1, pageSize: params.pageSize });
	}

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
				<div
					className={cn(
						"transition-opacity",
						isFetching && !isLoading ? "opacity-60" : "opacity-100",
					)}
				>
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
							const next = typeof updater === "function" ? updater(sorting) : updater;
							const first = next[0];
							void setParams({
								sort: (first?.id as SortKey) ?? "last_activity_at",
								order: first?.desc === false ? "asc" : "desc",
								page: 1,
							});
						}}
						pagination={paginationState}
						onPaginationChange={(updater) => {
							const next = typeof updater === "function" ? updater(paginationState) : updater;
							void setParams({
								page: next.pageIndex + 1,
								pageSize: next.pageSize,
							});
						}}
						pageCount={pageCount}
						getRowGroup={
							groupable
								? (s: SessionListItem) =>
										recencyBucketFor(
											params.sort === "started_at" ? s.started_at : s.last_activity_at,
										)
								: undefined
						}
						toolbar={
							<DataTableToolbar
								value={params.q}
								onChange={(v) => {
									void setParams({ q: v, page: 1 });
								}}
								placeholder="Search summary, project, ID…"
							>
								{agentOptions.length > 0 ? (
									<DataTableFacetedFilter
										title="Agent"
										options={agentOptions}
										selected={params.agent ? [params.agent] : []}
										onChange={(arr) => {
											void setParams({ agent: arr[0] ?? "", page: 1 });
										}}
									/>
								) : null}
								{isFiltered ? (
									<Button
										variant="ghost"
										size="sm"
										className="h-8 px-2"
										onClick={() => void setParams({ q: "", agent: "", page: 1 })}
									>
										Reset
									</Button>
								) : null}
							</DataTableToolbar>
						}
						footer={
							<DataTablePagination
								page={params.page}
								pageSize={params.pageSize}
								total={total}
								onPageChange={(p) => void setParams({ page: p })}
								onPageSizeChange={(size) => void setParams({ pageSize: size, page: 1 })}
							/>
						}
					/>
				</div>
			)}
		</div>
	);
}
