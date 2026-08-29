"use client";

import { AlertCircle, Check, Link2Off, Plug, Wrench } from "lucide-react";
import { parseAsString, useQueryStates } from "nuqs";
import { Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { getConnectorAuthFlow } from "@/components/connectors/auth-flow.logic";
import { ConnectorConnectAction } from "@/components/connectors/connector-connect-action";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { DashboardSection, DashboardSectionHeader } from "@/components/dashboard/section";
import { DetailBackLink } from "@/components/detail/back-link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { isApiNotFoundError } from "@/lib/api-errors";
import type { ConnectorTool } from "@/lib/api-schemas";
import {
	isActiveConnection,
	useAvailableApp,
	useConnections,
	useConnectorTools,
	useDisconnect,
} from "@/lib/connectors-data";
import { shouldBlockQueryError } from "@/lib/query-state";
import {
	LIBRARY_RESOURCE_SCOPE,
	type ResourceNavigationScope,
	resourceCollectionTarget,
} from "@/lib/resource-navigation";
import { cn } from "@/lib/utils";

/** Strip leading underscores/dashes and title-case for fallback display. */
function formatName(raw: string): string {
	return raw
		.replace(/^[_-]+/, "")
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function connectionStatusLabel(status: string): string {
	const normalized = status.trim().toLowerCase();
	if (["active", "connected", "ready"].includes(normalized)) return "Connected";
	if (["pending", "initiated", "connecting"].includes(normalized)) return "Connecting";
	if (["expired", "disconnected", "revoked"].includes(normalized)) return "Reconnect required";
	if (["failed", "error"].includes(normalized)) return "Connection failed";
	return "Status unavailable";
}

/**
 * Same Suspense pattern as `connectors/page.tsx`: nuqs's
 * `useQueryStates` reads URL state under the hood. Wrapping the body keeps
 * the shell renderable and defers only the URL-state-dependent code.
 */
export default function ConnectorDetailPage({
	name,
	scope = LIBRARY_RESOURCE_SCOPE,
}: {
	name: string;
	scope?: ResourceNavigationScope;
}) {
	return (
		<Suspense fallback={<DetailSkeletonShell />}>
			<ConnectorDetail name={name} scope={scope} />
		</Suspense>
	);
}

function DetailSkeletonShell() {
	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-4 px-4 lg:px-6")}>
			<DetailSkeleton />
		</div>
	);
}

function ConnectorDetail({ name, scope }: { name: string; scope: ResourceNavigationScope }) {
	const collectionTarget = resourceCollectionTarget(scope, "connectors");
	// OAuth from hosted mode redirects directly back to this page (no
	// intermediary callback route). Composio sometimes signals failure
	// via `?error=…` and sometimes via `?status=error|failed` with no
	// detail; treat both as failure, toast once, and clear the params
	// via nuqs so a refresh doesn't re-toast.
	const [oauthState, setOauthState] = useQueryStates({
		error: parseAsString,
		status: parseAsString,
	});
	useEffect(() => {
		const failed =
			oauthState.error !== null || oauthState.status === "error" || oauthState.status === "failed";
		if (!failed) return;
		toast.error("Connection failed", {
			description: "The account could not be connected. Try again from this page.",
		});
		void setOauthState({ error: null, status: null }, { history: "replace" });
	}, [oauthState.error, oauthState.status, setOauthState]);

	// All hosted/cloud branching is encapsulated in the `connectors-data`
	// hooks — both branches are always-called, network is gated by the
	// `enabled` flag inside, and the returned shapes are unified.
	const appQ = useAvailableApp(name);
	const connectionsQ = useConnections();
	const toolsQ = useConnectorTools(name);
	const app = appQ.data;
	const isAppLoading = appQ.isLoading;
	const connections = connectionsQ.data;
	const isConnectionsLoading = connectionsQ.isLoading;
	const tools = toolsQ.data;
	const isToolsLoading = toolsQ.isLoading;

	// Per-row disconnect single-flight guard.
	//
	// The render-state Set (`disconnectingIds`) drives the spinner UI.
	// The ref (`inflightDisconnectsRef`) is the synchronous gate two
	// rapid clicks must pass: state updates are queued and read from a
	// stale snapshot until React commits, so back-to-back clicks both
	// see "not pending" and would each fire `mutation.mutate`. The ref
	// flips synchronously and rejects the second click before the
	// mutation queues. Both are kept in lockstep so the visible spinner
	// always matches the in-flight set.
	const disconnectMutation = useDisconnect();
	const inflightDisconnectsRef = useRef<Set<string>>(new Set());
	const [disconnectingIds, setDisconnectingIds] = useState<ReadonlySet<string>>(() => new Set());
	const handleDisconnect = (connectionId: string) => {
		if (inflightDisconnectsRef.current.has(connectionId)) return;
		inflightDisconnectsRef.current.add(connectionId);
		setDisconnectingIds((s) => new Set(s).add(connectionId));
		disconnectMutation.mutate(
			{ params: { path: { connection_id: connectionId } } },
			{
				onSettled: () => {
					inflightDisconnectsRef.current.delete(connectionId);
					setDisconnectingIds((s) => {
						const next = new Set(s);
						next.delete(connectionId);
						return next;
					});
				},
				onError: () =>
					toast.error("Couldn't disconnect", {
						description: "Try again. If the problem persists, refresh the page.",
					}),
			},
		);
	};
	const isDisconnecting = (connectionId: string) => disconnectingIds.has(connectionId);

	const activeConnections =
		connections?.filter((c) => c.app_name === name && isActiveConnection(c)) ?? [];
	const isConnected = activeConnections.length > 0;
	const isLoading = isAppLoading || appQ.isPending;

	const displayName = app?.display_name || formatName(name);

	// Connectors split only on explicit Composio auth schemes:
	// OAuth-family schemes open a Connect Link, credential schemes open
	// the credentials form, and no-auth toolkits are ready immediately.
	// Missing or unknown metadata is a backend contract error; do not
	// guess a connection flow.
	const authFlow = app ? getConnectorAuthFlow(app.auth_type) : null;
	const isSetupBlocked = !!app?.connect_disabled;
	const hasUnsupportedAuthType = !!app && authFlow === null;
	const usesNoAuth = authFlow === "no_auth";
	const isReady = isConnected || usesNoAuth;
	useSetBreadcrumbTitle(displayName);

	if (isLoading) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-4 px-4 lg:px-6")}>
				<DetailBackLink href={collectionTarget.href} label={collectionTarget.label} />
				<DetailSkeleton />
			</div>
		);
	}

	// `appQ.error` covers both "connector not found" (404 from cloud-api,
	// thrown 404 from the hosted catalog adapter) and outright network
	// failures. Surface it so the user sees what's wrong instead of a
	// silently-broken connect page.
	if (!app || isApiNotFoundError(appQ.error) || shouldBlockQueryError(appQ.error, appQ.data)) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-4 px-4 lg:px-6")}>
				<DetailBackLink href={collectionTarget.href} label={collectionTarget.label} />
				{!app || isApiNotFoundError(appQ.error) ? (
					<EmptyState
						icon={Plug}
						title="Connector unavailable"
						description="This connector is no longer available."
					/>
				) : (
					<ApiErrorPanel
						error={appQ.error}
						onRetry={() => {
							void appQ.refetch();
						}}
						title="Couldn't load connector"
					/>
				)}
			</div>
		);
	}

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-4 px-4 lg:px-6")}>
			<DetailBackLink href={collectionTarget.href} label={collectionTarget.label} />
			{scope.kind === "agent" ? (
				<Alert>
					<Plug />
					<AlertTitle>Shared across all agents</AlertTitle>
					<AlertDescription>
						Connections belong to this account. Connecting or disconnecting here affects all agents.
					</AlertDescription>
				</Alert>
			) : null}
			<PageHeader
				title={displayName}
				icon={<ConnectorIcon logo={app?.logo} name={displayName} size="lg" />}
				titleAdornment={
					isReady ? (
						<Badge variant="secondary">
							<Check />
							{usesNoAuth ? "Ready" : "Connected"}
						</Badge>
					) : undefined
				}
				description={app?.description || name}
			/>

			<DashboardSection priority="primary">
				<DashboardSectionHeader
					icon={Plug}
					title="Connected accounts"
					count={
						usesNoAuth
							? "No account required"
							: isConnectionsLoading
								? "Checking accounts"
								: `${activeConnections.length} connected`
					}
					description={
						usesNoAuth
							? "This connector does not require an account connection."
							: "Connect an account once. Approved tools become available to agents through this connector."
					}
					actions={
						!usesNoAuth &&
						!isSetupBlocked &&
						!isConnectionsLoading &&
						activeConnections.length > 0 ? (
							<ConnectorConnectAction app={app} label="Connect account" />
						) : null
					}
				/>
				<div className="p-4">
					{!usesNoAuth && shouldBlockQueryError(connectionsQ.error, connectionsQ.data) ? (
						// Without this, a failed connections fetch silently renders
						// the "No connected accounts yet" empty state — the user
						// would think they have nothing connected when really we
						// just couldn't load the list.
						<ApiErrorPanel
							error={connectionsQ.error}
							onRetry={() => {
								void connectionsQ.refetch();
							}}
							title="Couldn't load connections"
						/>
					) : !usesNoAuth && isConnectionsLoading ? (
						<div className="rounded-lg border bg-card p-4">
							<div className="flex items-center gap-3">
								<Skeleton className="size-9 shrink-0 rounded-lg" />
								<div className="min-w-0 flex-1 space-y-2">
									<Skeleton className="h-3.5 w-40" />
									<Skeleton className="h-3 w-28" />
								</div>
							</div>
						</div>
					) : usesNoAuth ? (
						<EmptyState variant="inset" description="No account connection is required." />
					) : hasUnsupportedAuthType ? (
						<ApiErrorPanel
							error="This connector uses an authentication method Clawdi does not support."
							onRetry={() => {
								void appQ.refetch();
							}}
							title="Connection unavailable"
						/>
					) : activeConnections.length === 0 ? (
						isSetupBlocked ? (
							<Alert>
								<AlertCircle />
								<AlertTitle>Connector unavailable</AlertTitle>
								<AlertDescription>
									Additional configuration is required. Contact support to continue.
								</AlertDescription>
							</Alert>
						) : (
							<EmptyState
								variant="inset"
								description="No connected accounts yet."
								action={
									<ConnectorConnectAction app={app} label="Connect account" emphasis="primary" />
								}
							/>
						)
					) : (
						<div className="divide-y overflow-hidden rounded-lg border bg-card">
							{activeConnections.map((c) => (
								<div key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
									<div className="min-w-0">
										{/* Identity first — `account_display` (e.g. the user's Gmail
										    address) is the only thing that tells two same-app rows
										    apart. Falls back to a shortened connection id so OSS
										    users (whose backend doesn't surface account_display
										    yet) still see something distinct per row. */}
										<p className="truncate text-sm font-medium">
											{c.account_display || `Account ${c.id.slice(-6)}`}
										</p>
										<p className="mt-0.5 text-xs text-muted-foreground">
											{connectionStatusLabel(c.status)}
										</p>
									</div>
									<ConfirmAction
										title={`Disconnect ${c.account_display || "this account"}?`}
										description={
											<p>
												All agents will lose access immediately. To restore access, sign in again.
											</p>
										}
										confirmLabel="Disconnect"
										destructive
										onConfirm={() => handleDisconnect(c.id)}
									>
										<Button
											variant="ghost"
											size="xs"
											disabled={isDisconnecting(c.id)}
											className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
										>
											{isDisconnecting(c.id) ? (
												<Spinner className="size-3.5" />
											) : (
												<Link2Off className="size-3.5" />
											)}
											Disconnect
										</Button>
									</ConfirmAction>
								</div>
							))}
						</div>
					)}
				</div>
			</DashboardSection>

			{/* Tools — matches clawdi ConnectorToolsList */}
			<ConnectorToolsList
				tools={tools ?? []}
				isLoading={isToolsLoading}
				error={shouldBlockQueryError(toolsQ.error, toolsQ.data) ? toolsQ.error : null}
				onRetry={() => {
					void toolsQ.refetch();
				}}
				requiresConnection={!usesNoAuth}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DetailSkeleton() {
	return (
		<div className="flex flex-col gap-4">
			<PageHeaderSkeleton icon iconClassName="size-14 rounded-xl" />
			{/* Connection section */}
			<div className="space-y-3">
				<Skeleton className="h-3.5 w-32" />
				<Skeleton className="h-3 w-20" />
				<div className="rounded-lg border border-dashed p-6">
					<Skeleton className="mx-auto h-9 w-28 rounded-lg" />
				</div>
			</div>
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

function ConnectorToolsList({
	tools,
	isLoading,
	error,
	onRetry,
	requiresConnection,
}: {
	tools: ConnectorTool[];
	isLoading: boolean;
	error: Error | null;
	onRetry: () => void;
	requiresConnection: boolean;
}) {
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
			<DashboardSection>
				<DashboardSectionHeader
					icon={Wrench}
					title="Available tools"
					description={
						requiresConnection
							? "Tools available once an account is connected."
							: "Tools this connector exposes."
					}
				/>
				<div className="flex items-center justify-center py-6">
					<Spinner className="size-5 text-muted-foreground" />
				</div>
			</DashboardSection>
		);
	}

	// Surface tool-fetch failures explicitly so a transient backend hiccup
	// doesn't masquerade as "this connector has no tools".
	if (error) {
		return (
			<DashboardSection>
				<DashboardSectionHeader
					icon={Wrench}
					title="Available tools"
					description={
						requiresConnection
							? "Tools available once an account is connected."
							: "Tools this connector exposes."
					}
				/>
				<div className="p-4">
					<ApiErrorPanel error={error} onRetry={onRetry} title="Couldn't load tools" />
				</div>
			</DashboardSection>
		);
	}

	if (tools.length === 0) {
		return (
			<DashboardSection>
				<DashboardSectionHeader
					icon={Wrench}
					title="Available tools"
					count="0 tools"
					description={
						requiresConnection
							? "Tools available once an account is connected."
							: "Tools this connector exposes."
					}
				/>
				<EmptyState variant="inset" description="No tools are available for this connector." />
			</DashboardSection>
		);
	}

	return (
		<DashboardSection>
			<DashboardSectionHeader
				icon={Wrench}
				title="Available tools"
				count={`${tools.length} tools`}
				description={
					requiresConnection
						? "Review the actions agents can request through this connector."
						: "Review the actions agents can request without account setup."
				}
				actions={
					tools.length > 8 ? (
						<SearchInput
							value={search}
							onChange={setSearch}
							placeholder="Search…"
							className="w-full sm:w-56"
						/>
					) : null
				}
			/>
			<div className="max-h-[32rem] overflow-y-auto">
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
										Deprecated
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
		</DashboardSection>
	);
}
