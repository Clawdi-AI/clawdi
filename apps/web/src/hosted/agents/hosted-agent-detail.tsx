"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import {
	ArrowUpRight,
	Cpu,
	CreditCard,
	ExternalLink,
	Info,
	Link2,
	Link2Off,
	type LucideIcon,
	Maximize2,
	MonitorPlay,
	Plus,
	QrCode,
	RefreshCw,
	Settings,
	TerminalSquare,
	Trash2,
	Zap,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSetAgentBreadcrumbTitle } from "@/components/breadcrumb-title";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { AgentSourceBadge, agentDisplayName } from "@/components/dashboard/agent-label";
import { AgentSettingsPanel } from "@/components/dashboard/agent-settings-panel";
import type { DetailSectionMeta } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SessionFeed } from "@/components/sessions/session-feed";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { deploymentDisplayName, isCloudEnvId } from "@/hosted/agent-identity";
import {
	useCreateTerminalSession,
	useDeleteDeployment,
	useDeploymentLifecycle,
	useOnboardAgent,
	useSetAgentAiProvider,
	useSetAgentEnabled,
} from "@/hosted/agents/deployment-hooks";
import {
	HostedTerminalPanel,
	type HostedTerminalStatus,
} from "@/hosted/agents/hosted-terminal-panel";
import { BillingError } from "@/hosted/billing/components/state-views";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import type {
	HostedDeployment,
	Plan,
	RebindAgentAiProviderRequest,
} from "@/hosted/billing/contracts";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { billingTermLabel, billingTermSuffix, formatCentsCompact } from "@/hosted/billing/format";
import {
	useCancelSubscription,
	useCheckout,
	usePlans,
	usePortal,
	useResumeSubscription,
} from "@/hosted/billing/hooks";
import {
	planOffers,
	selectOfferForTerm,
	shortDate,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import {
	HOSTED_RUNTIMES,
	type HostedRuntime,
	OPTIONAL_HOSTED_RUNTIMES,
	runtimeBlurb,
	runtimeCanDisable,
	runtimeConsoleUrl,
	runtimeDisplayName,
	runtimeIsConfigured,
	runtimeIsEnabled,
} from "@/hosted/runtimes";
import {
	type AgentSectionId,
	agentSectionHref,
	agentSectionLabel,
	HOSTED_AGENT_SECTION_IDS,
} from "@/lib/agent-routes";
import { toastApiError, unwrap, useApi } from "@/lib/api";
import type { SessionListItem } from "@/lib/api-schemas";
import { formatModelLabel } from "@/lib/format";
import { sessionListQueryOptions } from "@/lib/session-queries";
import { cn } from "@/lib/utils";
import { useAiProviders } from "@/v2/ai-providers/ai-providers-hooks";
import { AuthBadge, ProviderTypeChip } from "@/v2/ai-providers/ai-providers-ui";
import { aiProviderRuntimeId, buildAiProviderBootstrap } from "@/v2/ai-providers/runtime-bootstrap";
import type { AgentChannelLink } from "@/v2/channels/channel-edit-client";
import { providerMeta } from "@/v2/channels/channel-providers";
import { ChannelError, ProviderChip, TokenReveal } from "@/v2/channels/channel-ui";
import {
	useAgentChannelLinks,
	useBotPool,
	useChannels,
	useCreatePairCode,
	useUnlinkAgentChannel,
} from "@/v2/channels/channels-hooks";

type Runtime = HostedRuntime;
type HostedAgentTab =
	| "overview"
	| "console"
	| "terminal"
	| "sessions"
	| "ai"
	| "channels"
	| "settings";
const RUNTIMES = HOSTED_RUNTIMES.map((id) => ({
	id,
	label: runtimeDisplayName(id),
	blurb: runtimeBlurb(id),
})) satisfies { id: Runtime; label: string; blurb: string }[];
const HOSTED_AGENT_TABS = new Set<HostedAgentTab>([
	"overview",
	"console",
	"terminal",
	"sessions",
	"ai",
	"channels",
	"settings",
]);
const HOSTED_AGENT_NAV_META: Record<HostedAgentTab, DetailSectionMeta> = {
	overview: {
		description: "Status, model, resources, and recent sessions.",
		icon: Info,
	},
	console: {
		description: "Open the runtime's live browser UI.",
		icon: MonitorPlay,
	},
	terminal: {
		description: "Start a browser terminal in this deployment.",
		icon: TerminalSquare,
	},
	sessions: {
		description: "History synced by this hosted runtime.",
		icon: RefreshCw,
	},
	ai: {
		description: "Runtime-scoped provider and model binding.",
		icon: Zap,
	},
	channels: {
		description: "Messaging links for this hosted agent.",
		icon: Link2,
	},
	settings: {
		description: "Profile, compute, lifecycle, and runtime availability.",
		icon: Settings,
	},
};
const STARTABLE_STATUSES = new Set(["stopped", "failed"]);
const STOPPABLE_STATUSES = new Set(["running", "ready", "starting"]);
const RESTARTABLE_STATUSES = new Set(["running", "ready", "starting", "failed"]);

/** Map an AI provider's auth type to the deploy `ai_provider_auth_kind`. */
function aiAuthKind(provider: { auth: { type: string } }): "api_key" | "codex_oauth" {
	return provider.auth.type === "agent_profile" || provider.auth.type === "oauth_profile"
		? "codex_oauth"
		: "api_key";
}

function statusLabel(status: string): string {
	if (status === "running" || status === "ready") return "Running";
	if (status === "provisioning") return "Provisioning";
	if (status === "starting") return "Starting";
	if (status === "stopped") return "Stopped";
	if (status === "failed" || status === "error") return "Failed";
	return status;
}

function parseHostedAgentTab(value: AgentSectionId | string | null): HostedAgentTab | null {
	if (!value) return null;
	return HOSTED_AGENT_SECTION_IDS.includes(value as HostedAgentTab) &&
		HOSTED_AGENT_TABS.has(value as HostedAgentTab)
		? (value as HostedAgentTab)
		: null;
}

function hostedAgentContentWidthClass(tab: HostedAgentTab): string | null {
	if (tab === "console" || tab === "terminal") return null;
	if (tab === "settings") return CENTERED_PAGE_WIDTH_CLASS.settings;
	if (tab === "ai" || tab === "channels") {
		return CENTERED_PAGE_WIDTH_CLASS.form;
	}
	return CENTERED_PAGE_WIDTH_CLASS.detail;
}

function LiveNote({ children }: { children: React.ReactNode }) {
	return (
		<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
			<Info className="size-3.5 shrink-0" />
			{children}
		</p>
	);
}

function performancePlan(plans: Plan[] | undefined): Plan | undefined {
	return (
		plans?.find((p) => p.slug === "compute_performance") ?? plans?.find((p) => p.price_cents > 0)
	);
}

function redirectToCheckout(url: string | null | undefined): boolean {
	if (!url) return false;
	window.location.href = url;
	return true;
}

/**
 * PER-RUNTIME agent detail. A compute (deployment) hosts the always-on Codex
 * runtime plus optional sibling runtimes; each runtime has its own env id, AI
 * provider binding, channel links, sessions, and control UI. Terminal and compute
 * controls are deployment-wide because they attach to the shared hosted compute.
 */
export function HostedAgentDetail({
	environmentId,
	deployment,
	runtime,
	section = "overview",
}: {
	environmentId: string;
	deployment: HostedDeployment;
	runtime: Runtime;
	section?: AgentSectionId;
}) {
	const api = useApi();
	const router = useRouter();
	const ci = deployment.config_info;
	const { data: agent } = useQuery({
		queryKey: ["agent", environmentId],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/environments/{environment_id}", {
					params: { path: { environment_id: environmentId } },
				}),
			),
		enabled: isCloudEnvId(environmentId),
	});
	const name = agent ? agentDisplayName(agent) : deploymentDisplayName(deployment.name);
	const runtimeLabel = runtimeDisplayName(runtime);
	const agentTitle = name === runtimeLabel ? name : `${name} · ${runtimeLabel}`;
	const activeTab = parseHostedAgentTab(section) ?? "overview";
	useSetAgentBreadcrumbTitle({
		agentId: environmentId,
		agentTitle,
		section: activeTab,
	});

	const isPerformance = ci?.compute_plan_slug === "compute_performance";
	const consoleUrl = runtimeConsoleUrl(deployment, runtime);
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const scopedSessionLink = (sessionId: string) => ({
		to: "/agents/$id/sessions/$sessionId" as const,
		params: { id: environmentId, sessionId },
	});

	useEffect(() => {
		if (parseHostedAgentTab(section)) return;
		void router.navigate({
			href: agentSectionHref(environmentId, "overview", searchStr),
			replace: true,
		});
	}, [environmentId, router, searchStr, section]);

	const sessions = useQuery({
		...sessionListQueryOptions(api, { environment_id: environmentId, page_size: 20 }),
		enabled: isCloudEnvId(environmentId),
	});

	const activeNavItem = HOSTED_AGENT_NAV_META[activeTab];
	const activeTabLabel = agentSectionLabel(activeTab);
	const ActiveTabIcon = activeNavItem.icon;
	const isLiveToolTab = activeTab === "console" || activeTab === "terminal";
	const contentWidthClass = hostedAgentContentWidthClass(activeTab);

	return (
		<div
			data-hosted="true"
			className={
				isLiveToolTab
					? "-my-4 flex min-h-[calc(100svh-var(--header-height))] flex-col md:-my-5 md:min-h-[calc(100svh-var(--header-height)-1rem)]"
					: "flex flex-col gap-6 px-4 lg:px-6"
			}
		>
			<h1 className="sr-only">{agentTitle}</h1>
			<section
				className={cn(
					isLiveToolTab ? "flex min-h-0 flex-1 flex-col" : "flex flex-col gap-4",
					contentWidthClass,
				)}
			>
				{isLiveToolTab ? null : (
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div>
							<div className="flex items-center gap-2">
								{ActiveTabIcon ? <ActiveTabIcon className="size-4 text-muted-foreground" /> : null}
								<h2 className="text-xl font-semibold tracking-tight">{activeTabLabel}</h2>
								<AgentSourceBadge source="hosted" compact />
							</div>
							{activeNavItem.description ? (
								<p className="mt-1 text-sm text-muted-foreground">{activeNavItem.description}</p>
							) : null}
						</div>
						{consoleUrl ? (
							<Button asChild variant="outline" size="sm">
								<a href={consoleUrl} target="_blank" rel="noopener noreferrer">
									Open {runtimeBrowserUiLabel(runtime)}
									<ExternalLink className="size-3.5" />
								</a>
							</Button>
						) : null}
					</div>
				)}
				{activeTab === "overview" ? (
					<OverviewTab
						deployment={deployment}
						runtime={runtime}
						isPerformance={isPerformance}
						sessions={sessions.data?.items ?? []}
						sessionsLoading={sessions.isLoading}
						sessionsError={sessions.error}
						onRetrySessions={() => sessions.refetch()}
						sessionLink={(session) => scopedSessionLink(session.id)}
					/>
				) : null}
				{activeTab === "console" ? <ConsoleTab deployment={deployment} runtime={runtime} /> : null}
				{activeTab === "terminal" ? <TerminalTab deployment={deployment} /> : null}
				{activeTab === "sessions" ? (
					sessions.error ? (
						<ChannelError
							error={sessions.error}
							onRetry={() => sessions.refetch()}
							title="Couldn't load sessions"
						/>
					) : (
						<SessionFeed
							sessions={sessions.data?.items ?? []}
							isLoading={sessions.isLoading}
							emptyMessage="No sessions from this agent yet."
							showAgent={false}
							sessionLink={(session) => scopedSessionLink(session.id)}
						/>
					)
				) : null}
				{activeTab === "ai" ? <AiProviderTab deployment={deployment} runtime={runtime} /> : null}
				{activeTab === "channels" ? <ChannelsTab environmentId={environmentId} /> : null}
				{activeTab === "settings" ? (
					<HostedAgentSettingsTab
						environmentId={environmentId}
						deployment={deployment}
						isPerformance={isPerformance}
						runtime={runtime}
					/>
				) : null}
			</section>
		</div>
	);
}

