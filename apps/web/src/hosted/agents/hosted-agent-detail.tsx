"use client";

import { isFirstPartyManagedAiProvider } from "@clawdi/shared";
import type { components } from "@clawdi/shared/api";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import {
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
	Sparkles,
	TerminalSquare,
	Trash2,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetAgentBreadcrumbTitle } from "@/components/breadcrumb-title";
import { AgentSourceBadge, agentDisplayName } from "@/components/dashboard/agent-label";
import { AgentSettingsPanel } from "@/components/dashboard/agent-settings-panel";
import { AgentSkillsTab } from "@/components/dashboard/agent-skills-tab";
import type { DetailSectionMeta } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SessionFeed } from "@/components/sessions/session-feed";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { deploymentDisplayName, isCloudEnvId } from "@/hosted/agent-identity";
import {
	useCreateTerminalSession,
	useDeleteDeployment,
	useDeploymentLifecycle,
	useSetAgentAiProvider,
	useSetAgentLanguageTimezone,
} from "@/hosted/agents/deployment-hooks";
import {
	HostedTerminalPanel,
	type HostedTerminalStatus,
} from "@/hosted/agents/hosted-terminal-panel";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import type {
	CheckoutRequest,
	HostedDeployment,
	RebindAgentAiProviderRequest,
} from "@/hosted/billing/contracts";
import {
	LANGUAGE_OPTIONS,
	LANGUAGE_SELECT_ITEMS,
	supportedTimezones,
	TimezoneCombobox,
} from "@/hosted/billing/deploy/language-timezone-controls";
import { billingErrorNormalizer, normalizeBillingError } from "@/hosted/billing/errors";
import { billingTermLabel, billingTermSuffix, formatCentsCompact } from "@/hosted/billing/format";
import {
	checkoutReturnDeploymentId,
	checkoutReturnMarker,
	checkoutReturnWasCanceled,
	useCancelSubscription,
	useCheckout,
	useCheckoutReturnRefresh,
	usePlans,
	usePortal,
	useResumeSubscription,
} from "@/hosted/billing/hooks";
import {
	type IdempotencyAttempt,
	idempotencyAttemptFor,
	idempotencyFingerprint,
	newIdempotencyKey,
} from "@/hosted/billing/idempotency";
import {
	planOffers,
	resolvePerformancePlan,
	selectOfferForTerm,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import {
	type PaymentOutcome,
	StripePaymentForm,
} from "@/hosted/billing/wallet/stripe-payment-form";
import {
	canRestart as canRestartDeployment,
	canStart as canStartDeployment,
	canStop as canStopDeployment,
	deploymentStatusLabel,
	isRunningStatus,
	parseDeploymentStatus,
} from "@/hosted/deployment-status";
import { type HostedRuntime, runtimeConsoleUrl, runtimeDisplayName } from "@/hosted/runtimes";
import { hostedRuntimeStatusView } from "@/hosted/use-hosted-agent-tiles";
import { useAiProviders } from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { AuthBadge, ProviderTypeChip } from "@/hosted/v2/ai-providers/ai-providers-ui";
import {
	dedupeProviderIds,
	firstModelForProvider,
	isManagedProviderId,
	MANAGED_AI_CHOICE,
	MANAGED_PRIMARY_MODEL_FALLBACK,
	MANAGED_PROVIDER_ID,
	modelIdsForProvider,
	normalizeSelectedProviderIds,
	primaryModelProviderId,
	primaryModelRef,
	primaryModelValue,
	providerChoiceFromRef,
	providerRefFromChoice,
} from "@/hosted/v2/ai-providers/model-binding";
import {
	aiProviderRuntimeId,
	buildAiProviderPoolBootstrap,
} from "@/hosted/v2/ai-providers/runtime-bootstrap";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";
import type { AgentChannelLink } from "@/hosted/v2/channels/channel-edit-client";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";
import { ProviderChip, TokenReveal } from "@/hosted/v2/channels/channel-ui";
import {
	useAgentChannelLinks,
	useBotPool,
	useChannels,
	useCreatePairCode,
	useUnlinkAgentChannel,
} from "@/hosted/v2/channels/channels-hooks";
import {
	type AgentSectionId,
	agentSectionHref,
	agentSectionLabel,
	HOSTED_AGENT_SECTION_IDS,
} from "@/lib/agent-routes";
import { toastApiError, unwrap, useApi } from "@/lib/api";
import type { SessionListItem } from "@/lib/api-schemas";
import { formatModelLabel, formatShortDate } from "@/lib/format";
import { sessionListQueryOptions } from "@/lib/session-queries";
import { cn } from "@/lib/utils";

type Runtime = HostedRuntime;
type DeploymentStatus = ReturnType<typeof parseDeploymentStatus>;
type TermChangeConfirmation = {
	clientSecret: string;
	billingTermMonths: number;
};
type HostedAgentTab =
	| "overview"
	| "console"
	| "terminal"
	| "sessions"
	| "skills"
	| "ai"
	| "channels"
	| "settings";
const HOSTED_AGENT_TABS = new Set<HostedAgentTab>([
	"overview",
	"console",
	"terminal",
	"sessions",
	"skills",
	"ai",
	"channels",
	"settings",
]);
const CUSTOM_MODEL_CHOICE = "__custom__";
const UNRESOLVED_PROVIDER_PREFIX = "unresolved:";
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
	skills: {
		description: "Installed in this agent's Agent Project.",
		icon: Sparkles,
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
		description: "Profile, compute, and lifecycle controls.",
		icon: Settings,
	},
};
/** Map an AI provider's auth type to the deploy `ai_provider_auth_kind`. */
function aiAuthKind(provider: { auth: { type: string } }): "api_key" | "codex_oauth" {
	return provider.auth.type === "agent_profile" || provider.auth.type === "oauth_profile"
		? "codex_oauth"
		: "api_key";
}

function parseHostedAgentTab(value: AgentSectionId | string | null): HostedAgentTab | null {
	if (!value) return null;
	return HOSTED_AGENT_SECTION_IDS.includes(value as HostedAgentTab) &&
		HOSTED_AGENT_TABS.has(value as HostedAgentTab)
		? (value as HostedAgentTab)
		: null;
}

function LiveNote({ children }: { children: React.ReactNode }) {
	return (
		<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
			<Info className="size-3.5 shrink-0" />
			{children}
		</p>
	);
}

function isProvisioningStatus(status: DeploymentStatus): boolean {
	return status.kind === "creating" || status.kind === "starting";
}

function provisioningTitle(status: DeploymentStatus): string {
	return status.kind === "starting" ? "Starting your agent..." : "Setting up your agent...";
}

