"use client";

import { AlertCircle, Check, ChevronLeft, ChevronRight, Plug } from "lucide-react";
import Link from "next/link";
import { createParser, parseAsString, useQueryState } from "nuqs";
import { useEffect, useMemo } from "react";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAvailableApps, useConnections } from "@/lib/connectors-data";
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

const CONNECTOR_CARD_CLASS = "gap-0 rounded-lg border-border/60 py-0 shadow-none";
const CONNECTOR_CARD_CONTENT_CLASS = "flex items-start gap-3 p-3";

function ConnectorCardSkeleton() {
	return (
		<Card className={CONNECTOR_CARD_CLASS}>
			<CardContent className={CONNECTOR_CARD_CONTENT_CLASS}>
				<Skeleton className="size-10 shrink-0 rounded-lg" />
				<div className="min-w-0 flex-1 space-y-1.5">
					<Skeleton className="h-3.5 w-28" />
					<Skeleton className="h-3 w-full" />
					<Skeleton className="h-3 w-3/4" />
				</div>
			</CardContent>
		</Card>
	);
}

export default function ConnectorsPage() {
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

	// Hosted (cross-origin to clawdi.ai/connections, keyed off
	// `clerk_id`) vs OSS (cloud-api `/api/connectors`, keyed off local
	// `user.id`) is decided inside `connectors-data.ts`. Both call paths
	// surface the same shapes to keep this page branch-free.
	const connectionsQ = useConnections();
	const catalogQ = useAvailableApps({
		page,
		pageSize: PAGE_SIZE,
		search: debouncedQuery || undefined,
	});
	const connections = connectionsQ.data;
	const pageData = catalogQ.data;
	const isLoading = catalogQ.isLoading;
	const isFetching = catalogQ.isFetching;
	const error = catalogQ.error;

	const connectedNames = useMemo(
		() => new Set(connections?.map((c) => c.app_name) ?? []),
		[connections],
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
	// Connected-first within the page, preserving Composio's upstream
	// popularity order via stable sort.
	const sorted = useMemo(() => {
		const arr = [...items];
		arr.sort((a, b) => {
			const ac = connectedNames.has(a.name) ? 0 : 1;
			const bc = connectedNames.has(b.name) ? 0 : 1;
			return ac - bc;
		});
		return arr;
	}, [items, connectedNames]);

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Connectors"
				description="Connect apps so your agents can use external tools."
				actions={
					<>
						{total > 0 ? (
							<Badge variant="secondary">{total.toLocaleString()} available</Badge>
						) : null}
						{connections && connections.length > 0 ? (
							<Badge>{connections.length} active</Badge>
						) : null}
					</>
				}
			/>

			<SearchInput value={query} onChange={handleQueryChange} placeholder="Search connectors…" />

			{error ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Failed to load connectors</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : isLoading ? (
				<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
					{Array.from({ length: 16 }).map((_, i) => (
						<ConnectorCardSkeleton key={i} />
					))}
				</div>
			) : sorted.length === 0 ? (
				<EmptyState
					icon={Plug}
					title={query ? "No matches" : "No connectors available"}
					description={
						query
							? `Nothing matches "${query}".`
							: "Configure COMPOSIO_API_KEY on the backend to enable connectors."
					}
				/>
			) : (
				<>
					<div
						className={cn(
							"grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
							isFetching && "opacity-60 transition-opacity",
						)}
					>
						{sorted.map((app) => {
							const isConnected = connectedNames.has(app.name);
							return (
								<Link key={app.name} href={`/connectors/${app.name}`} className="group">
									<Card
										className={cn(
											CONNECTOR_CARD_CLASS,
											"h-full transition-colors hover:border-ring/50 hover:bg-accent/40",
										)}
									>
										<CardContent className={cn(CONNECTOR_CARD_CONTENT_CLASS, "h-full")}>
											<ConnectorIcon logo={app.logo} name={app.display_name} size="md" />
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-1.5">
													<span className="truncate text-sm font-medium leading-5">
														{app.display_name}
													</span>
													{isConnected ? (
														<Check
															className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500"
															aria-label="Connected"
														/>
													) : null}
												</div>
												<p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
													{app.description}
												</p>
											</div>
										</CardContent>
									</Card>
								</Link>
							);
						})}
					</div>

					{totalPages > 1 ? (
						<div className="flex items-center justify-center gap-2 pt-1">
							<Button
								variant="outline"
								size="icon-sm"
								onClick={() => setPage((p) => Math.max(1, p - 1))}
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
								onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
								disabled={page >= totalPages}
								aria-label="Next page"
							>
								<ChevronRight className="size-4" />
							</Button>
						</div>
					) : null}
				</>
			)}
		</div>
	);
}
