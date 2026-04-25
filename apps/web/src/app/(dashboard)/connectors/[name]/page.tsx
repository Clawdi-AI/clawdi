"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Link2Off, Lock, Plug, PlugZap, Shield } from "lucide-react";
import { useParams } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi } from "@/lib/api";
import type { ConnectorTool } from "@/lib/api-schemas";
import { cn, errorMessage } from "@/lib/utils";

/** Strip leading underscores/dashes and title-case for fallback display. */
function formatName(raw: string): string {
	return raw
		.replace(/^[_-]+/, "")
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function ConnectorDetailPage() {
	const { name } = useParams<{ name: string }>();
	const api = useApi();
	const queryClient = useQueryClient();

	const { data: apps, isLoading: isAppsLoading } = useQuery({
		queryKey: ["available-apps"],
		queryFn: async () => unwrap(await api.GET("/api/connectors/available")),
	});

	const { data: connections, isLoading: isConnectionsLoading } = useQuery({
		queryKey: ["connections"],
		queryFn: async () => unwrap(await api.GET("/api/connectors")),
	});

	const { data: tools, isLoading: isToolsLoading } = useQuery({
		queryKey: ["connector-tools", name],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/connectors/{app_name}/tools", {
					params: { path: { app_name: name } },
				}),
			),
	});

	// Track OAuth polling timers + a cancelled flag. The flag covers a race
	// where the mutation's `onSuccess` fires after this page has already
	// unmounted — without it, the first `setTimeout` would register *after*
	// the cleanup ran and the poll chain would escape, continuing to
	// invalidate queries for a component no one is watching.
	const pollTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
	const pollCancelled = useRef(false);
	useEffect(() => {
		pollCancelled.current = false;
		return () => {
			pollCancelled.current = true;
			for (const t of pollTimers.current) clearTimeout(t);
			pollTimers.current = [];
		};
	}, []);

	const connectApp = useMutation({
		mutationFn: async () => {
			const result = unwrap(
				await api.POST("/api/connectors/{app_name}/connect", {
					params: { path: { app_name: name } },
					body: {},
				}),
			);
			window.open(result.connect_url, "_blank", "noopener,noreferrer");
		},
		onSuccess: () => {
			// Poll for connection status — user may take time to complete OAuth.
			if (pollCancelled.current) return;
			let attempts = 0;
			const poll = () => {
				if (pollCancelled.current || attempts++ >= 12) return;
				const id = setTimeout(() => {
					if (pollCancelled.current) return;
					queryClient.invalidateQueries({ queryKey: ["connections"] });
					poll();
				}, 5000);
				pollTimers.current.push(id);
			};
			poll();
		},
		onError: (e) => toast.error("Failed to start connection", { description: errorMessage(e) }),
	});

	const disconnectApp = useMutation({
		mutationFn: async (connectionId: string) =>
			unwrap(
				await api.DELETE("/api/connectors/{connection_id}", {
					params: { path: { connection_id: connectionId } },
				}),
			),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
		onError: (e) => toast.error("Failed to disconnect", { description: errorMessage(e) }),
	});

	const app = apps?.find((a) => a.name === name);
	const activeConnections = connections?.filter((c) => c.app_name === name) ?? [];
	const isConnected = activeConnections.length > 0;
	const isLoading = isAppsLoading || isConnectionsLoading;

	const displayName = app?.display_name || formatName(name);

	if (isLoading) {
		return (
			<div className="flex flex-col gap-4 px-4 lg:px-6">
				<DetailSkeleton />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 px-4 lg:px-6">
			{/* Header — matches clawdi ConnectorHeader */}
			<div className="flex items-start gap-5">
				<ConnectorIcon logo={app?.logo} name={displayName} size="lg" />
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h1 className="text-lg font-semibold tracking-tight">{displayName}</h1>
						{isConnected && (
							<Badge variant="secondary">
								<Check />
								Connected
							</Badge>
						)}
					</div>
					<p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
						{app?.description || name}
					</p>
				</div>
			</div>

			{/* Connection Management — matches clawdi ConnectionManagement */}
			<section>
				<div className="mb-3 flex items-center justify-between gap-3">
					<div>
						<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
							Connected Accounts
						</h2>
						<p className="mt-1 text-xs text-muted-foreground">
							{activeConnections.length} connected
						</p>
					</div>
					{activeConnections.length > 0 && (
						<Button
							variant="outline"
							size="xs"
							onClick={() => connectApp.mutate()}
							disabled={connectApp.isPending}
						>
							{connectApp.isPending ? (
								<Spinner className="size-3.5" />
							) : (
								<Plug className="size-3.5" />
							)}
							Connect
						</Button>
					)}
				</div>

				{activeConnections.length === 0 ? (
					<EmptyState
						fillHeight={false}
						bordered
						description="No connected accounts yet."
						action={
							<Button onClick={() => connectApp.mutate()} disabled={connectApp.isPending}>
								{connectApp.isPending ? (
									<Spinner className="size-3.5" />
								) : (
									<Plug className="size-3.5" />
								)}
								{connectApp.isPending ? "Connecting..." : "Connect"}
							</Button>
						}
					/>
				) : (
					<div className="flex flex-col gap-2">
						{activeConnections.map((c) => (
							<div
								key={c.id}
								className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3"
							>
								<div className="min-w-0">
									<p className="truncate text-sm font-medium">{c.app_name}</p>
									<p className="mt-0.5 text-xs text-muted-foreground">
										{c.status.replace(/_/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase())}
									</p>
								</div>
								<Button
									variant="ghost"
									size="xs"
									onClick={() => disconnectApp.mutate(c.id)}
									disabled={disconnectApp.isPending}
									className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
								>
									{disconnectApp.isPending ? (
										<Spinner className="size-3.5" />
									) : (
										<Link2Off className="size-3.5" />
									)}
									Disconnect
								</Button>
							</div>
						))}
					</div>
				)}
			</section>

			{/* Info Sections — matches clawdi ConnectorInfoSections */}
			<div className="flex flex-col gap-4">
				{/* Setup Steps */}
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<PlugZap className="size-4" />
							Setup Steps
						</CardTitle>
					</CardHeader>
					<CardContent>
						<ol className="flex flex-col gap-2">
							{[
								"Click Connect to authorize access",
								"Complete authentication in the popup window",
								"Return here to verify connection",
							].map((step, i) => (
								<li key={step} className="flex items-center gap-3">
									<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
										{i + 1}
									</span>
									<span className="text-sm">{step}</span>
								</li>
							))}
						</ol>
					</CardContent>
				</Card>

				{/* Permissions */}
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Shield className="size-4" />
							Permissions
						</CardTitle>
					</CardHeader>
					<CardContent>
						<ul className="flex flex-col gap-2">
							{["Read data from your account", "Perform actions on your behalf"].map((perm) => (
								<li key={perm} className="flex items-center gap-2 text-sm">
									<Lock className="size-3 text-muted-foreground" />
									{perm}
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			</div>

			{/* Tools — matches clawdi ConnectorToolsList */}
			<ConnectorToolsList tools={tools ?? []} isLoading={isToolsLoading} />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DetailSkeleton() {
	return (
		<div className="flex flex-col gap-4">
			{/* Header */}
			<div className="flex items-start gap-5">
				<Skeleton className="size-14 rounded-2xl" />
				<div className="flex-1 space-y-2">
					<Skeleton className="h-5 w-36" />
					<Skeleton className="h-4 w-64" />
				</div>
			</div>
			{/* Connection section */}
			<div className="space-y-3">
				<Skeleton className="h-3.5 w-32" />
				<Skeleton className="h-3 w-20" />
				<div className="rounded-lg border border-dashed p-6">
					<Skeleton className="mx-auto h-9 w-28 rounded-lg" />
				</div>
			</div>
			{/* Info sections */}
			<Card>
				<CardContent className="space-y-3">
					<Skeleton className="h-3.5 w-24" />
					<div className="space-y-2">
						<Skeleton className="h-4 w-56" />
						<Skeleton className="h-4 w-64" />
						<Skeleton className="h-4 w-48" />
					</div>
				</CardContent>
			</Card>
			{/* Tools */}
			<div className="space-y-3">
				<Skeleton className="h-3.5 w-32" />
				<div className="rounded-lg border">
					{Array.from({ length: 5 }).map((_, i) => (
						<div key={i} className={cn("px-3 py-2.5 space-y-1.5", i > 0 && "border-t")}>
							<Skeleton className="h-3.5 w-32" />
							<Skeleton className="h-3 w-56" />
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

function ConnectorToolsList({ tools, isLoading }: { tools: ConnectorTool[]; isLoading: boolean }) {
	const [search, setSearch] = useState("");
	const deferredSearch = useDeferredValue(search);

	const filtered = useMemo(() => {
		if (!deferredSearch.trim()) return tools;
		const q = deferredSearch.trim().toLowerCase();
		return tools.filter(
			(t) => t.display_name?.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q),
		);
	}, [tools, deferredSearch]);

	if (isLoading) {
		return (
			<section>
				<h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Available Tools
				</h2>
				<div className="flex items-center justify-center py-6">
					<Spinner className="size-5 text-muted-foreground" />
				</div>
			</section>
		);
	}

	if (tools.length === 0) return null;

	return (
		<section>
			<div className="mb-3 flex items-center justify-between gap-3">
				<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Available Tools{" "}
					<span className="font-normal text-muted-foreground/60">({tools.length})</span>
				</h2>
				{tools.length > 8 && (
					<SearchInput value={search} onChange={setSearch} placeholder="Search…" className="w-56" />
				)}
			</div>
			<div className="max-h-[32rem] overflow-y-auto rounded-lg border">
				{filtered.map((tool, i) => (
					<div
						key={tool.name}
						className={cn(
							"flex items-start justify-between gap-3 px-3 py-2.5",
							i > 0 && "border-t",
						)}
					>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<span className="truncate text-sm font-medium">{tool.display_name}</span>
								{tool.is_deprecated && (
									<Badge variant="outline" className="shrink-0">
										deprecated
									</Badge>
								)}
							</div>
							{tool.description && (
								<p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
									{tool.description}
								</p>
							)}
						</div>
					</div>
				))}
				{filtered.length === 0 && (
					<p className="py-4 text-center text-sm text-muted-foreground">
						No tools match your search.
					</p>
				)}
			</div>
		</section>
	);
}
