"use client";

import { AlertCircle, ChevronLeft, ChevronRight, Plug } from "lucide-react";
import { createParser, parseAsString, useQueryState } from "nuqs";
import { Suspense, useEffect, useMemo } from "react";
import {
	CONNECTOR_GRID_CLASS,
	ConnectorCard,
	ConnectorCardSkeleton,
} from "@/components/connectors/connector-card";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAvailableApps, useConnectedAppCards } from "@/lib/connectors-data";
import { useDebouncedValue } from "@/lib/use-debounced";
import { cn, errorMessage } from "@/lib/utils";

// Multiple of 12 (LCM of 1/2/3/4 col grid breakpoints) so the last row is
// always full at every viewport — no orphan cards on the bottom.
const PAGE_SIZE = 24;

// 1-indexed page parser. Rejects non-integer / 0 / negative URL values
// so `?page=-5` or `?page=2junk` doesn't reach the slicer. `Number()`
// (not `parseInt`) is strict — `parseInt("2junk")` would return 2,
// silently accepting garbage. Returning `null` from `parse` makes nuqs
// fall back to the parser's default.
const parseAsPositivePage = createParser({
	parse: (raw: string) => {
		const n = Number(raw);
		return Number.isInteger(n) && n >= 1 ? n : null;
	},
	serialize: (n: number) => String(n),
});

/**
 * Wrap the nuqs-using body in a Suspense boundary because Next.js
 * App Router bails out of static generation when a page calls
 * `useSearchParams` (which nuqs uses under the hood). The bailout
 * surface is `<Suspense>` rather than `dynamic = "force-dynamic"`
 * because Next's docs explicitly recommend it — keeps the static
 * shell renderable, defers only the URL-state-dependent body to
 * client. Fallback mirrors the loading skeleton the body renders
 * once mounted.
 */
export default function ConnectorsPage() {
	return (
		<Suspense fallback={<ConnectorsListSkeleton />}>
			<ConnectorsList />
		</Suspense>
	);
}

function ConnectorsListSkeleton() {
	return (
		<div className="space-y-5 px-4 lg:px-6">
			<div className="flex flex-col gap-2">
				<Skeleton className="h-8 w-32" />
				<Skeleton className="h-4 w-72" />
			</div>
			<Skeleton className="h-10 w-full" />
			<div className={CONNECTOR_GRID_CLASS}>
				{Array.from({ length: 16 }).map((_, i) => (
					<ConnectorCardSkeleton key={i} />
				))}
			</div>
		</div>
	);
}

function ConnectorsList() {
	// Page + search live in the URL via nuqs so a deep-link reproduces
	// the user's filtered view, and the back button restores the prior
	// page after a detail-page round-trip. `clearOnDefault: true` keeps
	// `/connectors` clean when the value matches the default.
	const [query, setQuery] = useQueryState(
		"q",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [page, setPage] = useQueryState(
		"page",
		parseAsPositivePage.withDefault(1).withOptions({ clearOnDefault: true }),
	);
	const debouncedQuery = useDebouncedValue(query, 250);

	// Couple "search changed → page resets to 1" to the user-action site
	// instead of an effect on `[debouncedQuery]`. The effect form fires
	// on initial mount too, which would clobber a deep link like
	// `/connectors?q=gmail&page=3` back to page 1. Doing it inline here
	// only resets when the user types — exactly the case we want.
	const handleQueryChange = (next: string) => {
		void setQuery(next);
		if (page !== 1) void setPage(1);
	};

	// Hosted (clawdi.ai/connections cross-origin) vs OSS (cloud-api
	// `/api/connectors`) is decided inside `connectors-data.ts`. The
	// "Connected" rail and the paginated "All" grid both flow through
	// these unified hooks so the page stays branch-free.
	const connected = useConnectedAppCards();
	const catalogQ = useAvailableApps({
		page,
		pageSize: PAGE_SIZE,
		search: debouncedQuery || undefined,
	});
	const pageData = catalogQ.data;
	const isCatalogLoading = catalogQ.isLoading;
	const isCatalogFetching = catalogQ.isFetching;
	const catalogError = catalogQ.error;

	const connectedNames = useMemo(
		() => new Set(connected.activeConnections.map((c) => c.app_name)),
		[connected.activeConnections],
	);

	const items = pageData?.items ?? [];
	const total = pageData?.total ?? 0;
	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	// `?page=999` past the end shouldn't strand the user on an empty page
	// with no way back. Once the catalog returns and we know the real
	// `totalPages`, replace the URL with the last valid page so the grid
	// renders something AND the pagination control remains visible.
	useEffect(() => {
		if (!pageData) return;
		if (page > totalPages) void setPage(totalPages, { history: "replace" });
	}, [pageData, page, totalPages, setPage]);

	// "Search active" hides the Connected rail so the search results are
	// the only thing on screen — connected apps still match the search
	// (catalog includes them) and surface in the catalog grid via their
	// regular checkmark, so they're not lost. We also surface the rail
	// when `connected.error` is set, even with no known connections —
	// otherwise a connections-fetch failure makes the section silently
	// disappear and the user has no signal anything went wrong.
	const showConnectedRail =
		!debouncedQuery && (connected.activeConnections.length > 0 || !!connected.error);

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Connectors"
				description="Sign in once; your AI can read and act in Gmail, GitHub, Notion, Drive, Calendar."
				actions={
					<>
						{total > 0 ? (
							<Badge variant="secondary">{total.toLocaleString()} available</Badge>
						) : null}
						{connected.activeConnections.length > 0 ? (
							<Badge>{connected.activeConnections.length} active</Badge>
						) : null}
					</>
				}
			/>

			<SearchInput value={query} onChange={handleQueryChange} placeholder="Search connectors…" />

			{showConnectedRail ? (
				<ConnectedRail
					apps={connected.data}
					isLoading={connected.isLoading}
					error={connected.error}
				/>
			) : null}

			<CatalogSection
				items={items}
				total={total}
				page={page}
				totalPages={totalPages}
				connectedNames={connectedNames}
				isLoading={isCatalogLoading}
				isFetching={isCatalogFetching}
				error={catalogError}
				query={query}
				labelled={showConnectedRail}
				onPrev={() => setPage((p) => Math.max(1, p - 1))}
				onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
			/>
		</div>
	);
}