// ── Overview ─────────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="rounded-lg border p-3">
			<div className="text-sm font-medium">{value}</div>
			<div className="text-xs text-muted-foreground">{label}</div>
		</div>
	);
}

function OverviewTab({
	deployment,
	runtime,
	isPerformance,
	sessions,
	sessionsLoading,
	sessionsError,
	onRetrySessions,
	sessionLink,
}: {
	deployment: HostedDeployment;
	runtime: Runtime;
	isPerformance: boolean;
	sessions: SessionListItem[];
	sessionsLoading: boolean;
	sessionsError: unknown;
	onRetrySessions: () => void;
	sessionLink: (session: SessionListItem) => {
		to: "/agents/$id/sessions/$sessionId";
		params: { id: string; sessionId: string };
	};
}) {
	const ci = deployment.config_info;
	const binding = ci?.ai_provider_bindings?.[runtime];
	const model = binding?.primary_model ?? ci?.primary_model ?? "Managed default";
	return (
		<div className="flex flex-col gap-5">
			<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
				<StatCard label="Status" value={statusLabel(deployment.status)} />
				<StatCard label="Compute" value={isPerformance ? "Performance" : "Free"} />
				<StatCard label="Model" value={model} />
				<StatCard
					label="Resources"
					value={ci ? `${ci.vcpu ?? "—"} vCPU · ${ci.ram_gb ?? "—"} GB` : "—"}
				/>
			</div>
			<div>
				<div className="mb-2 text-sm font-medium">Recent sessions</div>
				{sessionsError ? (
					<ChannelError
						error={sessionsError}
						onRetry={onRetrySessions}
						title="Couldn't load sessions"
					/>
				) : (
					<SessionFeed
						sessions={sessions}
						isLoading={sessionsLoading}
						emptyMessage="No sessions from this agent yet."
						showAgent={false}
						sessionLink={sessionLink}
					/>
				)}
			</div>
		</div>
	);
}

