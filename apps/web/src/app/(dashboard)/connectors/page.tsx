"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertCircle, Check, ChevronLeft, ChevronRight, Plug } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced";
import { cn, errorMessage } from "@/lib/utils";

// Multiple of 12 (LCM of 1/2/3/4 col grid breakpoints) so the last row is
// always full at every viewport — no orphan cards on the bottom.
const PAGE_SIZE = 24;

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
	const api = useApi();
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(1);
	const debouncedQuery = useDebouncedValue(query, 250);

	const { data: connections } = useQuery({
		queryKey: ["connections"],
		queryFn: async () => unwrap(await api.GET("/api/connectors")),
	});

	// Server pagination: send page + search to the backend so we only
	// ship one page (24 cards) over the wire instead of all 1000+.
	// `keepPreviousData` prevents the grid from flashing to skeleton on
	// every page-flip — old cards stay visible until the new ones load.
	const {
		data: pageData,
		isLoading,
		isFetching,
		error,
	} = useQuery({
		queryKey: ["available-apps", { page, search: debouncedQuery }],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/connectors/available", {
					params: {
						query: {
							page,
							page_size: PAGE_SIZE,
							...(debouncedQuery ? { search: debouncedQuery } : {}),
						},
					},
				}),
			),
		placeholderData: keepPreviousData,
	});

	const connectedNames = useMemo(
		() => new Set(connections?.map((c) => c.app_name) ?? []),
		[connections],
	);

	// Reset to page 1 when the search term changes — staying on page 5
	// of "github" while typing a different query would show empty results
	// because the new query has fewer total pages.
	useEffect(() => {
		setPage(1);
	}, [debouncedQuery]);

	const items = pageData?.items ?? [];
	const total = pageData?.total ?? 0;
	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
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

			<SearchInput value={query} onChange={setQuery} placeholder="Search connectors…" />

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
