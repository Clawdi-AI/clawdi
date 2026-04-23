"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import type { ConnectorApp, ConnectorConnection } from "@/lib/api-schemas";

const PAGE_SIZE = 30;

function ConnectorCardSkeleton() {
	return (
		<div className="flex h-20 items-center gap-4 rounded-xl border bg-card px-4">
			<Skeleton className="size-11 rounded-xl" />
			<div className="min-w-0 flex-1 space-y-1.5">
				<Skeleton className="h-3.5 w-28" />
				<Skeleton className="h-3 w-44" />
			</div>
		</div>
	);
}

export default function ConnectorsPage() {
	const { getToken } = useAuth();
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(0);
	const deferredQuery = useDeferredValue(query);

	const { data: connections } = useQuery({
		queryKey: ["connections"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<ConnectorConnection[]>("/api/connectors", token);
		},
	});

	const { data: availableApps, isLoading } = useQuery({
		queryKey: ["available-apps"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<ConnectorApp[]>("/api/connectors/available", token);
		},
	});

	const connectedNames = useMemo(
		() => new Set(connections?.map((c) => c.app_name) ?? []),
		[connections],
	);

	const filtered = useMemo(() => {
		if (!availableApps) return [];
		let items = [...availableApps];
		if (deferredQuery) {
			const q = deferredQuery.toLowerCase();
			items = items.filter(
				(a) =>
					a.name.toLowerCase().includes(q) ||
					a.display_name.toLowerCase().includes(q) ||
					a.description.toLowerCase().includes(q),
			);
		}
		items.sort((a, b) => {
			const ac = connectedNames.has(a.name) ? 1 : 0;
			const bc = connectedNames.has(b.name) ? 1 : 0;
			return bc - ac;
		});
		return items;
	}, [availableApps, deferredQuery, connectedNames]);

	const prevQuery = useDeferredValue(deferredQuery);
	if (prevQuery !== deferredQuery && page !== 0) setPage(0);

	const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
	const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

	return (
		<div className="space-y-5">
			<PageHeader
				title="Connectors"
				description="Connect apps and enable capabilities for your AI agent."
				actions={
					<>
						{availableApps && <Badge variant="secondary">{availableApps.length} available</Badge>}
						{connections && connections.length > 0 && <Badge>{connections.length} active</Badge>}
					</>
				}
			/>

			{/* Search */}
			<div className="relative">
				<Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground z-10" />
				<Input
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search connectors..."
					className="rounded-xl pl-9 pr-9"
				/>
				{query && (
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => setQuery("")}
						className="absolute right-1 top-1/2 -translate-y-1/2"
					>
						<X className="size-4" />
					</Button>
				)}
			</div>

			{/* Grid */}
			{isLoading ? (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{Array.from({ length: 12 }).map((_, i) => (
						<ConnectorCardSkeleton key={i} />
					))}
				</div>
			) : filtered.length === 0 ? (
				<div className="rounded-lg border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
					{query
						? `No connectors matching "${query}"`
						: "No connectors available. Configure COMPOSIO_API_KEY."}
				</div>
			) : (
				<>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{paged.map((app) => {
							const isConnected = connectedNames.has(app.name);
							return (
								<Link
									key={app.name}
									href={`/connectors/${app.name}`}
									className="group flex h-20 items-center gap-4 rounded-xl border bg-card px-4 transition-all hover:border-foreground/15 hover:bg-accent/40"
								>
									<ConnectorIcon logo={app.logo} name={app.display_name} size="md" />

									{/* Text */}
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="truncate text-sm font-semibold">{app.display_name}</span>
										</div>
										<p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
											{app.description}
										</p>
									</div>

									{/* Connected indicator */}
									{isConnected && (
										<Check className="size-4 shrink-0 text-green-600 dark:text-green-400" />
									)}
								</Link>
							);
						})}
					</div>

					{/* Pagination */}
					{totalPages > 1 && (
						<div className="flex items-center justify-between">
							<span className="text-xs text-muted-foreground">
								{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of{" "}
								{filtered.length}
							</span>
							<div className="flex items-center gap-1">
								<Button
									variant="outline"
									size="icon-sm"
									onClick={() => setPage((p) => Math.max(0, p - 1))}
									disabled={page === 0}
									className="text-muted-foreground"
								>
									<ChevronLeft className="size-4" />
								</Button>
								<span className="px-3 text-xs text-muted-foreground">
									{page + 1} / {totalPages}
								</span>
								<Button
									variant="outline"
									size="icon-sm"
									onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
									disabled={page >= totalPages - 1}
									className="text-muted-foreground"
								>
									<ChevronRight className="size-4" />
								</Button>
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
}
