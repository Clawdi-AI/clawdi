"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { AlertCircle, MessageSquare } from "lucide-react";
import Link from "next/link";
import {
	createParser,
	parseAsBoolean,
	parseAsString,
	parseAsStringLiteral,
	useQueryStates,
} from "nuqs";
import { Suspense, useMemo, useState } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { AgentLabel, agentTypeLabel } from "@/components/dashboard/agent-label";
import {
	DashboardSection,
	DashboardSectionHeader,
	DashboardSectionToolbar,
} from "@/components/dashboard/section";
import { PageHeader } from "@/components/page-header";
import { sessionColumns } from "@/components/sessions/session-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DataTableFacetedFilter } from "@/components/ui/data-table-faceted-filter";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { DataTableToolbar } from "@/components/ui/data-table-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import type { SessionListItem } from "@/lib/api-schemas";
import { getProjectResourceDefinition, sessionDetailHref } from "@/lib/project-resource-model";
import { useDebouncedValue } from "@/lib/use-debounced";
import {
	cn,
	errorMessage,
	formatSessionSummary,
	recencyBucketFor,
	relativeTime,
} from "@/lib/utils";

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
			// `has_pr=true/false` is tri-state via the undefined default
			// (no filter) — nuqs's nullable boolean handles all three.
			has_pr: parseAsBoolean,
		},
		{ clearOnDefault: true, history: "replace" },
	);

	const debouncedSearch = useDebouncedValue(params.q, 250);

	// Tanstack-react-table owns sorting state internally; mirror it
	// onto our nuqs-backed sort/order params via the table's
	// onSortingChange.
	const sorting: SortingState = [{ id: params.sort, desc: params.order !== "asc" }];

	const isFiltered = params.agent !== "" || debouncedSearch !== "" || params.has_pr !== null;

	const { data, isLoading, isFetching, error } = useQuery({
		queryKey: [
			"sessions",
			params.page,
			params.pageSize,
			debouncedSearch,
			params.sort,
			params.order,
			params.agent,
			params.has_pr,
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
							has_pr: params.has_pr ?? undefined,
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

	const prFilterOptions = useMemo(
		() => [
			{ label: "Has PR Links", value: "true" },
			{ label: "No PR Links", value: "false" },
		],
		[],
	);

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
	const emptyMessage = isFiltered
		? "No sessions match your filters."
		: "No sessions yet. Once your agent has a conversation, it'll show up here.";
	const sessionToolbar = (
		<DashboardSectionToolbar>
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
					title="PR Links"
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
								page: 1,
							})
						}
					>
						Reset
					</Button>
				) : null}
			</DataTableToolbar>
		</DashboardSectionToolbar>
	);
	const sessionFooter = (
		<div className="border-t px-4 py-3">
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
			<PageHeader title="Sessions" description={SESSIONS_RESOURCE.managementDescription} />

			{error ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Failed to Load Sessions</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : (
				<DashboardSection>
					<DashboardSectionHeader
						icon={MessageSquare}
						title="Session History"
						count={data ? `${total} session${total === 1 ? "" : "s"}` : undefined}
						description="Agent conversations and activity. Use filters when you need a specific agent, PR, or summary."
					/>
					<div
						className={cn(
							"transition-opacity",
							isFetching && !isLoading ? "opacity-60" : "opacity-100",
						)}
					>
						<div className="md:hidden">
							{sessionToolbar}
							<MobileSessionList
								sessions={data?.items ?? []}
								isLoading={isLoading}
								emptyMessage={emptyMessage}
							/>
							{sessionFooter}
						</div>
						<div className="hidden md:block">
							<DataTable
								columns={sessionColumns}
								data={data?.items ?? []}
								isLoading={isLoading}
								emptyMessage={emptyMessage}
								getRowHref={(s) => sessionDetailHref(s.id)}
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
								toolbar={sessionToolbar}
								footer={sessionFooter}
								className="space-y-0"
								tableContainerClassName="rounded-none border-x-0 border-b-0 bg-transparent"
							/>
						</div>
					</div>
				</DashboardSection>
			)}
		</div>
	);
}

function MobileSessionList({
	sessions,
	isLoading,
	emptyMessage,
}: {
	sessions: SessionListItem[];
	isLoading: boolean;
	emptyMessage: string;
}) {
	if (isLoading) {
		return (
			<div className="divide-y">
				{Array.from({ length: 3 }).map((_, index) => (
					<div key={index} className="px-4 py-3">
						<Skeleton className="h-4 w-4/5" />
						<Skeleton className="mt-2 h-3 w-1/2" />
						<Skeleton className="mt-3 h-3 w-2/3" />
					</div>
				))}
			</div>
		);
	}

	if (sessions.length === 0) {
		return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>;
	}

	return (
		<div className="divide-y">
			{sessions.map((session) => {
				const title = formatSessionSummary(session.summary) || session.local_session_id.slice(0, 8);
				const projectFolder = session.project_path?.split("/").pop();
				const totalTokens = session.input_tokens + session.output_tokens;
				return (
					<article key={session.id} className="px-4 py-3">
						<Link href={sessionDetailHref(session.id)} className="block min-w-0">
							<div className="min-w-0">
								<h3 className="truncate text-sm font-medium">{title}</h3>
								{projectFolder ? (
									<p className="mt-0.5 truncate text-xs text-muted-foreground">{projectFolder}</p>
								) : null}
							</div>
							<div className="mt-3 flex items-center justify-between gap-3">
								<AgentLabel
									machineName={session.machine_name}
									type={session.agent_type}
									size="sm"
								/>
								<span className="shrink-0 text-xs text-muted-foreground">
									{relativeTime(session.last_activity_at)}
								</span>
							</div>
							<div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
								<span>{session.message_count} messages</span>
								<span>{(totalTokens / 1000).toFixed(1)}k tokens</span>
								<span>Started {relativeTime(session.started_at)}</span>
							</div>
						</Link>
					</article>
				);
			})}
		</div>
	);
}
