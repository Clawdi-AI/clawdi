"use client";

import {
	isSearchQueryReady,
	SEARCH_QUERY_MAX_LENGTH,
	SEARCH_QUERY_MIN_LENGTH,
	searchQueryLength,
} from "@clawdi/shared/consts";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { LayoutList, Link2, Table2 } from "lucide-react";
import { parseAsBoolean, parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { agentTypeLabel } from "@/components/dashboard/agent-label";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { sessionColumns } from "@/components/sessions/session-columns";
import { SessionFeed } from "@/components/sessions/session-feed";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DataTableFacetedFilter } from "@/components/ui/data-table-faceted-filter";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { SearchInput } from "@/components/ui/search-input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useOpenApi } from "@/lib/api";
import type { SessionListItem } from "@/lib/api-schemas";
import { getProjectResourceDefinition } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import { type SessionListQuery, sessionListQueryOptions } from "@/lib/session-queries";
import { sessionDetailLink } from "@/lib/session-search-anchor";
import { parseAsPositiveInt } from "@/lib/url-search-parsers";
import { useDebouncedValue } from "@/lib/use-debounced";
import { cn, formatNumber, recencyBucketFor } from "@/lib/utils";

// `relevance` ranks deterministic phrase matches across metadata and messages.
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

/**
 * Wrap the body in `<Suspense>` because nuqs reads URL state under the hood.
 * Pattern mirrors `connectors/page.tsx`.
 */
export default function SessionsPage() {
	return (
		<Suspense
			fallback={
				<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
					<PageHeader
						title="Sessions"
						description={SESSIONS_RESOURCE.managementDescription}
						actions={<SharedLinksButton />}
					/>
					<SessionFeed sessions={[]} isLoading emptyMessage="" />
				</div>
			}
		>
			<SessionsListInner />
		</Suspense>
	);
}