// ── Runtime UI ───────────────────────────────────────────────────────────────

/**
 * Live agent browser UI embedded inline. The deployment's per-runtime UI URLs
 * point at owner-only runtime bridge URLs. When the runtime
 * allows dashboard framing, the bridge cookie + WS work in-frame; otherwise
 * the full-screen link is the alternate path.
 */
function ConsoleTab({ deployment, runtime }: { deployment: HostedDeployment; runtime: Runtime }) {
	const isRunning = deployment.status === "running" || deployment.status === "ready";
	const label = runtimeDisplayName(runtime);
	const browserUiLabel = runtimeBrowserUiLabel(runtime);
	const url = runtimeConsoleUrl(deployment, runtime);

	// Not running yet — the runtime UI and bridge only exist once the agent boots.
	if (!isRunning) {
		return (
			<EmptyState
				bordered
				icon={MonitorPlay}
				title="Runtime UI available once running"
				description={`The live ${browserUiLabel} opens here as soon as the agent is running — currently ${statusLabel(
					deployment.status,
				).toLowerCase()}.`}
			/>
		);
	}

	// Running, but this runtime hasn't published a UI endpoint.
	if (!url) {
		return (
			<EmptyState
				bordered
				icon={MonitorPlay}
				title="No Runtime UI URL yet"
				description={
					<span>
						This {label} runtime is running but hasn&apos;t published its browser UI endpoint. Reach
						it by linking a channel from{" "}
						<Link to="/channels" className="underline">
							Channels
						</Link>
						.
					</span>
				}
			/>
		);
	}

	return (
		<LiveToolFrame
			icon={MonitorPlay}
			title={browserUiLabel}
			action={
				<Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
					<a href={url} target="_blank" rel="noopener noreferrer">
						Open full screen
						<Maximize2 className="size-3.5" />
					</a>
				</Button>
			}
		>
			{/* Desktop: embed the live UI. Mobile is too cramped, so offer the
			    full-screen link instead. */}
			<iframe
				key={`${runtime}:${url}`}
				src={url}
				title={browserUiLabel}
				className="hidden min-h-0 flex-1 border-0 bg-background sm:block"
				allow="clipboard-read; clipboard-write"
			/>
			<div className="flex min-h-[420px] flex-1 flex-col items-center justify-center gap-3 p-6 text-center sm:hidden">
				<p className="text-sm text-muted-foreground">
					This runtime UI is best viewed full screen on a small screen.
				</p>
				<Button asChild variant="outline" size="sm">
					<a href={url} target="_blank" rel="noopener noreferrer">
						Open {browserUiLabel}
						<Maximize2 className="size-3.5" />
					</a>
				</Button>
			</div>
		</LiveToolFrame>
	);
}

function runtimeBrowserUiLabel(runtime: Runtime): string {
	if (runtime === "openclaw") return "OpenClaw Control UI";
	if (runtime === "hermes") return "Hermes Dashboard";
	return `${runtimeDisplayName(runtime)} UI`;
}

// ── Terminal ────────────────────────────────────────────────────────────────

