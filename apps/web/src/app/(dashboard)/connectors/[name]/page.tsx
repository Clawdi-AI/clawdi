"use client";

import { AlertCircle, Check, Link2Off, Plug } from "lucide-react";
import { useParams } from "next/navigation";
import { parseAsString, useQueryStates } from "nuqs";
import { Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { ConnectorCredentialsDialog } from "@/components/connectors/credentials-dialog";
import { EmptyState } from "@/components/empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { ConnectorTool } from "@/lib/api-schemas";
import {
	isActiveConnection,
	useAvailableApp,
	useConnect,
	useConnections,
	useConnectorTools,
	useDisconnect,
} from "@/lib/connectors-data";
import { cn, errorMessage } from "@/lib/utils";

// Auth schemes whose connect flow is a redirect (OAuth family) or
// instant (`none` / `no_auth` — Composio's SDK enum lowercases either
// way); everything else needs the in-page credentials form.
const REDIRECT_AUTH_TYPES = new Set([
	"oauth",
	"oauth1",
	"oauth2",
	"composio_link",
	"none",
	"no_auth",
]);

/** Strip leading underscores/dashes and title-case for fallback display. */
function formatName(raw: string): string {
	return raw
		.replace(/^[_-]+/, "")
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Same Suspense pattern as `connectors/page.tsx`: nuqs's
 * `useQueryStates` reads `useSearchParams` under the hood, which
 * makes Next.js bail out of static generation. Wrapping the body
 * keeps the page renderable in App Router static-shell mode and
 * defers only the URL-state-dependent code to the client.
 */
export default function ConnectorDetailPage() {
	return (
		<Suspense fallback={<DetailSkeletonShell />}>
			<ConnectorDetail />
		</Suspense>
	);
}

function DetailSkeletonShell() {
	return (
		<div className="flex flex-col gap-4 px-4 lg:px-6">
			<DetailSkeleton />
		</div>
	);
}

function ConnectorDetail() {
	const { name } = useParams<{ name: string }>();

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
			description: oauthState.error || "OAuth did not complete. Try again from this page.",
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

	// Connect mutation: opens the OAuth popup synchronously on click
	// (browsers count `await`-deferred `window.open` calls as
	// programmatic and block them) and points it at the OAuth URL once
	// the backend responds. The popup eventually lands on this same
	// detail page via the `redirect_url` we send to Composio; React
	// Query's window-focus refetch picks up the new ACTIVE connection
	// when the user returns to this tab. No polling loop needed.
	const connectMutation = useConnect();

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
			{ connectionId },
			{
				onSettled: () => {
					inflightDisconnectsRef.current.delete(connectionId);
					setDisconnectingIds((s) => {
						const next = new Set(s);
						next.delete(connectionId);
						return next;
					});
				},
				onError: (e) => toast.error("Failed to disconnect", { description: errorMessage(e) }),
			},
		);
	};
	const isDisconnecting = (connectionId: string) => disconnectingIds.has(connectionId);

	const activeConnections =
		connections?.filter((c) => c.app_name === name && isActiveConnection(c)) ?? [];
	const isConnected = activeConnections.length > 0;
	const isLoading = isAppLoading || isConnectionsLoading;

	const displayName = app?.display_name || formatName(name);

	// Connectors split into redirect flows (OAuth family) and credentials
	// flows (form-based: API_KEY, BEARER_TOKEN, BASIC, …). Composio
	// surfaces several scheme strings that all belong to the redirect
	// path — `oauth`, `oauth1`, `oauth2`, `composio_link` — plus
	// `none` for instant-connect apps. Anything outside that set goes
	// to the dialog so newer credential-style schemes default safely
	// without code changes here.
	//
	// `app.auth_type` may be missing during a frontend-deployed-before-
	// backend window (older backend without the new field). Treat
	// undefined as "oauth2" — the safe redirect path — so the OAuth
	// popup is the worst-case experience instead of a credentials
	// dialog hitting an endpoint that doesn't exist yet.
	const [credsOpen, setCredsOpen] = useState(false);
	// `||` (not `??`): Composio occasionally returns empty string for
	// `auth_type` and an older backend may omit the field entirely; both
	// cases must fall through to the OAuth path. `??` would let `""`
	// pass and route the user into a credentials dialog calling
	// `/auth-fields` on a backend that lacks the endpoint.
	const authType = app?.auth_type || "oauth2";
	const usesCredentialsForm = !!app && !REDIRECT_AUTH_TYPES.has(authType);
	// Synchronous single-flight guard for the connect flow. Mirrors the
	// disconnect ref above: `connectMutation.isPending` only flips after
	// TanStack Query notifies subscribers (next microtask + render), so a
	// fast double-click would queue two `window.open` calls and two
	// mutations before React re-renders the disabled button. The ref
	// rejects the second click synchronously.
	const inflightConnectRef = useRef(false);
	const startConnect = () => {
		if (inflightConnectRef.current) return;
		if (usesCredentialsForm) {
			setCredsOpen(true);
			return;
		}
		// Open the OAuth popup synchronously — counts as user gesture so
		// the browser doesn't block it. We deliberately do NOT pass
		// `noopener` here: per MDN, `window.open(..., "_blank",
		// "noopener,...")` returns `null`, so we'd lose the handle and
		// could never redirect the blank popup to the real OAuth URL —
		// the user would just see a permanent about:blank page. We
		// detach the opener reference manually right after the call,
		// which gives us the same security posture without breaking the
		// late-redirect pattern.
		const popup = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
		if (!popup) {
			// Popup blocker rejected the open. Bail before firing the
			// mutation so we don't leak a connection request the user
			// can't complete — and tell them why nothing happened.
			toast.error("Popup blocked", {
				description: "Allow popups for this site to continue with OAuth.",
			});
			return;
		}
		try {
			popup.opener = null;
		} catch {
			// Cross-origin browsers can throw on opener writes; the
			// blank popup hasn't navigated cross-origin yet so this is
			// safe in practice, but swallow defensively.
		}
		inflightConnectRef.current = true;
		// Send our detail page URL as `redirect_url` so Composio sends the
		// user back here after OAuth instead of its default callback.
		// Lets us drop a polling loop — the popup eventually navigates
		// back to our origin and React Query's window-focus refetch
		// reflects the new ACTIVE connection.
		const redirectUrl = window.location.href;
		connectMutation.mutate(
			{ appName: name, redirectUrl },
			{
				onSuccess: (result) => {
					if (!popup.closed) popup.location.href = result.connect_url;
				},
				onError: (e) => {
					popup.close();
					toast.error("Failed to start connection", { description: errorMessage(e) });
				},
				onSettled: () => {
					inflightConnectRef.current = false;
				},
			},
		);
	};
	const isStarting = connectMutation.isPending;

	if (isLoading) {
		return (
			<div className="flex flex-col gap-4 px-4 lg:px-6">
				<DetailSkeleton />
			</div>
		);
	}

	// `appQ.error` covers both "connector not found" (404 from cloud-api,
	// thrown 404 from the hosted catalog adapter) and outright network
	// failures. Surface it so the user sees what's wrong instead of a
	// silently-broken connect page.
	if (appQ.error) {
		return (
			<div className="flex flex-col gap-4 px-4 lg:px-6">
				<EmptyState
					icon={Plug}
					title="Connector unavailable"
					description={errorMessage(appQ.error)}
				/>
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
						<Button variant="outline" size="xs" onClick={startConnect} disabled={isStarting}>
							{isStarting ? <Spinner className="size-3.5" /> : <Plug className="size-3.5" />}
							Connect
						</Button>
					)}
				</div>

				{connectionsQ.error ? (
					// Without this, a failed connections fetch silently renders
					// the "No connected accounts yet" empty state — the user
					// would think they have nothing connected when really we
					// just couldn't load the list.
					<Alert variant="destructive">
						<AlertCircle />
						<AlertTitle>Failed to load connections</AlertTitle>
						<AlertDescription>{errorMessage(connectionsQ.error)}</AlertDescription>
					</Alert>
				) : activeConnections.length === 0 ? (
					<EmptyState
						fillHeight={false}
						bordered
						description="No connected accounts yet."
						action={
							<Button onClick={startConnect} disabled={isStarting}>
								{isStarting ? <Spinner className="size-3.5" /> : <Plug className="size-3.5" />}
								{isStarting ? "Connecting..." : "Connect"}
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
									{/* Identity first — `account_display` (e.g. the user's Gmail
									    address) is the only thing that tells two same-app rows
									    apart. Falls back to a shortened connection id so OSS
									    users (whose backend doesn't surface account_display
									    yet) still see something distinct per row. */}
									<p className="truncate text-sm font-medium">
										{c.account_display || `Account ${c.id.slice(-6)}`}
									</p>
									<p className="mt-0.5 text-xs text-muted-foreground">
										{c.status.replace(/_/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase())}
									</p>
								</div>
								<Button
									variant="ghost"
									size="xs"
									onClick={() => handleDisconnect(c.id)}
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
							</div>
						))}
					</div>
				)}
			</section>

			{/* Tools — matches clawdi ConnectorToolsList */}
			<ConnectorToolsList tools={tools ?? []} isLoading={isToolsLoading} error={toolsQ.error} />

			<ConnectorCredentialsDialog
				open={credsOpen}
				onOpenChange={setCredsOpen}
				appName={name}
				displayName={displayName}
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
}: {
	tools: ConnectorTool[];
	isLoading: boolean;
	error: Error | null;
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

	// Surface tool-fetch failures explicitly so a transient backend hiccup
	// doesn't masquerade as "this connector has no tools".
	if (error) {
		return (
			<section>
				<h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Available Tools
				</h2>
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Failed to load tools</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
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
