"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { AlertCircle, LayoutList, Table2 } from "lucide-react";
import {
	createParser,
	parseAsBoolean,
	parseAsString,
	parseAsStringLiteral,
	useQueryStates,
} from "nuqs";
import { Suspense, useEffect, useMemo, useState } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { agentTypeLabel } from "@/components/dashboard/agent-label";
import { PageHeader } from "@/components/page-header";
import { sessionColumns } from "@/components/sessions/session-columns";
import { SessionFeed } from "@/components/sessions/session-feed";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DataTableFacetedFilter } from "@/components/ui/data-table-faceted-filter";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { DataTableToolbar } from "@/components/ui/data-table-toolbar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { unwrap, useApi } from "@/lib/api";
import type { SessionListItem } from "@/lib/api-schemas";
import { getProjectResourceDefinition } from "@/lib/project-resource-model";
import { type SessionListQuery, sessionListQueryOptions } from "@/lib/session-queries";
import { useDebouncedValue } from "@/lib/use-debounced";
import { cn, errorMessage, recencyBucketFor } from "@/lib/utils";

// `relevance` (trgm similarity) joins the legacy date/count sorts.
// Relevance is special-cased server-side: it's only meaningful when q
// is non-empty, and the route silently falls back to last_activity_at
// otherwise. We mirror that in the UI by only surfacing the "Relevance"
// sort option when the search box has text.
const SORT_KEYS = [
	"last_activity_at",
	"started_at",
	"message_count",
	"tokens",
	"updated_at",
	"relevance",
] as const;
type SortKey = (typeof SORT_KEYS)[number];
const SESSIONS_RESOURCE = getProjectResourceDefinition("sessions");

// 1-indexed strict integer parser. `Number()` (unlike `parseInt`)
// rejects mixed input like "3junk", so a malformed `?page=3junk`
// falls back to the nuqs default instead of silently landing 3.
const parseAsPositiveInt = createParser({
	parse: (raw: string) => {
		const n = Number(raw);
		return Number.isInteger(n) && n >= 1 ? n : null;
	},
	serialize: (n: number) => String(n),
});