function SessionsListInner() {
	const $api = useOpenApi();
	const queryClient = useQueryClient();
	const returnTo = useLocation({
		select: (location) => `${location.pathname}${location.searchStr}`,
	});

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

	const searchRequest = useMemo(
		() => ({ query: params.q, sort: params.sort, order: params.order, page: params.page }),
		[params.order, params.page, params.q, params.sort],
	);
	const debouncedSearchRequest = useDebouncedValue(searchRequest, 250);
	const isSearchRequestPending = params.q !== debouncedSearchRequest.query;
	const requestSearchState = isSearchRequestPending ? debouncedSearchRequest : searchRequest;
	const draftSearchQuery = params.q.trim();
	const debouncedSearchQuery = requestSearchState.query.trim();
	const searchQuery = isSearchQueryReady(debouncedSearchQuery) ? debouncedSearchQuery : "";
	const draftSearchLength = searchQueryLength(draftSearchQuery);
	const searchQueryError =
		draftSearchLength > 0 && draftSearchLength < SEARCH_QUERY_MIN_LENGTH
			? `Type at least ${SEARCH_QUERY_MIN_LENGTH} characters`
			: draftSearchLength > SEARCH_QUERY_MAX_LENGTH
				? `Type at most ${SEARCH_QUERY_MAX_LENGTH} characters`
				: null;
	const getSessionLink = useCallback(
		(session: SessionListItem) => sessionDetailLink(session, { returnTo, searchQuery }),
		[returnTo, searchQuery],
	);
	const columns = useMemo(
		() => sessionColumns({ sessionLink: getSessionLink, searchQuery }),
		[getSessionLink, searchQuery],
	);

	// Tanstack-react-table owns sorting state internally; mirror it
	// onto our nuqs-backed sort/order params via the table's
	// onSortingChange.
	const sorting: SortingState = [{ id: params.sort, desc: params.order !== "asc" }];

	const isFiltered =
		params.agent !== "" ||
		draftSearchQuery !== "" ||
		params.has_pr !== null ||
		params.automated !== null;

	const sessionQuery = useMemo<SessionListQuery>(
		() => ({
			page: requestSearchState.page,
			page_size: params.pageSize,
			q: searchQuery || undefined,
			sort: requestSearchState.sort,
			order: requestSearchState.order,
			agent: params.agent || undefined,
			has_pr: params.has_pr,
			automated: params.automated,
		}),
		[
			searchQuery,
			params.agent,
			params.automated,
			params.has_pr,
			params.pageSize,
			requestSearchState.order,
			requestSearchState.page,
			requestSearchState.sort,
		],
	);

	const { data, isLoading, isFetching, isPlaceholderData, error, refetch } = useQuery({
		...sessionListQueryOptions($api, sessionQuery),
		// Keep the previous page visible while search, filters, or pagination
		// move to a new query key.
		placeholderData: keepPreviousData,
	});

	const { data: envs } = $api.useQuery("get", "/v1/agents", {});
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
	const isListUpdating =
		data !== undefined &&
		((isSearchQueryReady(draftSearchQuery) && draftSearchQuery !== searchQuery) ||
			params.order !== requestSearchState.order ||
			params.page !== requestSearchState.page ||
			params.sort !== requestSearchState.sort ||
			isFetching);

	useEffect(() => {
		if (
			!data ||
			isSearchRequestPending ||
			isPlaceholderData ||
			isFetching ||
			requestSearchState.page >= pageCount
		) {
			return;
		}
		void queryClient.prefetchQuery(
			sessionListQueryOptions($api, { ...sessionQuery, page: requestSearchState.page + 1 }),
		);
	}, [
		$api,
		data,
		isFetching,
		isPlaceholderData,
		isSearchRequestPending,
		pageCount,
		queryClient,
		requestSearchState.page,
		sessionQuery,
	]);

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
	const emptyMessage = searchQuery
		? `No sessions found for “${draftSearchQuery}”.`
		: isFiltered
			? "No sessions match your filters."
			: "No sessions yet. Once your agent has a conversation, it'll show up here.";
	const sessionToolbar = (
		<ListToolbar
			search={
				<SearchInput
					value={params.q}
					onChange={(v) => {
						// Switch sort to relevance the moment the user
						// starts typing — mirrors Amp's "type and rank by
						// match quality" UX. Restore the date sort if the
						// box is cleared so the empty-search default goes
						// back to the activity timeline.
						const hasQuery = isSearchQueryReady(v);
						void setParams({
							q: v,
							page: 1,
							sort:
								hasQuery && params.sort === "last_activity_at"
									? "relevance"
									: !hasQuery && params.sort === "relevance"
										? "last_activity_at"
										: params.sort,
						});
					}}
					placeholder="Search sessions and messages…"
					maxLength={SEARCH_QUERY_MAX_LENGTH}
				/>
			}
			filters={
				<>
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
				</>
			}
			actions={
				<>
					{(isFiltered || isListUpdating) && data ? (
						<span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
							{searchQueryError
								? searchQueryError
								: isListUpdating
									? draftSearchQuery || searchQuery
										? "Searching…"
										: "Updating…"
									: `${formatNumber(total)} ${total === 1 ? "result" : "results"}`}
						</span>
					) : null}
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
									sort: params.sort === "relevance" ? "last_activity_at" : params.sort,
								})
							}
						>
							Reset
						</Button>
					) : null}
					<ToggleGroup
						value={[params.view]}
						onValueChange={(v) => {
							const selected = v[0];
							if (selected === "feed" || selected === "table") {
								void setParams({ view: selected });
							}
						}}
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
				</>
			}
		/>
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
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
			<PageHeader
				title="Sessions"
				description={SESSIONS_RESOURCE.managementDescription}
				actions={<SharedLinksButton />}
			/>

			{shouldBlockQueryError(error, data) ? (
				<ApiErrorPanel
					error={error}
					onRetry={() => {
						void refetch();
					}}
					title="Couldn't load sessions"
				/>
			) : (
				<div className="space-y-4">
					{sessionToolbar}
					{params.view === "table" ? (
						<div className="hidden md:block">
							<DataTable
								columns={columns}
								data={data?.items ?? []}
								isLoading={isLoading}
								emptyMessage={emptyMessage}
								getRowLink={getSessionLink}
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
					<div className={cn(params.view === "table" && "md:hidden")}>
						<SessionFeed
							sessions={data?.items ?? []}
							isLoading={isLoading}
							emptyMessage={emptyMessage}
							grouped={groupable}
							groupBy={params.sort === "started_at" ? "started_at" : "last_activity_at"}
							quietAutomated={searchQuery === ""}
							searchQuery={searchQuery}
							sessionLink={getSessionLink}
						/>
					</div>
					{sessionFooter}
				</div>
			)}
		</div>
	);
}

function SharedLinksButton() {
	return (
		<Button
			render={<Link to="/sessions/shared" />}
			nativeButton={false}
			variant="outline"
			size="sm"
		>
			<Link2 />
			Shared links
		</Button>
	);
}