/**
 * Always-visible row showing the user's ACTIVE connections, regardless
 * of catalog page or search. Solves the "I have 2 active but see 0
 * checkmarks" problem when active apps fall outside catalog page 1.
 */
function ConnectedRail({
	apps,
	isLoading,
	error,
}: {
	apps: { name: string; display_name: string; description: string; logo: string }[];
	isLoading: boolean;
	error: Error | null;
}) {
	return (
		<section>
			<h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				Connected
			</h2>
			{error ? (
				// Without this, a connections-fetch failure makes the rail
				// silently disappear and the user only sees "X active" in
				// the header with no way to find their connections.
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Failed to load connections</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : isLoading && apps.length === 0 ? (
				<div className={CONNECTOR_GRID_CLASS}>
					{Array.from({ length: 4 }).map((_, i) => (
						<ConnectorCardSkeleton key={i} />
					))}
				</div>
			) : (
				<div className={CONNECTOR_GRID_CLASS}>
					{apps.map((app) => (
						<ConnectorCard key={app.name} app={app} isConnected />
					))}
				</div>
			)}
		</section>
	);
}

function CatalogSection({
	items,
	total,
	page,
	totalPages,
	connectedNames,
	isLoading,
	isFetching,
	error,
	query,
	labelled,
	onPrev,
	onNext,
}: {
	items: { name: string; display_name: string; description: string; logo: string }[];
	total: number;
	page: number;
	totalPages: number;
	connectedNames: Set<string>;
	isLoading: boolean;
	isFetching: boolean;
	error: Error | null;
	query: string;
	labelled: boolean;
	onPrev: () => void;
	onNext: () => void;
}) {
	if (error) {
		return (
			<Alert variant="destructive">
				<AlertCircle />
				<AlertTitle>Failed to load connectors</AlertTitle>
				<AlertDescription>{errorMessage(error)}</AlertDescription>
			</Alert>
		);
	}
	if (isLoading) {
		return (
			<div className={CONNECTOR_GRID_CLASS}>
				{Array.from({ length: 16 }).map((_, i) => (
					<ConnectorCardSkeleton key={i} />
				))}
			</div>
		);
	}
	if (items.length === 0) {
		return (
			<EmptyState
				icon={Plug}
				title={query ? "No matches" : "No connectors available"}
				description={
					query
						? `Nothing matches "${query}".`
						: "Configure COMPOSIO_API_KEY on the backend to enable connectors."
				}
			/>
		);
	}
	return (
		<section>
			{labelled ? (
				<h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					All
				</h2>
			) : null}
			<div className={cn(CONNECTOR_GRID_CLASS, isFetching && "opacity-60 transition-opacity")}>
				{items.map((app) => (
					<ConnectorCard key={app.name} app={app} isConnected={connectedNames.has(app.name)} />
				))}
			</div>
			{totalPages > 1 ? (
				<div className="flex items-center justify-center gap-2 pt-3">
					<Button
						variant="outline"
						size="icon-sm"
						onClick={onPrev}
						disabled={page <= 1}
						aria-label="Previous page"
					>
						<ChevronLeft className="size-4" />
					</Button>
					<span className="px-3 text-xs tabular-nums text-muted-foreground">
						{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of{" "}
						{total.toLocaleString()}
					</span>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={onNext}
						disabled={page >= totalPages}
						aria-label="Next page"
					>
						<ChevronRight className="size-4" />
					</Button>
				</div>
			) : null}
		</section>
	);
}