/**
 * Wrap the body in `<Suspense>` because nuqs reads URL state under the hood.
 * Pattern mirrors `connectors/page.tsx`.
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
	const queryClient = useQueryClient();

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
			// `has_pr=true/false` is tri-state via the undefined default
			// (no filter) — nuqs's nullable boolean handles all three.
			has_pr: parseAsBoolean,
			// Same tri-state shape: true = cron/heartbeat only,
			// false = manual work only, null = everything.
			automated: parseAsBoolean,
			// Feed (human cards) is the default; the data table stays one
			// toggle away for power users.
			view: parseAsStringLiteral(["feed", "table"] as const).withDefault("feed"),
		},
		{ clearOnDefault: true, history: "replace" },
	);

	const debouncedSearch = useDebouncedValue(params.q, 250);

	// Tanstack-react-table owns sorting state internally; mirror it
	// onto our nuqs-backed sort/order params via the table's
	// onSortingChange.
	const sorting: SortingState = [{ id: params.sort, desc: params.order !== "asc" }];

	const isFiltered =
		params.agent !== "" ||
		debouncedSearch !== "" ||
		params.has_pr !== null ||
		params.automated !== null;

	const sessionQuery = useMemo<SessionListQuery>(
		() => ({
			page: params.page,
			page_size: params.pageSize,
			q: debouncedSearch || undefined,
			sort: params.sort,
			order: params.order,
			agent: params.agent || undefined,
			has_pr: params.has_pr,
			automated: params.automated,
		}),
		[
			debouncedSearch,
			params.agent,
			params.automated,
			params.has_pr,
			params.order,
			params.page,
			params.pageSize,
			params.sort,
		],
	);

	const { data, isLoading, isFetching, error } = useQuery({
		...sessionListQueryOptions(api, sessionQuery),
		// Keep previous results visible during refetch; the
		// `isFetching && !isLoading` opacity transition below is
		// the only "loading" signal the user sees.
		placeholderData: keepPreviousData,
	});

	const { data: envs } = useQuery({
		queryKey: ["environments-for-filter"],
		queryFn: async () => unwrap(await api.GET("/v1/agents")),
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

	const prFilterOptions = useMemo(
		() => [
			{ label: "Has PR links", value: "true" },
			{ label: "No PR links", value: "false" },
		],
		[],
	);

	// Cron + heartbeat sessions usually outnumber real work many times
	// over; "Manual" is how users find the sessions they actually ran.
	const typeFilterOptions = useMemo(
		() => [
			{ label: "Manual", value: "false" },
			{ label: "Automated (cron, heartbeat)", value: "true" },
		],
		[],
	);

	const total = data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / params.pageSize));

	useEffect(() => {
		if (!data || params.page >= pageCount) return;
		void queryClient.prefetchQuery(
			sessionListQueryOptions(api, { ...sessionQuery, page: params.page + 1 }),
		);
	}, [api, data, pageCount, params.page, queryClient, sessionQuery]);

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
	const emptyMessage = isFiltered
		? "No sessions match your filters."
		: "No sessions yet. Once your agent has a conversation, it'll show up here.";
	const sessionToolbar = (
		<DataTableToolbar
			value={params.q}
			onChange={(v) => {
				// Switch sort to relevance the moment the user
				// starts typing — mirrors Amp's "type and rank by
				// match quality" UX. Restore the date sort if the
				// box is cleared so the empty-search default goes
				// back to the activity timeline.
				void setParams({
					q: v,
					page: 1,
					sort:
						v && params.sort === "last_activity_at"
							? "relevance"
							: !v && params.sort === "relevance"
								? "last_activity_at"
								: params.sort,
				});
			}}
			placeholder="Search summary, folder, or session ID…"
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
			<DataTableFacetedFilter
				title="Type"
				options={typeFilterOptions}
				selected={
					params.automated === true ? ["true"] : params.automated === false ? ["false"] : []
				}
				onChange={(arr) => {
					const v = arr[0];
					void setParams({
						automated: v === "true" ? true : v === "false" ? false : null,
						page: 1,
					});
				}}
			/>
			<DataTableFacetedFilter
				title="PR links"
				options={prFilterOptions}
				selected={params.has_pr === true ? ["true"] : params.has_pr === false ? ["false"] : []}
				onChange={(arr) => {
					const v = arr[0];
					void setParams({
						has_pr: v === "true" ? true : v === "false" ? false : null,
						page: 1,
					});
				}}
			/>
			{isFiltered ? (
				<Button
					variant="ghost"
					size="sm"
					className="h-8 px-2"
					onClick={() =>
						void setParams({
							q: "",
							agent: "",
							has_pr: null,
							automated: null,
							page: 1,
						})
					}
				>
					Reset
				</Button>
			) : null}
		</DataTableToolbar>
	);
	const sessionFooter = (
		<div>
			<DataTablePagination
				page={params.page}
				pageSize={params.pageSize}
				total={total}
				onPageChange={(p) => void setParams({ page: p })}
				onPageSizeChange={(size) => void setParams({ pageSize: size, page: 1 })}
			/>
		</div>
	);

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Sessions"
				description={SESSIONS_RESOURCE.managementDescription}
				actions={
					<ToggleGroup
						type="single"
						value={params.view}
						onValueChange={(v) => v && void setParams({ view: v as "feed" | "table" })}
						variant="outline"
						size="sm"
						className="hidden md:flex"
						aria-label="List style"
					>
						<ToggleGroupItem value="feed" aria-label="Feed view">
							<LayoutList />
						</ToggleGroupItem>
						<ToggleGroupItem value="table" aria-label="Table view">
							<Table2 />
						</ToggleGroupItem>
					</ToggleGroup>
				}
			/>

			{error ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Couldn't load sessions</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : (
				<div
					className={cn(
						"space-y-4 transition-opacity",
						isFetching && !isLoading ? "opacity-60" : "opacity-100",
					)}
				>
					{sessionToolbar}
					{params.view === "table" ? (
						<div className="hidden md:block">
							<DataTable
								columns={sessionColumns}
								data={data?.items ?? []}
								isLoading={isLoading}
								emptyMessage={emptyMessage}
								getRowLink={(s) => ({ to: "/sessions/$id", params: { id: s.id } })}
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
								className="space-y-0"
							/>
						</div>
					) : null}
					<div className={cn("max-w-4xl", params.view === "table" && "md:hidden")}>
						<SessionFeed
							sessions={data?.items ?? []}
							isLoading={isLoading}
							emptyMessage={emptyMessage}
							grouped={groupable}
							groupBy={params.sort === "started_at" ? "started_at" : "last_activity_at"}
							quietAutomated={debouncedSearch === ""}
						/>
					</div>
					{sessionFooter}
				</div>
			)}
		</div>
	);
}