function RestartComputeAction({ deployment }: { deployment: HostedDeployment }) {
	const lifecycle = useDeploymentLifecycle();
	const runAction = useActionLock();
	const status = parseDeploymentStatus(deployment.status);
	const canRestart = canRestartDeployment(status);
	return (
		<ConfirmAction
			title="Restart compute?"
			description={<p>This restarts this hosted agent.</p>}
			confirmLabel="Restart compute"
			onConfirm={() =>
				runAction(async () => {
					await lifecycle.mutateAsync({ id: deployment.id, action: "restart" });
				})
			}
		>
			<Button variant="outline" size="sm" disabled={lifecycle.isPending || !canRestart}>
				{lifecycle.isPending && lifecycle.variables?.action === "restart" ? (
					<Spinner className="size-3.5" />
				) : (
					<RefreshCw className="size-3.5" />
				)}
				Restart compute
			</Button>
		</ConfirmAction>
	);
}

function StartComputeAction({ deployment }: { deployment: HostedDeployment }) {
	const lifecycle = useDeploymentLifecycle();
	const runAction = useActionLock();
	const status = parseDeploymentStatus(deployment.status);
	const canStart = canStartDeployment(status);
	return (
		<Button
			type="button"
			size="sm"
			disabled={lifecycle.isPending || !canStart}
			onClick={() =>
				void runAction(async () => {
					await lifecycle.mutateAsync({ id: deployment.id, action: "start" });
				}).catch(() => undefined)
			}
		>
			{lifecycle.isPending && lifecycle.variables?.action === "start" ? (
				<Spinner className="size-3.5" />
			) : (
				<RefreshCw className="size-3.5" />
			)}
			Start compute
		</Button>
	);
}

function redirectToCheckout(url: string | null | undefined): boolean {
	if (!url) return false;
	window.location.href = url;
	return true;
}

/**
 * Hosted agent detail. A compute (deployment) hosts one selected execution
 * runtime, with one env id, AI provider binding, channel links, sessions, and
 * control UI. Terminal and compute controls attach to that same hosted compute.
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
	const agentQuery = useQuery({
		queryKey: ["agents", environmentId],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/agents/{agent_id}", {
					params: { path: { agent_id: environmentId } },
				}),
			),
		enabled: isCloudEnvId(environmentId),
	});
	const agent = agentQuery.data;
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
	const headerActions =
		activeTab === "skills" ? (
			<Button
				render={<Link to="/skills" search={{ target: environmentId }} />}
				nativeButton={false}
				variant="outline"
				size="sm"
			>
				<Plus />
				Install skills
			</Button>
		) : consoleUrl ? (
			<Button
				render={
					<a
						href={consoleUrl}
						target="_blank"
						rel="noopener noreferrer"
						aria-label={`Open ${runtimeBrowserUiLabel(runtime)}`}
					/>
				}
				nativeButton={false}
				variant="outline"
				size="sm"
			>
				Open {runtimeBrowserUiLabel(runtime)}
				<ExternalLink className="size-3.5" />
			</Button>
		) : null;

	return (
		<div
			data-hosted="true"
			className={cn(
				CENTERED_PAGE_WIDTH_CLASS.page,
				isLiveToolTab
					? "-my-4 flex min-h-[calc(100svh-var(--header-height))] flex-col md:-my-5 md:min-h-[calc(100svh-var(--header-height)-1rem)]"
					: "flex flex-col gap-6 px-4 lg:px-6",
			)}
		>
			{isLiveToolTab ? <h1 className="sr-only">{agentTitle}</h1> : null}
			<section className={isLiveToolTab ? "flex min-h-0 flex-1 flex-col" : "flex flex-col gap-4"}>
				{isLiveToolTab ? null : (
					<PageHeader
						title={activeTabLabel}
						description={activeNavItem.description}
						icon={ActiveTabIcon ? <ActiveTabIcon className="size-4 text-muted-foreground" /> : null}
						status={<AgentSourceBadge source="hosted" compact />}
						actions={headerActions}
					/>
				)}
				<div className={isLiveToolTab ? "flex min-h-0 flex-1 flex-col" : "w-full"}>
					{activeTab === "overview" ? (
						<OverviewTab
							deployment={deployment}
							agent={isCloudEnvId(environmentId) ? agent : null}
							runtime={runtime}
							isPerformance={isPerformance}
							sessions={sessions.data?.items ?? []}
							sessionsLoading={sessions.isLoading}
							sessionsError={sessions.error}
							onRetrySessions={() => sessions.refetch()}
							sessionLink={(session) => scopedSessionLink(session.id)}
						/>
					) : null}
					{activeTab === "console" ? (
						<ConsoleTab deployment={deployment} runtime={runtime} />
					) : null}
					{activeTab === "terminal" ? <TerminalTab deployment={deployment} /> : null}
					{activeTab === "sessions" ? (
						<HostedAgentSessionsTab environmentId={environmentId} />
					) : null}
					{activeTab === "skills" ? (
						agentQuery.error ? (
							<ApiErrorPanel
								error={agentQuery.error}
								onRetry={() => {
									void agentQuery.refetch();
								}}
								title="Couldn't load agent skills"
							/>
						) : (
							<AgentSkillsTab
								agentId={environmentId}
								agentProjectId={agent?.default_project_id}
								isResolvingAgentProject={agentQuery.isLoading && isCloudEnvId(environmentId)}
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
				</div>
			</section>
		</div>
	);
}

function HostedAgentSessionsTab({ environmentId }: { environmentId: string }) {
	const api = useApi();
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(20);

	useEffect(() => {
		setPage(1);
	}, [environmentId]);

	const sessions = useQuery({
		...sessionListQueryOptions(api, { environment_id: environmentId, page, page_size: pageSize }),
		enabled: isCloudEnvId(environmentId),
		placeholderData: keepPreviousData,
	});
	const total = sessions.data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / pageSize));

	useEffect(() => {
		if (sessions.data && page > pageCount) setPage(pageCount);
	}, [page, pageCount, sessions.data]);

	if (sessions.error) {
		return (
			<ApiErrorPanel
				error={sessions.error}
				onRetry={() => sessions.refetch()}
				title="Couldn't load sessions"
			/>
		);
	}

	return (
		<div
			className={cn(
				"space-y-4 transition-opacity",
				sessions.isFetching && !sessions.isLoading ? "opacity-60" : "opacity-100",
			)}
		>
			<SessionFeed
				sessions={sessions.data?.items ?? []}
				isLoading={sessions.isLoading && !sessions.data}
				emptyMessage="No sessions from this agent yet."
				showAgent={false}
				sessionLink={(session) => ({
					to: "/agents/$id/sessions/$sessionId" as const,
					params: { id: environmentId, sessionId: session.id },
				})}
			/>
			{sessions.data ? (
				<DataTablePagination
					page={page}
					pageSize={pageSize}
					total={total}
					onPageChange={setPage}
					onPageSizeChange={(nextPageSize) => {
						setPageSize(nextPageSize);
						setPage(1);
					}}
					pageSizeOptions={[20, 50, 100]}
				/>
			) : null}
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

function RuntimeStatusValue({
	deployment,
	agent,
}: {
	deployment: HostedDeployment;
	agent: components["schemas"]["AgentResponse"] | null | undefined;
}) {
	const status = hostedRuntimeStatusView(deployment, agent);
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<span
				className={cn("inline-flex min-w-0 items-center gap-1.5", status.primary.textClass)}
				title={`Compute ${status.primary.label}`}
			>
				<span
					aria-hidden
					className={cn("inline-block size-1.5 shrink-0 rounded-full", status.primary.dotClass)}
				/>
				<span className="truncate">{status.primary.label}</span>
			</span>
			{status.secondary ? (
				<span
					className={cn("truncate text-xs", status.secondary.textClass)}
					title={status.secondary.tooltip}
				>
					{status.secondary.label}
				</span>
			) : null}
		</div>
	);
}

function OverviewProvisioningPanel({ status }: { status: DeploymentStatus }) {
	return (
		<div className="rounded-xl border border-info-muted bg-info-muted p-5 text-info-muted-foreground">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start">
				<div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-info-muted bg-background">
					<Spinner className="size-5" />
				</div>
				<div className="min-w-0">
					<h2 className="text-sm font-semibold text-foreground">{provisioningTitle(status)}</h2>
					<p className="mt-1 text-sm">
						Hosted compute is being prepared. This usually takes a couple of minutes, and this page
						updates automatically.
					</p>
					<p className="mt-2 text-xs">Current status: {deploymentStatusLabel(status)}.</p>
				</div>
			</div>
		</div>
	);
}

function OverviewFailedPanel({ deployment }: { deployment: HostedDeployment }) {
	const status = parseDeploymentStatus(deployment.status);
	return (
		<div className="rounded-xl border border-destructive-muted bg-destructive-muted p-5 text-destructive-muted-foreground">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex min-w-0 gap-3">
					<div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-destructive-muted bg-background">
						<RefreshCw className="size-5" />
					</div>
					<div className="min-w-0">
						<h2 className="text-sm font-semibold text-foreground">Agent setup failed</h2>
						<p className="mt-1 text-sm">
							Restart the compute to retry startup. Current status: {deploymentStatusLabel(status)}.
						</p>
					</div>
				</div>
				<div className="shrink-0">
					<RestartComputeAction deployment={deployment} />
				</div>
			</div>
		</div>
	);
}

function OverviewTab({
	deployment,
	agent,
	runtime,
	isPerformance,
	sessions,
	sessionsLoading,
	sessionsError,
	onRetrySessions,
	sessionLink,
}: {
	deployment: HostedDeployment;
	agent: components["schemas"]["AgentResponse"] | null | undefined;
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
	const model =
		primaryModelValue(binding?.primary_model) ||
		primaryModelValue(ci?.primary_model) ||
		"Managed default";
	const deploymentStatus = parseDeploymentStatus(deployment.status);
	const deploymentRunning = isRunningStatus(deploymentStatus);
	const sessionsEmptyMessage = deploymentRunning
		? "No sessions from this agent yet."
		: "Sessions appear once your agent is running.";
	return (
		<div className="flex flex-col gap-5">
			{isProvisioningStatus(deploymentStatus) ? (
				<OverviewProvisioningPanel status={deploymentStatus} />
			) : null}
			{deploymentStatus.kind === "failed" ? <OverviewFailedPanel deployment={deployment} /> : null}
			<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
				<StatCard
					label="Status"
					value={<RuntimeStatusValue deployment={deployment} agent={agent} />}
				/>
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
					<ApiErrorPanel
						error={sessionsError}
						onRetry={onRetrySessions}
						title="Couldn't load sessions"
					/>
				) : (
					<SessionFeed
						sessions={sessions}
						isLoading={sessionsLoading}
						emptyMessage={sessionsEmptyMessage}
						emptyVariant="inset"
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
 * Live agent browser UI embedded inline. The deployment's selected runtime UI
 * URL points at owner-only exposure. When the runtime
 * allows dashboard framing, the bridge cookie + WS work in-frame; otherwise
 * the full-screen link is the alternate path.
 */