function LiveToolFrame({
	icon: Icon,
	title,
	detail,
	action,
	children,
}: {
	icon: LucideIcon;
	title: React.ReactNode;
	detail?: React.ReactNode;
	action?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
			<div className="flex h-12 shrink-0 items-center justify-between gap-3 px-4 lg:px-6">
				<div className="flex min-w-0 items-center gap-2 text-sm">
					<Icon className="size-4 shrink-0 text-muted-foreground" />
					<span className="min-w-0 truncate font-medium">{title}</span>
					{detail ? (
						<span className="hidden min-w-0 truncate text-muted-foreground sm:inline">
							{detail}
						</span>
					) : null}
				</div>
				{action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
			</div>
			{children}
		</div>
	);
}

const TERMINAL_STATUS_LABELS: Record<HostedTerminalStatus, string> = {
	connecting: "Connecting",
	connected: "Connected",
	disconnected: "Disconnected",
};

function TerminalStatusIndicator({ status }: { status: HostedTerminalStatus }) {
	return (
		<div className="flex items-center gap-2 text-xs text-muted-foreground">
			<span
				className={cn(
					"size-2 rounded-full",
					status === "connected"
						? "bg-emerald-500"
						: status === "connecting"
							? "bg-amber-500"
							: "bg-destructive",
				)}
			/>
			<span>{TERMINAL_STATUS_LABELS[status]}</span>
		</div>
	);
}

function TerminalTab({ deployment }: { deployment: HostedDeployment }) {
	const isRunning = deployment.status === "running" || deployment.status === "ready";
	const label = deploymentDisplayName(deployment.name);
	const terminal = useCreateTerminalSession();
	const { isPending: isOpeningTerminal, mutateAsync: createTerminalSession } = terminal;
	const [websocketUrl, setWebsocketUrl] = useState<string | null>(null);
	const [terminalStatus, setTerminalStatus] = useState<HostedTerminalStatus>("disconnected");
	const [terminalFailure, setTerminalFailure] = useState<string | null>(null);
	const autoStartedDeploymentRef = useRef<string | null>(null);
	const currentDeploymentIdRef = useRef(deployment.id);
	const terminalRequestRef = useRef(0);

	const startTerminal = useCallback(async () => {
		if (!isRunning || isOpeningTerminal) return;
		const requestId = terminalRequestRef.current + 1;
		terminalRequestRef.current = requestId;
		setTerminalFailure(null);
		setTerminalStatus("connecting");
		try {
			const session = await createTerminalSession({ id: deployment.id });
			if (terminalRequestRef.current !== requestId) return;
			if (!session.websocket_url) {
				setTerminalStatus("disconnected");
				setTerminalFailure("The deployment did not return a terminal websocket URL.");
				toast.error("Terminal unavailable", {
					description: "The deployment did not return a terminal websocket URL.",
				});
				return;
			}
			setWebsocketUrl(session.websocket_url);
		} catch {
			if (terminalRequestRef.current !== requestId) return;
			setTerminalStatus("disconnected");
			setTerminalFailure("Couldn't open terminal. Try again.");
		}
	}, [createTerminalSession, deployment.id, isOpeningTerminal, isRunning]);

	useEffect(() => {
		if (currentDeploymentIdRef.current === deployment.id) return;
		currentDeploymentIdRef.current = deployment.id;
		autoStartedDeploymentRef.current = null;
		setWebsocketUrl(null);
		setTerminalFailure(null);
		setTerminalStatus("disconnected");
	}, [deployment.id]);

	useEffect(() => {
		if (isRunning) return;
		autoStartedDeploymentRef.current = null;
		setWebsocketUrl(null);
		setTerminalFailure(null);
		setTerminalStatus("disconnected");
	}, [isRunning]);

	useEffect(() => {
		if (!isRunning || websocketUrl || isOpeningTerminal || terminalFailure) return;
		if (autoStartedDeploymentRef.current === deployment.id) return;
		autoStartedDeploymentRef.current = deployment.id;
		void startTerminal();
	}, [deployment.id, isOpeningTerminal, isRunning, startTerminal, terminalFailure, websocketUrl]);

	const handleTerminalStatusChange = useCallback((status: HostedTerminalStatus) => {
		setTerminalStatus(status);
	}, []);

	if (!isRunning) {
		return (
			<EmptyState
				bordered
				icon={TerminalSquare}
				title="Terminal available once running"
				description={`A deployment shell can be opened when the hosted compute is running. Current status: ${statusLabel(
					deployment.status,
				).toLowerCase()}.`}
			/>
		);
	}

	const displayStatus = websocketUrl
		? terminalStatus
		: terminalFailure
			? "disconnected"
			: "connecting";
	const terminalAction = (
		<>
			<TerminalStatusIndicator status={displayStatus} />
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="hidden sm:inline-flex"
				disabled={isOpeningTerminal}
				onClick={() => void startTerminal()}
			>
				{isOpeningTerminal ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
				Reconnect
			</Button>
		</>
	);

	if (!websocketUrl) {
		return (
			<LiveToolFrame icon={TerminalSquare} title="Terminal" detail={label} action={terminalAction}>
				<div className="flex min-h-0 flex-1 items-center justify-center bg-background px-4 py-10">
					<div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
						<div className="flex size-11 items-center justify-center rounded-lg border bg-muted/40">
							{terminalFailure ? (
								<TerminalSquare className="size-5 text-muted-foreground" />
							) : (
								<Spinner className="size-5 text-muted-foreground" />
							)}
						</div>
						<div>
							<h2 className="text-base font-semibold">
								{terminalFailure ? "Terminal unavailable" : "Opening deployment terminal"}
							</h2>
							<p className="mt-1 text-sm text-muted-foreground">
								{terminalFailure ??
									"Starting a real shell in the hosted deployment as the default runtime user."}
							</p>
						</div>
						{terminalFailure ? (
							<Button onClick={() => void startTerminal()} disabled={isOpeningTerminal}>
								{isOpeningTerminal ? (
									<Spinner className="size-3.5" />
								) : (
									<RefreshCw className="size-3.5" />
								)}
								Retry
							</Button>
						) : null}
					</div>
				</div>
			</LiveToolFrame>
		);
	}

	return (
		<LiveToolFrame icon={TerminalSquare} title="Terminal" detail={label} action={terminalAction}>
			<HostedTerminalPanel
				key={websocketUrl}
				websocketUrl={websocketUrl}
				onStatusChange={handleTerminalStatusChange}
			/>
		</LiveToolFrame>
	);
}

// ── AI Provider ──────────────────────────────────────────────────────────────

function selectableCard(active: boolean): string {
	return `w-full rounded-lg border p-4 text-left transition-colors ${
		active
			? "border-primary bg-primary/5 ring-1 ring-primary/30"
			: "border-border hover:bg-accent/40"
	}`;
}

function AiProviderTab({
	deployment,
	runtime,
}: {
	deployment: HostedDeployment;
	runtime: Runtime;
}) {
	const providers = useAiProviders();
	const setProvider = useSetAgentAiProvider();
	const ci = deployment.config_info;
	const list = providers.data?.providers ?? [];
	// PER-RUNTIME binding (not the deployment-level field): each runtime binds
	// its own provider in ai_provider_bindings[runtime].
	const binding = ci?.ai_provider_bindings?.[runtime];
	const boundRef = binding?.provider_id ?? ci?.ai_provider_id ?? null;
	const currentManaged =
		!boundRef ||
		boundRef === "clawdi-managed" ||
		(binding?.auth_kind ?? ci?.ai_provider_auth_kind) === "managed";
	// The binding stores the provider's id (UUID); map it back to the slug the
	// select uses as its value.
	const inUseSlug = currentManaged
		? null
		: (list.find((p) => p.id === boundRef || p.provider_id === boundRef)?.provider_id ?? null);
	const unresolvedProviderRef = !currentManaged && !inUseSlug ? boundRef : null;
	const showUnresolvedProvider =
		Boolean(unresolvedProviderRef) && !providers.isLoading && !providers.error;
	const currentModel = binding?.primary_model ?? ci?.primary_model ?? "";

	const initial = currentManaged ? "managed" : (inUseSlug ?? `unresolved:${unresolvedProviderRef}`);
	const [selected, setSelected] = useState<string>(initial);
	const [primaryModel, setPrimaryModel] = useState<string>(currentModel);

	// Re-seed the form only when the server-side binding genuinely changes (the
	// user's own apply completing, or an out-of-band change) — never on a plain
	// background poll. Keyed on the binding identity: identical server truth →
	// same identity → in-progress edits stay untouched; a real change → reset to
	// the new truth. This is React's "adjust state during render" idiom, which
	// replaces an effect that re-ran on every keystroke.
	const bindingIdentity = JSON.stringify([initial, currentModel]);
	const [syncedIdentity, setSyncedIdentity] = useState(bindingIdentity);
	if (bindingIdentity !== syncedIdentity) {
		setSyncedIdentity(bindingIdentity);
		setSelected(initial);
		setPrimaryModel(currentModel);
	}

	if (runtime === "codex") {
		return (
			<EmptyState
				bordered
				icon={Info}
				title="Codex AI access is set at deploy time"
				description="This hosted runtime is always available. Runtime-specific AI provider changes are available for OpenClaw and Hermes."
			/>
		);
	}

	const dirty = selected !== initial || primaryModel !== currentModel;

	function apply() {
		const body: RebindAgentAiProviderRequest = {
			primary_model: primaryModel.trim() || null,
			ai_provider_auth_kind: "managed",
		};
		if (selected === "managed") {
			body.ai_provider_auth_kind = "managed";
			body.ai_provider_id = null;
		} else {
			const p = list.find((x) => x.provider_id === selected);
			if (!p) {
				toast.error("Provider unavailable", {
					description: "Refresh providers or choose Managed by Clawdi.",
				});
				return;
			}
			const kind = aiAuthKind(p);
			try {
				body.ai_provider_auth_kind = kind;
				body.ai_provider_id = aiProviderRuntimeId(p);
				body.ai_provider_bootstrap = buildAiProviderBootstrap(p, kind);
			} catch (error) {
				toast.error("Provider unavailable", {
					description:
						error instanceof Error
							? error.message
							: "Refresh providers or choose Managed by Clawdi.",
				});
				return;
			}
		}
		// Scope the edit to THIS runtime only — not every enabled runtime.
		setProvider.mutate(
			{ id: deployment.id, agentTypes: [runtime], body },
			{
				onSuccess: () =>
					toast.success("Provider updated", { description: "Updating the runtime…" }),
			},
		);
	}

	return (
		<div className="space-y-4">
			<LiveNote>Provider changes apply to the running runtime — no restart.</LiveNote>

			<div className="space-y-2">
				<button
					type="button"
					onClick={() => setSelected("managed")}
					className={selectableCard(selected === "managed")}
				>
					<div className="flex items-center justify-between gap-2">
						<span className="text-sm font-medium">Managed by Clawdi</span>
						{currentManaged ? <Badge variant="secondary">In use</Badge> : null}
					</div>
					<p className="mt-0.5 text-sm text-muted-foreground">
						Clawdi-managed Claude models, billed from your wallet.
					</p>
				</button>
				{providers.isLoading ? <Skeleton className="h-20 w-full rounded-lg" /> : null}
				{providers.error ? (
					<BillingError
						error={providers.error}
						onRetry={() => providers.refetch()}
						title="Couldn't load providers"
					/>
				) : null}
				{showUnresolvedProvider ? (
					<button type="button" disabled className={selectableCard(selected === initial)}>
						<div className="flex items-center justify-between gap-2">
							<span className="text-sm font-medium">Provider unavailable</span>
							<Badge variant="secondary">In use</Badge>
						</div>
						<p className="mt-0.5 text-sm text-muted-foreground">
							This runtime is bound to {unresolvedProviderRef}, but that provider could not be
							loaded. Choose Managed by Clawdi to replace it.
						</p>
					</button>
				) : null}
				{list.map((p) => (
					<button
						key={p.provider_id}
						type="button"
						onClick={() => setSelected(p.provider_id)}
						className={`flex items-center gap-3 ${selectableCard(selected === p.provider_id)}`}
					>
						<ProviderTypeChip type={p.type} />
						<span className="min-w-0 flex-1">
							<span className="flex items-center gap-2">
								<span className="truncate text-sm font-medium">{p.label ?? p.provider_id}</span>
								<AuthBadge auth={p.auth} />
							</span>
							{p.default_model ? (
								<span className="block text-xs text-muted-foreground">
									{formatModelLabel(p.default_model)}
								</span>
							) : null}
						</span>
						{p.provider_id === inUseSlug ? <Badge variant="secondary">In use</Badge> : null}
					</button>
				))}
				<Button asChild variant="ghost" size="sm" className="justify-start text-muted-foreground">
					<Link to="/ai-providers">
						<Plus className="size-3.5" />
						Add a provider
					</Link>
				</Button>
			</div>

			<div className="max-w-sm space-y-1.5">
				<Label htmlFor="primary-model">Primary model (optional)</Label>
				<Input
					id="primary-model"
					value={primaryModel}
					onChange={(e) => setPrimaryModel(e.target.value)}
					placeholder="claude-sonnet-4-5"
					autoComplete="off"
					spellCheck={false}
				/>
			</div>

			<div className="flex items-center gap-2">
				<Button
					onClick={apply}
					disabled={
						!dirty ||
						setProvider.isPending ||
						(selected !== "managed" && (providers.isLoading || !!providers.error))
					}
				>
					{setProvider.isPending ? <Spinner className="size-3.5" /> : null}
					{setProvider.isPending ? "Applying live…" : "Apply changes"}
				</Button>
				{setProvider.isPending ? (
					<span className="text-xs text-muted-foreground">Updating the runtime…</span>
				) : null}
			</div>

			<p className="text-xs text-muted-foreground">
				Add, validate, or remove providers on{" "}
				<Link to="/ai-providers" className="underline">
					Model Providers
				</Link>
				.
			</p>
		</div>
	);
}

// ── Channels ─────────────────────────────────────────────────────────────────

function ChannelsTab({ environmentId }: { environmentId: string }) {
	const api = useApi();
	const qc = useQueryClient();
	const channels = useChannels();
	const botPool = useBotPool();
	const hasEnvironmentId = isCloudEnvId(environmentId);
	const linked = useAgentChannelLinks(environmentId, hasEnvironmentId);
	const unlink = useUnlinkAgentChannel(environmentId);
	// "" = no channel selected. Sentinel keeps the Select controlled (no
	// undefined↔string flip) while staying falsy for the gated Link button.
	const [accountId, setAccountId] = useState("");
	const [token, setToken] = useState<string | null>(null);

	const linkedIds = useMemo(
		() => new Set((linked.data ?? []).map((l) => l.account_id)),
		[linked.data],
	);
	const linkable = useMemo(() => {
		const mine = (channels.data ?? []).map((c) => ({
			id: c.id,
			provider: c.provider,
			name: c.name,
		}));
		const shared = Object.values(botPool.data?.providers ?? {})
			.flat()
			.filter((b) => b.access === "public" && b.available)
			.map((b) => ({ id: b.id, provider: b.provider, name: b.name }));
		return [...mine, ...shared].filter((c) => !linkedIds.has(c.id));
	}, [channels.data, botPool.data, linkedIds]);

	// Provider/name labels for linked rows whose API payload omits the nested
	// `account` (the list-by-agent endpoint isn't guaranteed to embed it).
	// Resolved from the already-loaded channels + shared bot-pool by account id.
	const accountSummaries = useMemo(() => {
		const map = new Map<string, { provider: string; name: string }>();
		for (const c of channels.data ?? []) map.set(c.id, { provider: c.provider, name: c.name });
		for (const list of Object.values(botPool.data?.providers ?? {}))
			for (const b of list) map.set(b.id, { provider: b.provider, name: b.name });
		return map;
	}, [channels.data, botPool.data]);

	const link = useMutation({
		mutationFn: async (channelId: string) =>
			unwrap(
				await api.POST("/api/channels/{account_id}/agent-links", {
					params: { path: { account_id: channelId } },
					body: { agent_id: environmentId },
				}),
			),
		onSuccess: (data) => {
			setToken(data.agent_token ?? null);
			setAccountId("");
			qc.invalidateQueries({ queryKey: ["agent-channel-links", environmentId] });
			qc.invalidateQueries({ queryKey: ["channel-agent-links", data.account_id] });
			qc.invalidateQueries({ queryKey: ["channel-bot-pool"] });
			qc.invalidateQueries({ queryKey: ["channels"] });
			toast.success("Channel linked");
		},
		onError: toastApiError("Couldn't link channel"),
	});

	if (!hasEnvironmentId) {
		return (
			<EmptyState
				bordered
				icon={Link2}
				title="Channels available once provisioning finishes"
				description="The deployment is still minting its cloud agent id. When the agent is ready, link channels here."
			/>
		);
	}

	return (
		<div className="space-y-4">
			<LiveNote>Linking a channel applies its token live — no restart.</LiveNote>

			{/* Linked channels */}
			<div className="space-y-2">
				<div className="text-sm font-medium">Linked channels</div>
				{linked.isLoading ? (
					<Skeleton className="h-16 w-full rounded-lg" />
				) : linked.error ? (
					<ChannelError
						error={linked.error}
						onRetry={() => linked.refetch()}
						title="Couldn't load linked channels"
					/>
				) : (linked.data ?? []).length === 0 ? (
					<EmptyState
						bordered
						fillHeight={false}
						title="No channels linked"
						description="Link a channel below so this agent can send and receive messages."
					/>
				) : (
					(linked.data ?? []).map((l) => (
						<LinkedChannelRow
							key={l.id}
							link={l}
							fallbackAccount={accountSummaries.get(l.account_id)}
							unlinking={unlink.isPending}
							onUnlink={() => unlink.mutate({ accountId: l.account_id, linkId: l.id })}
						/>
					))
				)}
			</div>

			{/* Link a channel */}
			<div className="space-y-2 rounded-lg border p-4">
				<div className="text-sm font-medium">Link a channel</div>
				<p className="text-xs text-muted-foreground">
					Connect this agent to one of your channels or a shared-pool bot.
				</p>
				<div className="flex flex-col gap-2 sm:flex-row">
					<Select value={accountId} onValueChange={setAccountId}>
						<SelectTrigger className="flex-1">
							<SelectValue placeholder="Choose a channel…" />
						</SelectTrigger>
						<SelectContent>
							{linkable.map((c) => (
								<SelectItem key={c.id} value={c.id}>
									{providerMeta(c.provider).label} · {c.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						onClick={() => accountId && link.mutate(accountId)}
						disabled={!accountId || link.isPending || channels.isLoading || botPool.isLoading}
					>
						{link.isPending ? <Spinner className="size-3.5" /> : <Link2 className="size-3.5" />}
						Link
					</Button>
				</div>
				{channels.error || botPool.error ? (
					<ChannelError
						error={channels.error ?? botPool.error}
						onRetry={() => {
							channels.refetch();
							botPool.refetch();
						}}
						title="Couldn't load available channels"
					/>
				) : null}
				{token ? (
					<TokenReveal
						label="Agent token"
						value={token}
						note="Copy it now — used by the runtime to send and receive on this channel."
					/>
				) : null}
			</div>

			<p className="text-xs text-muted-foreground">
				Health, activity, and command sync for each channel live on{" "}
				<Link to="/channels" className="underline">
					Channels
				</Link>
				.
			</p>
		</div>
	);
}

function LinkedChannelRow({
	link,
	onUnlink,
	unlinking,
	fallbackAccount,
}: {
	link: AgentChannelLink;
	onUnlink: () => void;
	unlinking: boolean;
	fallbackAccount?: { provider: string; name: string };
}) {
	const pair = useCreatePairCode(link.account_id);
	const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
	// The list-by-agent payload may omit the nested `account`. Fall back to the
	// loaded channels/bot-pool summary, then to the raw account id, so a missing
	// account NEVER white-screens (apps/web/src has no ErrorBoundary).
	const account = link.account ?? fallbackAccount ?? null;
	const provider = account?.provider ?? "";
	const name = account?.name ?? `Channel ${link.account_id.slice(0, 8)}`;
	return (
		<div className="rounded-lg border p-3">
			<div className="flex items-center gap-3">
				<ProviderChip provider={provider} />
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium">{name}</div>
					<div className="text-xs capitalize text-muted-foreground">
						{provider ? `${providerMeta(provider).label} · ${link.status}` : link.status}
					</div>
				</div>
				<Button
					variant="outline"
					size="sm"
					disabled={pair.isPending}
					onClick={() =>
						pair.mutate(
							{ agent_link_id: link.id },
							{ onSuccess: (d) => setCode({ code: d.code, expires_at: d.expires_at }) },
						)
					}
				>
					<QrCode className="size-3.5" />
					Pair code
				</Button>
				<ConfirmAction
					title="Unlink this channel?"
					description={<p>The agent stops sending and receiving on this channel.</p>}
					confirmLabel="Unlink"
					destructive
					onConfirm={onUnlink}
				>
					<Button
						variant="ghost"
						size="icon-sm"
						className="text-muted-foreground hover:text-destructive"
						disabled={unlinking}
						aria-label="Unlink channel"
					>
						<Link2Off className="size-4" />
					</Button>
				</ConfirmAction>
			</div>
			{code ? (
				<div className="mt-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-sm">
					Send <span className="font-mono font-semibold tracking-wider">{code.code}</span> from the
					chat to pair it.
				</div>
			) : null}
		</div>
	);
}

// ── Settings / Compute ───────────────────────────────────────────────────────

function HostedAgentSettingsTab({
	environmentId,
	deployment,
	isPerformance,
	runtime,
}: {
	environmentId: string;
	deployment: HostedDeployment;
	isPerformance: boolean;
	runtime: Runtime;
}) {
	return (
		<div className="flex flex-col gap-10">
			<AgentSettingsPanel environmentId={environmentId} contained={false} />
			<ComputeSettingsSections
				deployment={deployment}
				isPerformance={isPerformance}
				runtime={runtime}
			/>
		</div>
	);
}

function ComputeSettingsSections({
	deployment,
	isPerformance,
	runtime,
}: {
	deployment: HostedDeployment;
	isPerformance: boolean;
	runtime: Runtime;
}) {
	const router = useRouter();
	const lifecycle = useDeploymentLifecycle();
	const del = useDeleteDeployment();
	const setEnabled = useSetAgentEnabled();
	const onboard = useOnboardAgent();
	const plans = usePlans();
	const checkout = useCheckout();
	const portal = usePortal();
	const cancelSubscription = useCancelSubscription();
	const resumeSubscription = useResumeSubscription();
	const runAction = useActionLock();
	const ci = deployment.config_info;
	const canStop = STOPPABLE_STATUSES.has(deployment.status);
	const canStart = STARTABLE_STATUSES.has(deployment.status);
	const canRestart = RESTARTABLE_STATUSES.has(deployment.status);
	const primaryLifecycleAction = canStop ? "stop" : "start";
	const canRunPrimaryLifecycleAction = canStop || canStart;
	const currentSubscription = deployment.compute_subscription;
	const currentBillingTerm = currentSubscription?.billing_term_months ?? 1;
	const [term, setTerm] = useState(currentBillingTerm);
	const envs = ci?.clawdi_cloud_environments ?? {};
	const optionalEnabledCount = OPTIONAL_HOSTED_RUNTIMES.filter((runtimeId) =>
		runtimeIsEnabled(ci, runtimeId),
	).length;
	const runtimePending = setEnabled.isPending || onboard.isPending;
	const perfPlan = useMemo(() => performancePlan(plans.data), [plans.data]);
	const perfOffers = useMemo(() => (perfPlan ? planOffers(perfPlan) : []), [perfPlan]);
	const perfOffer = useMemo(
		() => (perfPlan ? selectOfferForTerm(perfPlan, term) : null),
		[perfPlan, term],
	);
	const currentOffer = useMemo(
		() => (perfPlan ? selectOfferForTerm(perfPlan, currentBillingTerm) : null),
		[perfPlan, currentBillingTerm],
	);
	const subscriptionEndsAt =
		currentSubscription?.cancel_at ?? currentSubscription?.current_period_end ?? null;
	const subscriptionPeriodLabel = shortDate(subscriptionEndsAt);
	const subscriptionCancelPending = !!currentSubscription?.cancel_at_period_end;
	const canChangeBillingTerm =
		isPerformance &&
		!!perfPlan &&
		!!currentSubscription &&
		!subscriptionCancelPending &&
		term !== currentBillingTerm;
	const canUpgrade = !isPerformance && deployment.upgrade_available;
	const upgradeUnavailableMessage = plans.isLoading
		? "Checking Performance availability..."
		: !perfPlan
			? "Performance compute is unavailable right now."
			: deployment.status === "running" || deployment.status === "stopped"
				? "An upgrade may already be pending for this Free agent."
				: "Upgrade is available once this Free agent is running or stopped.";
	useEffect(() => {
		if (!perfOffers.length || perfOffers.some((offer) => offer.billing_term_months === term)) {
			return;
		}
		setTerm(perfOffers[0]?.billing_term_months ?? 1);
	}, [perfOffers, term]);
	useEffect(() => {
		setTerm(currentBillingTerm);
	}, [deployment.id, currentBillingTerm]);

	async function startPerformanceUpgrade() {
		if (!perfPlan) {
			toast.error("Performance unavailable", {
				description: "No Performance compute plan is available right now.",
			});
			return;
		}
		if (!deployment.upgrade_available) {
			toast.error("Upgrade unavailable", {
				description: upgradeUnavailableMessage,
			});
			return;
		}
		try {
			const result = await checkout.mutateAsync({
				plan_slug: perfPlan.slug,
				billing_term_months: term,
				ui_mode: "hosted",
				upgrade_deployment_id: deployment.id,
			});
			if (redirectToCheckout(result.action_url || result.checkout_url)) {
				return;
			}
			toast.error("Couldn’t start upgrade", {
				description: "No checkout URL was returned. Please try again.",
			});
		} catch (error) {
			toast.error("Couldn’t start upgrade", { description: normalizeBillingError(error) });
		}
	}

	async function changeBillingTerm() {
		if (!canChangeBillingTerm) return;
		try {
			const res = await portal.mutateAsync({
				deployment_id: deployment.id,
				flow: "subscription_update_confirm",
				billing_term_months: term,
			});
			if (res.url || res.portal_url) {
				window.location.href = res.url || res.portal_url;
				return;
			}
			toast.message("Subscription update unavailable", {
				description: res.message ?? "Please try again in a moment.",
			});
		} catch (error) {
			toast.error("Couldn’t change billing term", { description: normalizeBillingError(error) });
		}
	}

	async function cancelPerformanceSubscription() {
		try {
			const res = await cancelSubscription.mutateAsync({ deployment_id: deployment.id });
			toast.success("Subscription cancellation scheduled", {
				description: res.current_period_end
					? `Performance stays active until ${shortDate(res.current_period_end)}.`
					: (res.message ?? undefined),
			});
		} catch (error) {
			toast.error("Couldn’t cancel subscription", { description: normalizeBillingError(error) });
		}
	}

	async function resumePerformanceSubscription() {
		try {
			await resumeSubscription.mutateAsync({ deployment_id: deployment.id });
			toast.success("Subscription resumed");
		} catch (error) {
			toast.error("Couldn’t resume subscription", { description: normalizeBillingError(error) });
		}
	}

	return (
		<div className="flex flex-col gap-9">
			<SettingsSection
				title="Runtime availability"
				description="Choose which runtimes are active on this hosted compute."
			>
				<div className="flex flex-col gap-4">
					<LiveNote>
						Codex stays on by default. Optional runtime changes apply live, no restart.
					</LiveNote>
					<div className="flex flex-col">
						{RUNTIMES.map((r, index) => {
							const enabled = runtimeIsEnabled(ci, r.id);
							const isConfigured = runtimeIsConfigured(ci, r.id);
							const isCurrent = r.id === runtime;
							const siblingEnv = envs[r.id];
							const canDisable = runtimeCanDisable(r.id);
							const blockedByPlan =
								canDisable && !isPerformance && !enabled && optionalEnabledCount >= 1;
							return (
								<Fragment key={r.id}>
									{index > 0 ? <Separator /> : null}
									<div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
										<AgentIcon agent={r.id} size="md" />
										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
												{r.label}
												{isCurrent ? <Badge variant="secondary">This agent</Badge> : null}
												{canDisable ? null : <Badge variant="outline">Always on</Badge>}
											</div>
											<div className="text-xs text-muted-foreground">{r.blurb}</div>
										</div>
										<div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
											{!isCurrent && enabled && siblingEnv ? (
												<Button asChild variant="ghost" size="sm">
													<Link
														to="/agents/$id"
														params={{ id: siblingEnv }}
														search={{ source: "on-clawdi" }}
													>
														Open
														<ArrowUpRight className="size-3.5" />
													</Link>
												</Button>
											) : null}
											{!canDisable ? null : isConfigured ? (
												<Switch
													checked={enabled}
													disabled={runtimePending || blockedByPlan}
													onCheckedChange={(next) =>
														setEnabled.mutate({ id: deployment.id, agentType: r.id, enabled: next })
													}
													aria-label={`Toggle ${r.label}`}
												/>
											) : (
												<Button
													size="sm"
													variant="outline"
													disabled={runtimePending || blockedByPlan}
													title={
														blockedByPlan
															? "Performance compute is required to run both runtimes"
															: undefined
													}
													onClick={() => onboard.mutate({ id: deployment.id, agentType: r.id })}
												>
													{onboard.isPending && onboard.variables?.agentType === r.id ? (
														<Spinner className="size-3.5" />
													) : (
														<Plus className="size-3.5" />
													)}
													Add
												</Button>
											)}
										</div>
									</div>
								</Fragment>
							);
						})}
					</div>
					<p className="text-xs text-muted-foreground">
						Codex is always available. Free can add one optional runtime; Performance can add both
						OpenClaw and Hermes.
					</p>
				</div>
			</SettingsSection>

			<SettingsSection
				title="Compute plan"
				description="Compute is shared by every runtime in this deployment."
			>
				<div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
							{isPerformance ? <Zap className="size-4" /> : <Cpu className="size-4" />}
							<span>{isPerformance ? "Performance compute" : "Free compute"}</span>
							<Badge variant="outline" className="font-normal text-muted-foreground">
								Current
							</Badge>
						</div>
						<p className="mt-1 text-xs text-muted-foreground">
							Free uses one active slot per user. Performance uses one subscription per deployment.
						</p>
						{isPerformance && currentSubscription ? (
							<p className="mt-2 text-xs text-muted-foreground">
								{billingTermLabel(currentBillingTerm)}
								{currentOffer ? (
									<>
										{" "}
										· {formatCentsCompact(currentOffer.price_cents)}
										{billingTermSuffix(currentBillingTerm)}
									</>
								) : null}
								{" · "}
								{subscriptionCancelPending ? "Ends" : "Renews"} {subscriptionPeriodLabel}
							</p>
						) : null}
					</div>
					<div className="flex w-full flex-col gap-2 lg:w-auto lg:min-w-64 lg:items-end">
						{!isPerformance && perfPlan ? (
							<div className="text-xs text-muted-foreground sm:text-right">
								<span className="font-medium text-foreground">
									{perfOffer
										? formatCentsCompact(perfOffer.effective_monthly_price_cents)
										: formatCentsCompact(perfPlan.price_cents)}
									/mo
								</span>
								{perfOffer && perfOffer.billing_term_months !== 1 ? (
									<span>
										{" "}
										· billed {formatCentsCompact(perfOffer.price_cents)}
										{billingTermSuffix(perfOffer.billing_term_months)}
									</span>
								) : null}
							</div>
						) : null}
						{!isPerformance ? (
							<div className="flex w-full flex-col gap-2 lg:w-64">
								<TermSwitcher offers={perfOffers} value={term} onChange={setTerm} />
								<Button
									size="sm"
									disabled={plans.isLoading || checkout.isPending || !canUpgrade || !perfPlan}
									onClick={() => runAction(startPerformanceUpgrade)}
								>
									{checkout.isPending ? (
										<Spinner className="size-3.5" />
									) : (
										<Zap className="size-3.5" />
									)}
									Upgrade to Performance
								</Button>
								{canUpgrade ? null : (
									<p className="text-xs text-muted-foreground">{upgradeUnavailableMessage}</p>
								)}
							</div>
						) : (
							<div className="flex w-full flex-col gap-2 lg:w-72">
								<TermSwitcher offers={perfOffers} value={term} onChange={setTerm} />
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={portal.isPending || !canChangeBillingTerm}
									onClick={() => runAction(changeBillingTerm)}
								>
									{portal.isPending && portal.variables?.flow === "subscription_update_confirm" ? (
										<Spinner className="size-3.5" />
									) : (
										<CreditCard className="size-3.5" />
									)}
									Change billing term
								</Button>
								{subscriptionCancelPending ? (
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={resumeSubscription.isPending}
										onClick={() => runAction(resumePerformanceSubscription)}
									>
										{resumeSubscription.isPending ? (
											<Spinner className="size-3.5" />
										) : (
											<RefreshCw className="size-3.5" />
										)}
										Resume subscription
									</Button>
								) : (
									<ConfirmAction
										title="Cancel Performance?"
										description={
											<p>
												This deployment stays on Performance until {subscriptionPeriodLabel}, then
												moves back to Free compute.
											</p>
										}
										confirmLabel="Cancel at period end"
										destructive
										onConfirm={() => runAction(cancelPerformanceSubscription)}
									>
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={cancelSubscription.isPending}
										>
											{cancelSubscription.isPending ? (
												<Spinner className="size-3.5" />
											) : (
												<Link2Off className="size-3.5" />
											)}
											Cancel subscription
										</Button>
									</ConfirmAction>
								)}
								{subscriptionCancelPending ? (
									<p className="text-xs text-muted-foreground">
										Billing term changes are unavailable while cancellation is scheduled.
									</p>
								) : null}
							</div>
						)}
					</div>
				</div>
			</SettingsSection>

			<SettingsSection
				title="Lifecycle"
				description="Restart, stop, or start the whole hosted compute."
			>
				<div className="flex flex-wrap gap-2.5">
					<Button
						variant="outline"
						size="sm"
						disabled={lifecycle.isPending || !canRestart}
						onClick={() => lifecycle.mutate({ id: deployment.id, action: "restart" })}
					>
						{lifecycle.isPending && lifecycle.variables?.action === "restart" ? (
							<Spinner className="size-3.5" />
						) : (
							<RefreshCw className="size-3.5" />
						)}
						Restart
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={lifecycle.isPending || !canRunPrimaryLifecycleAction}
						onClick={() => lifecycle.mutate({ id: deployment.id, action: primaryLifecycleAction })}
					>
						{lifecycle.isPending && lifecycle.variables?.action === primaryLifecycleAction ? (
							<Spinner className="size-3.5" />
						) : null}
						{canStop ? "Stop" : "Start"}
					</Button>
				</div>
			</SettingsSection>

			<SettingsSection
				title="Danger zone"
				description="Tear down this hosted compute and every runtime agent on it."
				tone="danger"
			>
				<div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
					<div>
						<div className="text-sm font-medium">Delete this compute</div>
						<p className="text-xs text-muted-foreground">
							Tears down this deployment and every runtime agent on it. This can’t be undone.
						</p>
					</div>
					<ConfirmAction
						title={`Delete ${deploymentDisplayName(deployment.name)}?`}
						description={
							<p>The hosted runtime and all its agents are torn down. This can’t be undone.</p>
						}
						confirmLabel="Delete compute"
						destructive
						onConfirm={() =>
							del.mutate(deployment.id, { onSuccess: () => void router.navigate({ href: "/" }) })
						}
					>
						<Button
							variant="outline"
							size="sm"
							className="text-destructive"
							disabled={del.isPending}
						>
							<Trash2 className="size-3.5" />
							Delete
						</Button>
					</ConfirmAction>
				</div>
			</SettingsSection>
		</div>
	);
}