function ConsoleTab({ deployment, runtime }: { deployment: HostedDeployment; runtime: Runtime }) {
	const status = parseDeploymentStatus(deployment.status);
	const isRunning = isRunningStatus(status);
	const isProvisioning = isProvisioningStatus(status);
	const label = runtimeDisplayName(runtime);
	const browserUiLabel = runtimeBrowserUiLabel(runtime);
	const url = runtimeConsoleUrl(deployment, runtime);

	// Not running yet — the runtime UI and bridge only exist once the agent boots.
	if (!isRunning) {
		return (
			<EmptyState
				icon={MonitorPlay}
				title={isProvisioning ? provisioningTitle(status) : "Compute is not running"}
				description={
					isProvisioning
						? `The live ${browserUiLabel} opens here once your agent is running. This page updates automatically.`
						: `Start the compute to open the live ${browserUiLabel}. Current status: ${deploymentStatusLabel(status).toLowerCase()}.`
				}
				action={canStartDeployment(status) ? <StartComputeAction deployment={deployment} /> : null}
			/>
		);
	}

	// Running, but this runtime hasn't published a UI endpoint.
	if (!url) {
		return (
			<EmptyState
				icon={MonitorPlay}
				title="No Runtime UI URL yet"
				description={`This ${label} runtime is running but hasn't published its browser UI endpoint yet. Check the Overview status shortly or use Terminal while it finishes.`}
			/>
		);
	}

	return (
		<LiveToolFrame
			icon={MonitorPlay}
			title={browserUiLabel}
			action={
				<Button
					render={
						<a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open full screen" />
					}
					nativeButton={false}
					variant="outline"
					size="sm"
					className="hidden sm:inline-flex"
				>
					Open full screen
					<Maximize2 className="size-3.5" />
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
				<Button
					render={
						<a
							href={url}
							target="_blank"
							rel="noopener noreferrer"
							aria-label={`Open ${browserUiLabel}`}
						/>
					}
					nativeButton={false}
					variant="outline"
					size="sm"
				>
					Open {browserUiLabel}
					<Maximize2 className="size-3.5" />
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
						? "bg-success"
						: status === "connecting"
							? "bg-warning"
							: "bg-destructive",
				)}
			/>
			<span>{TERMINAL_STATUS_LABELS[status]}</span>
		</div>
	);
}

function TerminalTab({ deployment }: { deployment: HostedDeployment }) {
	const status = parseDeploymentStatus(deployment.status);
	const isRunning = isRunningStatus(status);
	const isProvisioning = isProvisioningStatus(status);
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
				icon={TerminalSquare}
				title={isProvisioning ? provisioningTitle(status) : "Compute is not running"}
				description={
					isProvisioning
						? "The browser terminal opens once your agent is running. This page updates automatically."
						: `Start the compute to open a deployment shell. Current status: ${deploymentStatusLabel(status).toLowerCase()}.`
				}
				action={canStartDeployment(status) ? <StartComputeAction deployment={deployment} /> : null}
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
						<div className="flex size-11 items-center justify-center rounded-lg border bg-muted/30">
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
			: "border-border hover:bg-muted/50"
	}`;
}

function ProviderOptionSkeleton() {
	return (
		<div className="flex items-center gap-3 rounded-lg border p-4">
			<Skeleton className="size-10 shrink-0 rounded-lg" />
			<div className="min-w-0 flex-1 space-y-2">
				<div className="flex items-center gap-2">
					<Skeleton className="h-4 w-32" />
					<Skeleton className="h-5 w-16 rounded-full" />
				</div>
				<Skeleton className="h-3 w-40" />
			</div>
			<Skeleton className="h-5 w-14 rounded-full" />
		</div>
	);
}

function unresolvedProviderChoice(providerRef: string): string {
	return `${UNRESOLVED_PROVIDER_PREFIX}${providerRef}`;
}

function isUnresolvedProviderChoice(choice: string): boolean {
	return choice.startsWith(UNRESOLVED_PROVIDER_PREFIX);
}

function unresolvedProviderRef(choice: string): string {
	return choice.slice(UNRESOLVED_PROVIDER_PREFIX.length);
}

function agentChoiceFromProviderRef(
	providerRef: string | null | undefined,
	providers: readonly AiProvider[],
): string | null {
	if (!providerRef) return null;
	const choice = providerChoiceFromRef(providerRef, providers);
	if (!choice) return null;
	if (
		choice === MANAGED_AI_CHOICE ||
		providers.some((provider) => provider.provider_id === choice)
	) {
		return choice;
	}
	return unresolvedProviderChoice(providerRef);
}

function agentProviderRefFromChoice(
	choice: string,
	providers: readonly AiProvider[],
): string | null {
	if (isUnresolvedProviderChoice(choice)) return unresolvedProviderRef(choice);
	return providerRefFromChoice(choice, providers);
}

function providerCatalogDescription(provider: AiProvider): string {
	const count = provider.models?.length ?? 0;
	if (count === 0) return provider.base_url.replace(/^https?:\/\//, "");
	if (count === 1) return provider.models?.[0]?.id ?? provider.base_url;
	return `${count} catalog models`;
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
	const customProviders = useMemo(
		() => list.filter((provider) => !isFirstPartyManagedAiProvider(provider)),
		[list],
	);
	// Selected-runtime binding: the deployment owns one runtime in the v2 model.
	const binding = ci?.ai_provider_bindings?.[runtime];
	const legacyProviderRef = binding?.provider_id ?? ci?.ai_provider_id ?? null;
	const rawProviderRefs =
		binding?.provider_ids && binding.provider_ids.length > 0
			? binding.provider_ids
			: legacyProviderRef
				? [legacyProviderRef]
				: [MANAGED_PROVIDER_ID];
	const primaryProviderRef =
		primaryModelProviderId(binding?.primary_model) ??
		legacyProviderRef ??
		rawProviderRefs[0] ??
		MANAGED_PROVIDER_ID;
	const initialPrimaryChoice =
		agentChoiceFromProviderRef(primaryProviderRef, list) ??
		(isManagedProviderId(primaryProviderRef)
			? MANAGED_AI_CHOICE
			: unresolvedProviderChoice(primaryProviderRef));
	const initialProviderChoices = normalizeSelectedProviderIds(
		rawProviderRefs
			.map((providerRef) => agentChoiceFromProviderRef(providerRef, list))
			.filter((choice): choice is string => Boolean(choice)),
		initialPrimaryChoice,
	);
	const currentModel =
		primaryModelValue(binding?.primary_model) ||
		primaryModelValue(ci?.primary_model) ||
		firstModelForProvider(initialPrimaryChoice, list);

	const [selectedProviders, setSelectedProviders] = useState<string[]>(initialProviderChoices);
	const [primaryProviderChoice, setPrimaryProviderChoice] = useState(initialPrimaryChoice);
	const [primaryModel, setPrimaryModel] = useState<string>(
		currentModel || MANAGED_PRIMARY_MODEL_FALLBACK,
	);

	// Re-seed the form only when the server-side binding genuinely changes (the
	// user's own apply completing, or an out-of-band change) — never on a plain
	// background poll. Keyed on the binding identity: identical server truth →
	// same identity → in-progress edits stay untouched; a real change → reset to
	// the new truth. This is React's "adjust state during render" idiom, which
	// replaces an effect that re-ran on every keystroke.
	const bindingIdentity = JSON.stringify([
		initialProviderChoices,
		initialPrimaryChoice,
		currentModel,
	]);
	const [syncedIdentity, setSyncedIdentity] = useState(bindingIdentity);
	if (bindingIdentity !== syncedIdentity) {
		setSyncedIdentity(bindingIdentity);
		setSelectedProviders(initialProviderChoices);
		setPrimaryProviderChoice(initialPrimaryChoice);
		setPrimaryModel(currentModel || MANAGED_PRIMARY_MODEL_FALLBACK);
	}

	const selectedIdentity = JSON.stringify(
		normalizeSelectedProviderIds(selectedProviders, primaryProviderChoice),
	);
	const initialSelectedIdentity = JSON.stringify(initialProviderChoices);
	const dirty =
		selectedIdentity !== initialSelectedIdentity ||
		primaryProviderChoice !== initialPrimaryChoice ||
		primaryModel !== (currentModel || MANAGED_PRIMARY_MODEL_FALLBACK);

	function setPrimaryProvider(choice: string) {
		const previousCatalog = modelIdsForProvider(primaryProviderChoice, list);
		const nextCatalog = modelIdsForProvider(choice, list);
		const fallback = firstModelForProvider(choice, list);
		setPrimaryProviderChoice(choice);
		setSelectedProviders((current) => normalizeSelectedProviderIds(current, choice));
		setPrimaryModel((current) => {
			const trimmed = current.trim();
			if (!trimmed) return fallback || current;
			if (
				previousCatalog.includes(trimmed) &&
				nextCatalog.length > 0 &&
				!nextCatalog.includes(trimmed)
			) {
				return fallback;
			}
			return current;
		});
	}

	function toggleProvider(choice: string) {
		const selected = selectedProviders.includes(choice);
		let next =
			choice === MANAGED_AI_CHOICE && selectedProviders.some(isUnresolvedProviderChoice)
				? [MANAGED_AI_CHOICE]
				: selected
					? selectedProviders.filter((item) => item !== choice)
					: selectedProviders.length === 1 &&
							selectedProviders[0] === MANAGED_AI_CHOICE &&
							choice !== MANAGED_AI_CHOICE
						? [choice]
						: [...selectedProviders, choice];
		if (next.length === 0) next = [choice];
		next = dedupeProviderIds(next);
		setSelectedProviders(next);
		if (!next.includes(primaryProviderChoice)) {
			setPrimaryProvider(next[0] ?? MANAGED_AI_CHOICE);
		}
	}

	function apply() {
		const selectedChoices = normalizeSelectedProviderIds(selectedProviders, primaryProviderChoice);
		const providerRefs = selectedChoices
			.map((choice) => agentProviderRefFromChoice(choice, customProviders))
			.filter((providerId): providerId is string => Boolean(providerId));
		if (providerRefs.length !== selectedChoices.length) {
			toast.error("Provider unavailable", {
				description: "Refresh providers or choose Managed by Clawdi.",
			});
			return;
		}
		const primaryProviderRef =
			agentProviderRefFromChoice(primaryProviderChoice, customProviders) ?? MANAGED_PROVIDER_ID;
		const nextPrimaryModel = primaryModelRef(primaryProviderRef, primaryModel);
		if (!nextPrimaryModel) {
			toast.error("Primary model required", {
				description: "Choose a catalog model or enter a model id.",
			});
			return;
		}
		const primaryProvider = customProviders.find(
			(provider) => provider.provider_id === primaryProviderChoice,
		);
		const customSelectedProviders = selectedChoices
			.filter((choice) => choice !== MANAGED_AI_CHOICE && !isUnresolvedProviderChoice(choice))
			.map((choice) => customProviders.find((provider) => provider.provider_id === choice))
			.filter((provider): provider is AiProvider => Boolean(provider));
		const kind = primaryProvider ? aiAuthKind(primaryProvider) : "managed";
		const body: RebindAgentAiProviderRequest = {
			primary_model: nextPrimaryModel,
			ai_provider_id: primaryProvider ? aiProviderRuntimeId(primaryProvider) : null,
			provider_ids: providerRefs,
			ai_provider_auth_kind: kind,
		};
		if (customSelectedProviders.length > 0) {
			const bootstrapSelectedProvider = primaryProvider ?? customSelectedProviders[0];
			try {
				body.ai_provider_bootstrap = buildAiProviderPoolBootstrap(
					customSelectedProviders,
					bootstrapSelectedProvider.provider_id,
					aiAuthKind(bootstrapSelectedProvider),
				);
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
		setProvider.mutate(
			{ id: deployment.id, agentType: runtime, body },
			{
				onSuccess: () =>
					toast.success("Provider updated", { description: "Updating the runtime…" }),
			},
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<LiveNote>Provider changes apply to the running runtime — no restart.</LiveNote>

			<div className="flex flex-col gap-2">
				<button
					type="button"
					onClick={() => toggleProvider(MANAGED_AI_CHOICE)}
					className={selectableCard(selectedProviders.includes(MANAGED_AI_CHOICE))}
				>
					<div className="flex items-center justify-between gap-2">
						<span className="text-sm font-medium">Managed by Clawdi</span>
						{primaryProviderChoice === MANAGED_AI_CHOICE ? (
							<Badge variant="secondary">Primary</Badge>
						) : selectedProviders.includes(MANAGED_AI_CHOICE) ? (
							<Badge variant="outline">Bound</Badge>
						) : null}
					</div>
					<p className="mt-0.5 text-sm text-muted-foreground">
						Clawdi-managed models, billed from your wallet.
					</p>
				</button>
				{providers.isLoading ? <ProviderOptionSkeleton /> : null}
				{providers.error ? (
					<ApiErrorPanel
						normalizer={billingErrorNormalizer}
						error={providers.error}
						onRetry={() => providers.refetch()}
						title="Couldn't load providers"
					/>
				) : null}
				{selectedProviders.filter(isUnresolvedProviderChoice).map((choice) => (
					<button key={choice} type="button" disabled className={selectableCard(true)}>
						<div className="flex items-center justify-between gap-2">
							<span className="text-sm font-medium">Provider unavailable</span>
							<Badge variant="secondary">In use</Badge>
						</div>
						<p className="mt-0.5 text-sm text-muted-foreground">
							This runtime is bound to {unresolvedProviderRef(choice)}, but that provider could not
							be loaded. Choose Managed by Clawdi to replace it.
						</p>
					</button>
				))}
				{customProviders.map((p) => {
					const selected = selectedProviders.includes(p.provider_id);
					return (
						<button
							key={p.provider_id}
							type="button"
							onClick={() => toggleProvider(p.provider_id)}
							className={`flex items-center gap-3 ${selectableCard(selected)}`}
						>
							<ProviderTypeChip type={p.type} />
							<span className="min-w-0 flex-1">
								<span className="flex items-center gap-2">
									<span className="truncate text-sm font-medium">{p.label ?? p.provider_id}</span>
									<AuthBadge auth={p.auth} />
								</span>
								<span className="block text-xs text-muted-foreground">
									{providerCatalogDescription(p)}
								</span>
							</span>
							{primaryProviderChoice === p.provider_id ? (
								<Badge variant="secondary">Primary</Badge>
							) : selected ? (
								<Badge variant="outline">Bound</Badge>
							) : null}
						</button>
					);
				})}
				<Button
					render={<Link to="/ai-providers" />}
					nativeButton={false}
					variant="ghost"
					size="sm"
					className="justify-start text-muted-foreground"
				>
					<Plus className="size-3.5" />
					Add a provider
				</Button>
			</div>

			<AgentPrimaryModelPicker
				providers={list}
				customProviders={customProviders}
				selectedProviderChoices={normalizeSelectedProviderIds(
					selectedProviders,
					primaryProviderChoice,
				)}
				primaryProviderChoice={primaryProviderChoice}
				primaryModel={primaryModel}
				onPrimaryProviderChange={setPrimaryProvider}
				onPrimaryModelChange={setPrimaryModel}
			/>

			<div className="flex items-center gap-2">
				<Button
					onClick={apply}
					disabled={
						!dirty ||
						setProvider.isPending ||
						(providers.isLoading &&
							selectedProviders.some((choice) => choice !== MANAGED_AI_CHOICE)) ||
						(!!providers.error &&
							selectedProviders.some(
								(choice) => choice !== MANAGED_AI_CHOICE && !isUnresolvedProviderChoice(choice),
							))
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

function AgentPrimaryModelPicker({
	providers,
	customProviders,
	selectedProviderChoices,
	primaryProviderChoice,
	primaryModel,
	onPrimaryProviderChange,
	onPrimaryModelChange,
}: {
	providers: readonly AiProvider[];
	customProviders: readonly AiProvider[];
	selectedProviderChoices: readonly string[];
	primaryProviderChoice: string;
	primaryModel: string;
	onPrimaryProviderChange: (choice: string) => void;
	onPrimaryModelChange: (model: string) => void;
}) {
	const catalogModelIds = modelIdsForProvider(primaryProviderChoice, providers);
	const modelChoice = catalogModelIds.includes(primaryModel) ? primaryModel : CUSTOM_MODEL_CHOICE;
	const primaryProviderItems = [
		...(selectedProviderChoices.includes(MANAGED_AI_CHOICE)
			? [{ value: MANAGED_AI_CHOICE, label: "Managed by Clawdi" }]
			: []),
		...selectedProviderChoices.filter(isUnresolvedProviderChoice).map((choice) => ({
			value: choice,
			label: unresolvedProviderRef(choice),
		})),
		...customProviders
			.filter((provider) => selectedProviderChoices.includes(provider.provider_id))
			.map((provider) => ({
				value: provider.provider_id,
				label: provider.label ?? provider.provider_id,
			})),
	];
	const catalogModelItems = [
		...catalogModelIds.map((model) => ({ value: model, label: formatModelLabel(model) })),
		{ value: CUSTOM_MODEL_CHOICE, label: "Custom model" },
	];
	return (
		<div className="flex max-w-2xl flex-col gap-3 rounded-lg border bg-muted/20 p-3">
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="agent-primary-provider">Primary provider</Label>
					<Select
						items={primaryProviderItems}
						value={primaryProviderChoice}
						onValueChange={(value) => {
							if (value) onPrimaryProviderChange(value);
						}}
					>
						<SelectTrigger id="agent-primary-provider" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{selectedProviderChoices.includes(MANAGED_AI_CHOICE) ? (
								<SelectItem value={MANAGED_AI_CHOICE}>Managed by Clawdi</SelectItem>
							) : null}
							{selectedProviderChoices.filter(isUnresolvedProviderChoice).map((choice) => (
								<SelectItem key={choice} value={choice}>
									{unresolvedProviderRef(choice)}
								</SelectItem>
							))}
							{customProviders
								.filter((provider) => selectedProviderChoices.includes(provider.provider_id))
								.map((provider) => (
									<SelectItem key={provider.provider_id} value={provider.provider_id}>
										{provider.label ?? provider.provider_id}
									</SelectItem>
								))}
						</SelectContent>
					</Select>
				</div>
				{catalogModelIds.length > 0 ? (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="agent-catalog-model">Catalog model</Label>
						<Select
							items={catalogModelItems}
							value={modelChoice}
							onValueChange={(value) => {
								if (!value) return;
								onPrimaryModelChange(value === CUSTOM_MODEL_CHOICE ? "" : value);
							}}
						>
							<SelectTrigger id="agent-catalog-model" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{catalogModelIds.map((model) => (
									<SelectItem key={model} value={model}>
										{formatModelLabel(model)}
									</SelectItem>
								))}
								<SelectItem value={CUSTOM_MODEL_CHOICE}>Custom model</SelectItem>
							</SelectContent>
						</Select>
					</div>
				) : null}
			</div>
			{/* Free-text model id only when the catalog dropdown is on "Custom
			    model" (or the provider has no catalog); otherwise it just
			    duplicates the dropdown selection, so hide it. */}
			{modelChoice === CUSTOM_MODEL_CHOICE ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="agent-primary-model">
						{catalogModelIds.length > 0 ? "Custom model" : "Primary model"}
					</Label>
					<Input
						id="agent-primary-model"
						value={primaryModel}
						onChange={(event) => onPrimaryModelChange(event.target.value)}
						placeholder={
							primaryProviderChoice === MANAGED_AI_CHOICE
								? MANAGED_PRIMARY_MODEL_FALLBACK
								: "model id"
						}
						autoComplete="off"
						spellCheck={false}
					/>
				</div>
			) : null}
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
	const linkInFlightRef = useRef(false);

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
	const linkableItems = linkable.map((channel) => ({
		value: channel.id,
		label: `${providerMeta(channel.provider).label} · ${channel.name}`,
	}));

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
				await api.POST("/v1/channels/{account_id}/agent-links", {
					params: { path: { account_id: channelId } },
					body: { agent_id: environmentId },
				}),
			),
		onSuccess: (data) => {
			if (data.agent_token != null) setToken(data.agent_token);
			setAccountId("");
			qc.invalidateQueries({ queryKey: ["agent-channel-links", environmentId] });
			qc.invalidateQueries({ queryKey: ["channel-agent-links", data.account_id] });
			qc.invalidateQueries({ queryKey: ["channel-bot-pool"] });
			qc.invalidateQueries({ queryKey: ["channels"] });
			toast.success("Channel linked");
		},
		onError: toastApiError("Couldn't link channel"),
	});

	function submitLink() {
		if (!accountId || linkInFlightRef.current) return;
		linkInFlightRef.current = true;
		link.mutate(accountId, {
			onSettled: () => {
				linkInFlightRef.current = false;
			},
		});
	}

	if (!hasEnvironmentId) {
		return (
			<EmptyState
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
					<ApiErrorPanel
						error={linked.error}
						onRetry={() => linked.refetch()}
						title="Couldn't load linked channels"
					/>
				) : (linked.data ?? []).length === 0 ? (
					<EmptyState
						variant="inset"
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
					<Select
						items={linkableItems}
						value={accountId}
						onValueChange={(value) => {
							if (value !== null) setAccountId(value);
						}}
					>
						<SelectTrigger aria-label="Link a channel" className="flex-1">
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
						onClick={submitLink}
						disabled={!accountId || link.isPending || channels.isLoading || botPool.isLoading}
					>
						{link.isPending ? <Spinner className="size-3.5" /> : <Link2 className="size-3.5" />}
						Link
					</Button>
				</div>
				{channels.error || botPool.error ? (
					<ApiErrorPanel
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
			<AgentSettingsPanel environmentId={environmentId} />
			<LanguageTimezoneSettingsSection deployment={deployment} runtime={runtime} />
			<ComputeSettingsSections deployment={deployment} isPerformance={isPerformance} />
		</div>
	);
}

function LanguageTimezoneSettingsSection({
	deployment,
	runtime,
}: {
	deployment: HostedDeployment;
	runtime: Runtime;
}) {
	const setLanguageTimezone = useSetAgentLanguageTimezone();
	const runAction = useActionLock();
	// Generated V2HostedDeploymentDetailsInfo currently exposes no language/timezone fields.
	const configLanguage = "";
	const configTimezone = "";
	const configIdentity = JSON.stringify([deployment.id, configLanguage, configTimezone]);
	const [syncedIdentity, setSyncedIdentity] = useState(configIdentity);
	const [savedLanguage, setSavedLanguage] = useState(configLanguage);
	const [savedTimezone, setSavedTimezone] = useState(configTimezone);
	const [language, setLanguage] = useState(configLanguage);
	const [timezone, setTimezone] = useState(configTimezone);
	if (configIdentity !== syncedIdentity) {
		setSyncedIdentity(configIdentity);
		setSavedLanguage(configLanguage);
		setSavedTimezone(configTimezone);
		setLanguage(configLanguage);
		setTimezone(configTimezone);
	}
	const tzOptions = useMemo(() => {
		const all = supportedTimezones();
		if (timezone && !all.includes(timezone)) return [timezone, ...all];
		return all;
	}, [timezone]);
	const runtimeLabel = runtimeDisplayName(runtime);
	const dirty = language !== savedLanguage || timezone !== savedTimezone;
	const canSave = dirty && !setLanguageTimezone.isPending;

	async function saveLanguageTimezone() {
		if (!canSave) return;
		await setLanguageTimezone.mutateAsync({
			id: deployment.id,
			agentType: runtime,
			language,
			timezone,
		});
		setSavedLanguage(language);
		setSavedTimezone(timezone);
	}

	function resetLanguageTimezone() {
		setLanguage(savedLanguage);
		setTimezone(savedTimezone);
	}

	return (
		<SettingsSection
			title="Language & timezone"
			description="Set locale context for this hosted agent."
		>
			<div className="flex max-w-2xl flex-col gap-4">
				<LiveNote>{`Changes apply live to ${runtimeLabel}.`}</LiveNote>
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="settings-agent-language">Language</Label>
						<Select
							items={LANGUAGE_SELECT_ITEMS}
							value={language || "default"}
							onValueChange={(value) => {
								setLanguage(value === null || value === "default" ? "" : value);
							}}
						>
							<SelectTrigger id="settings-agent-language">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="default">Default</SelectItem>
								{LANGUAGE_OPTIONS.map((option) => (
									<SelectItem key={option.code} value={option.code}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{tzOptions.length > 0 ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="settings-agent-timezone">Timezone</Label>
							<TimezoneCombobox
								id="settings-agent-timezone"
								value={timezone}
								onValueChange={setTimezone}
								options={tzOptions}
							/>
						</div>
					) : null}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						disabled={!canSave}
						onClick={() => void runAction(saveLanguageTimezone).catch(() => undefined)}
					>
						{setLanguageTimezone.isPending ? <Spinner className="size-3.5" /> : null}
						Save changes
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={!dirty || setLanguageTimezone.isPending}
						onClick={resetLanguageTimezone}
					>
						Reset
					</Button>
					{setLanguageTimezone.isPending ? (
						<span className="text-xs text-muted-foreground">Updating runtime settings...</span>
					) : null}
				</div>
			</div>
		</SettingsSection>
	);
}

function ComputeSettingsSections({
	deployment,
	isPerformance,
}: {
	deployment: HostedDeployment;
	isPerformance: boolean;
}) {
	const router = useRouter();
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const lifecycle = useDeploymentLifecycle();
	const del = useDeleteDeployment();
	const plans = usePlans();
	const checkout = useCheckout();
	const refreshCheckoutReturn = useCheckoutReturnRefresh();
	const portal = usePortal();
	const cancelSubscription = useCancelSubscription();
	const resumeSubscription = useResumeSubscription();
	const runAction = useActionLock();
	const checkoutAttemptRef = useRef<IdempotencyAttempt | null>(null);
	const checkoutReturnRef = useRef<string | null>(null);
	const deploymentStatus = parseDeploymentStatus(deployment.status);
	const canStop = canStopDeployment(deploymentStatus);
	const canStart = canStartDeployment(deploymentStatus);
	const canRestart = canRestartDeployment(deploymentStatus);
	const primaryLifecycleAction: "stop" | "start" = canStop ? "stop" : "start";
	const canRunPrimaryLifecycleAction = canStop || canStart;
	const currentSubscription = deployment.compute_subscription;
	const currentBillingTerm = currentSubscription?.billing_term_months ?? 1;
	const [term, setTerm] = useState(currentBillingTerm);
	const [termChangeConfirmation, setTermChangeConfirmation] =
		useState<TermChangeConfirmation | null>(null);
	const perfPlan = useMemo(() => resolvePerformancePlan(plans.data), [plans.data]);
	const perfOffers = useMemo(() => (perfPlan ? planOffers(perfPlan) : []), [perfPlan]);
	const perfOfferSelection = useMemo(
		() => (perfPlan ? selectOfferForTerm(perfPlan, term) : null),
		[perfPlan, term],
	);
	const perfOffer = perfOfferSelection?.offer ?? null;
	const selectedBillingTerm = perfOfferSelection?.billingTermMonths ?? term;
	const currentOfferSelection = useMemo(
		() => (perfPlan ? selectOfferForTerm(perfPlan, currentBillingTerm) : null),
		[perfPlan, currentBillingTerm],
	);
	const currentOffer =
		currentOfferSelection?.billingTermMonths === currentBillingTerm
			? currentOfferSelection.offer
			: null;
	const currentPriceCents =
		typeof currentSubscription?.price_cents === "number"
			? currentSubscription.price_cents
			: (currentOffer?.price_cents ?? null);
	const subscriptionEndsAt =
		currentSubscription?.cancel_at ?? currentSubscription?.current_period_end ?? null;
	const subscriptionPeriodLabel = formatShortDate(subscriptionEndsAt);
	const subscriptionCancelPending = !!currentSubscription?.cancel_at_period_end;
	const canChangeBillingTerm =
		isPerformance &&
		!!perfPlan &&
		!!perfOfferSelection &&
		!!currentSubscription &&
		!subscriptionCancelPending &&
		selectedBillingTerm !== currentBillingTerm;
	const canUpgrade = !isPerformance && deployment.upgrade_available;
	const upgradeUnavailableMessage = plans.isLoading
		? "Checking Performance availability..."
		: !perfPlan
			? "Performance compute is unavailable right now."
			: isRunningStatus(deploymentStatus) || deploymentStatus.kind === "stopped"
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
	useEffect(() => {
		const marker = checkoutReturnMarker(searchStr);
		if (!marker || checkoutReturnRef.current === marker) return;
		checkoutReturnRef.current = marker;
		void refreshCheckoutReturn().then(() => {
			if (checkoutReturnWasCanceled(searchStr)) {
				toast.message("Checkout canceled", {
					description: "You were not charged. Your compute plan is unchanged.",
				});
				return;
			}
			const deploymentId = checkoutReturnDeploymentId(searchStr);
			if (deploymentId && deploymentId !== deployment.id) {
				void router.navigate({
					href: agentSectionHref(deploymentId, "overview", "source=on-clawdi"),
					replace: true,
				});
				return;
			}
			toast.message("Checkout status refreshed", {
				description: "We checked your deployments, subscription, and wallet.",
			});
		});
	}, [deployment.id, refreshCheckoutReturn, router, searchStr]);

	async function startPerformanceUpgrade() {
		if (!perfPlan || !perfOfferSelection) {
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
			const body: CheckoutRequest = {
				plan_slug: perfPlan.slug,
				billing_term_months: perfOfferSelection.billingTermMonths,
				ui_mode: "hosted",
				upgrade_deployment_id: deployment.id,
			};
			checkoutAttemptRef.current = idempotencyAttemptFor(
				checkoutAttemptRef.current,
				"subscription-upgrade",
				idempotencyFingerprint(body),
				newIdempotencyKey,
			);
			const result = await checkout.mutateAsync({
				body,
				idempotencyKey: checkoutAttemptRef.current.key,
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
				billing_term_months: selectedBillingTerm,
			});
			if (res.payment_intent_client_secret) {
				setTermChangeConfirmation({
					clientSecret: res.payment_intent_client_secret,
					billingTermMonths: selectedBillingTerm,
				});
				return;
			}
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

	function completeBillingTermConfirmation(status: PaymentOutcome) {
		setTermChangeConfirmation(null);
		void refreshCheckoutReturn().catch(() => undefined);
		toast.success(
			status === "succeeded" ? "Billing term update confirmed" : "Billing term update processing",
			{
				description:
					status === "succeeded"
						? "We refreshed your compute subscription details."
						: "We will refresh your compute subscription details once the payment settles.",
			},
		);
	}

	async function cancelPerformanceSubscription() {
		try {
			const res = await cancelSubscription.mutateAsync({ deployment_id: deployment.id });
			toast.success("Subscription cancellation scheduled", {
				description: res.current_period_end
					? `Performance stays active until ${formatShortDate(res.current_period_end)}.`
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

	async function runLifecycleAction(action: "restart" | "stop" | "start") {
		await lifecycle.mutateAsync({ id: deployment.id, action });
	}

	async function deleteCompute() {
		await del.mutateAsync(deployment.id);
		await router.navigate({ href: "/" });
	}

	return (
		<div className="flex flex-col gap-9">
			<Dialog
				open={termChangeConfirmation !== null}
				onOpenChange={(open) => {
					if (!open) setTermChangeConfirmation(null);
				}}
			>
				<DialogContent className="sm:max-w-md" data-hosted="true">
					<DialogHeader>
						<DialogTitle>Confirm billing term change</DialogTitle>
						<DialogDescription>
							Complete your bank confirmation to switch this compute to{" "}
							{billingTermLabel(
								termChangeConfirmation?.billingTermMonths ?? selectedBillingTerm,
							).toLowerCase()}
							.
						</DialogDescription>
					</DialogHeader>
					{termChangeConfirmation ? (
						<StripePaymentForm
							clientSecret={termChangeConfirmation.clientSecret}
							onComplete={completeBillingTermConfirmation}
							onCancel={() => setTermChangeConfirmation(null)}
						/>
					) : null}
				</DialogContent>
			</Dialog>

			<SettingsSection title="Compute plan" description="Compute resources for this hosted agent.">
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
								{currentPriceCents !== null ? (
									<>
										{" "}
										· {formatCentsCompact(currentPriceCents)}
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
								<TermSwitcher offers={perfOffers} value={selectedBillingTerm} onChange={setTerm} />
								<Button
									size="sm"
									disabled={
										plans.isLoading ||
										checkout.isPending ||
										!canUpgrade ||
										!perfPlan ||
										!perfOfferSelection
									}
									onClick={() => void runAction(startPerformanceUpgrade).catch(() => undefined)}
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
								<TermSwitcher offers={perfOffers} value={selectedBillingTerm} onChange={setTerm} />
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={portal.isPending || !canChangeBillingTerm}
									onClick={() => void runAction(changeBillingTerm).catch(() => undefined)}
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
										onClick={() =>
											void runAction(resumePerformanceSubscription).catch(() => undefined)
										}
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
					<ConfirmAction
						title="Restart compute?"
						description={<p>This restarts this hosted agent.</p>}
						confirmLabel="Restart compute"
						onConfirm={() => runAction(() => runLifecycleAction("restart"))}
					>
						<Button variant="outline" size="sm" disabled={lifecycle.isPending || !canRestart}>
							{lifecycle.isPending && lifecycle.variables?.action === "restart" ? (
								<Spinner className="size-3.5" />
							) : (
								<RefreshCw className="size-3.5" />
							)}
							Restart
						</Button>
					</ConfirmAction>
					{canStop ? (
						<ConfirmAction
							title="Stop compute?"
							description={
								<p>
									This stops the hosted agent. Runtime UI, terminal access, sessions, and channels
									pause until you start it again.
								</p>
							}
							confirmLabel="Stop compute"
							onConfirm={() => runAction(() => runLifecycleAction("stop"))}
						>
							<Button
								variant="outline"
								size="sm"
								disabled={lifecycle.isPending || !canRunPrimaryLifecycleAction}
							>
								{lifecycle.isPending && lifecycle.variables?.action === "stop" ? (
									<Spinner className="size-3.5" />
								) : null}
								Stop
							</Button>
						</ConfirmAction>
					) : (
						<Button
							variant="outline"
							size="sm"
							disabled={lifecycle.isPending || !canRunPrimaryLifecycleAction}
							onClick={() =>
								void runAction(() => runLifecycleAction(primaryLifecycleAction)).catch(
									() => undefined,
								)
							}
						>
							{lifecycle.isPending && lifecycle.variables?.action === primaryLifecycleAction ? (
								<Spinner className="size-3.5" />
							) : null}
							Start
						</Button>
					)}
				</div>
			</SettingsSection>

			<SettingsSection
				title="Danger zone"
				description="Tear down this hosted compute and its agent runtime."
				variant="destructive"
			>
				<div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
					<div>
						<div className="text-sm font-medium">Delete this compute</div>
						<p className="text-xs text-muted-foreground">
							Tears down this deployment and its agent runtime. This can’t be undone.
						</p>
					</div>
					<ConfirmAction
						title={`Delete ${deploymentDisplayName(deployment.name)}?`}
						description={<p>The hosted agent is torn down. This can’t be undone.</p>}
						confirmLabel="Delete compute"
						destructive
						onConfirm={() => runAction(deleteCompute)}
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
