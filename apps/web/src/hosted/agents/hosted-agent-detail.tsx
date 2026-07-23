"use client";

import { isFirstPartyManagedAiProvider } from "@clawdi/shared";
import type { components } from "@clawdi/shared/api";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import {
	AlertCircle,
	Cpu,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
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
} from "@/hosted/agents/deployment-hooks";
import {
	HostedTerminalPanel,
	type HostedTerminalStatus,
} from "@/hosted/agents/hosted-terminal-panel";
import {
	type HermesUiCredentials,
	hermesUiCredentials,
	openClawUiUrl,
} from "@/hosted/agents/runtime-ui-credentials";
import { useBillingClient } from "@/hosted/billing/billing-client";
import { ComputeDunningBanner } from "@/hosted/billing/components/compute-dunning-banner";
import type {
	ComputePlanChangeQuoteRequest,
	ComputePlanChangeQuoteResponse,
	HostedDeployment,
} from "@/hosted/billing/contracts";
import { LANGUAGE_OPTIONS } from "@/hosted/billing/deploy/language-timezone-controls";
import {
	billingErrorDetail,
	billingErrorNormalizer,
	normalizeBillingError,
} from "@/hosted/billing/errors";
import { billingTermLabel, billingTermSuffix, formatCentsCompact } from "@/hosted/billing/format";
import {
	checkoutReturnDeploymentId,
	checkoutReturnMarker,
	checkoutReturnWasCanceled,
	useCancelSubscription,
	useChangePlan,
	useCheckoutReturnRefresh,
	usePlans,
	useQuotePlanChange,
	useResumeSubscription,
	useWallet,
} from "@/hosted/billing/hooks";
import {
	type PlanChangeSelection,
	planChangeUnavailableReason,
} from "@/hosted/billing/subscription/plan-change.logic";
import { PlanChangeDialog } from "@/hosted/billing/subscription/plan-change-dialog";
import { SubscriptionCreateDialog } from "@/hosted/billing/subscription/subscription-create-dialog";
import {
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	computeFundingMode,
	computeFundingSource,
	computeSubscriptionId,
	computeSubscriptionLifecycle,
	computeTierLabel,
	isComputeSubscriptionCancelable,
	pendingComputePlanSlug,
	pendingPlanScheduleCopy,
	resolveBasicPlan,
	resolvePerformancePlan,
	resolveSubscriptionCreatePlanSlug,
	selectExplicitOfferForTerm,
	selectOfferForTerm,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { topUpAmountCentsForCreditShortfall } from "@/hosted/billing/wallet/top-up-dialog.logic";
import { deploymentFailureReason } from "@/hosted/deployment-failure";
import {
	canRestart as canRestartDeployment,
	canStart as canStartDeployment,
	canStop as canStopDeployment,
	deploymentStatusLabel,
	isRunningStatus,
	parseDeploymentStatus,
} from "@/hosted/deployment-status";
import {
	canOpenHostedRuntimeUi,
	type HostedProjectionResolution,
	missingProjectionRefetchInterval,
	resolveHostedAgentProjection,
} from "@/hosted/hosted-agent-resolution";
import {
	type HostedRuntime,
	runtimeAiProviderAuthKind,
	runtimeConsoleUrl,
	runtimeDisplayName,
} from "@/hosted/runtimes";
import { hostedRuntimeStatusView } from "@/hosted/use-hosted-agent-tiles";
import { useAiProviders } from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { AuthBadge, ProviderTypeChip } from "@/hosted/v2/ai-providers/ai-providers-ui";
import { authCardLabel } from "@/hosted/v2/ai-providers/auth-card-label";
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
	primaryModelValue,
	providerChoiceFromRef,
} from "@/hosted/v2/ai-providers/model-binding";
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
import { formatMemoryMib, formatModelLabel, formatShortDate } from "@/lib/format";
import { useHostedProductAccess } from "@/lib/hosted-product-access";
import { sessionListQueryOptions } from "@/lib/session-queries";
import { cn } from "@/lib/utils";

type Runtime = HostedRuntime;
type AiBindingMode = "unmanaged" | "configured";
type DeploymentStatus = ReturnType<typeof parseDeploymentStatus>;
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
	return status.kind === "starting" ? "Starting your agent…" : "Setting up your agent…";
}

function RestartComputeAction({
	deployment,
	label = "Restart compute",
}: {
	deployment: HostedDeployment;
	label?: string;
}) {
	const lifecycle = useDeploymentLifecycle();
	const runAction = useActionLock();
	const status = parseDeploymentStatus(deployment.resource.status.summary_state);
	const canRestart = canRestartDeployment(status);
	return (
		<ConfirmAction
			title="Restart compute?"
			description={<p>This restarts this hosted agent.</p>}
			confirmLabel={label}
			onConfirm={() =>
				runAction(async () => {
					await lifecycle.mutateAsync({ id: deployment.resource.id, action: "restart" });
				})
			}
		>
			<Button variant="outline" size="sm" disabled={lifecycle.isPending || !canRestart}>
				{lifecycle.isPending && lifecycle.variables?.action === "restart" ? (
					<Spinner className="size-3.5" />
				) : (
					<RefreshCw className="size-3.5" />
				)}
				{label}
			</Button>
		</ConfirmAction>
	);
}

function DeleteComputeAction({ deployment }: { deployment: HostedDeployment }) {
	const router = useRouter();
	const deleteDeployment = useDeleteDeployment();
	const runAction = useActionLock();
	return (
		<ConfirmAction
			title={`Delete ${deploymentDisplayName(deployment.resource.spec.name)}?`}
			description={<p>The hosted agent is torn down. This can’t be undone.</p>}
			confirmLabel="Delete compute"
			destructive
			onConfirm={() =>
				runAction(async () => {
					await deleteDeployment.mutateAsync(deployment.resource.id);
					await router.navigate({ href: "/" });
				})
			}
		>
			<Button type="button" variant="destructive" size="sm" disabled={deleteDeployment.isPending}>
				{deleteDeployment.isPending ? <Spinner /> : <Trash2 />}
				Delete
			</Button>
		</ConfirmAction>
	);
}

function StartComputeAction({ deployment }: { deployment: HostedDeployment }) {
	const lifecycle = useDeploymentLifecycle();
	const runAction = useActionLock();
	const status = parseDeploymentStatus(deployment.resource.status.summary_state);
	const canStart = canStartDeployment(status);
	return (
		<Button
			type="button"
			size="sm"
			disabled={lifecycle.isPending || !canStart}
			onClick={() =>
				void runAction(async () => {
					await lifecycle.mutateAsync({ id: deployment.resource.id, action: "start" });
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

function planChangeBillingTerm(
	value: number,
): ComputePlanChangeQuoteRequest["target_billing_term_months"] {
	return value === 12 ? 12 : 1;
}

function decimalCredits(value: unknown): number | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
	const deploymentStatus = parseDeploymentStatus(deployment.resource.status.summary_state);
	const deploymentRunning = isRunningStatus(deploymentStatus);
	const cloudEnvironmentId = isCloudEnvId(environmentId);
	const agentQuery = useQuery({
		queryKey: ["agents", environmentId],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/agents/{agent_id}", {
					params: { path: { agent_id: environmentId } },
				}),
			),
		enabled: cloudEnvironmentId,
		refetchInterval: (query) =>
			missingProjectionRefetchInterval(
				query.state.error,
				deployment.resource.status.summary_state,
				query.state.fetchFailureCount,
			),
		refetchIntervalInBackground: false,
	});
	const projection = resolveHostedAgentProjection({
		enabled: cloudEnvironmentId,
		data: agentQuery.data,
		error: agentQuery.error,
		isPending: agentQuery.isPending,
	});
	const agent = projection.status === "resolved" ? projection.data : null;
	const name = agent
		? agentDisplayName(agent)
		: deploymentDisplayName(deployment.resource.spec.name);
	const runtimeLabel = runtimeDisplayName(runtime);
	const agentTitle = name === runtimeLabel ? name : `${name} · ${runtimeLabel}`;
	const activeTab = parseHostedAgentTab(section) ?? "overview";
	useSetAgentBreadcrumbTitle({
		agentId: environmentId,
		agentTitle,
		section: activeTab,
	});

	const isPerformance = deployment.current_plan_slug === COMPUTE_PERFORMANCE_SLUG;
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
		enabled: deploymentRunning && projection.status === "resolved",
	});

	const activeNavItem = HOSTED_AGENT_NAV_META[activeTab];
	const activeTabLabel = agentSectionLabel(activeTab);
	const ActiveTabIcon = activeNavItem.icon;
	const isLiveToolTab = activeTab === "console" || activeTab === "terminal";
	const headerActions =
		activeTab === "skills" && projection.status === "resolved" ? (
			<Button
				render={<Link to="/skills" search={{ target: environmentId }} />}
				nativeButton={false}
				variant="outline"
				size="sm"
			>
				<Plus />
				Install skills
			</Button>
		) : runtime === "openclaw" &&
			consoleUrl &&
			canOpenHostedRuntimeUi(deployment.resource.status.summary_state, consoleUrl) ? (
			<RuntimeUiOpenButton
				deployment={deployment}
				endpointUrl={consoleUrl}
				label={runtimeBrowserUiLabel(runtime)}
				variant="outline"
				size="sm"
			>
				Open {runtimeBrowserUiLabel(runtime)}
				<ExternalLink className="size-3.5" />
			</RuntimeUiOpenButton>
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
				{isLiveToolTab ? null : <ComputeDunningBanner deployment={deployment} />}
				<HostedProjectionNotice
					projection={projection}
					isFetching={agentQuery.isFetching}
					onRetry={() => {
						void agentQuery.refetch();
					}}
				/>
				<div className={isLiveToolTab ? "flex min-h-0 flex-1 flex-col" : "w-full"}>
					{activeTab === "overview" ? (
						<OverviewTab
							deployment={deployment}
							agent={isCloudEnvId(environmentId) ? agent : null}
							isPerformance={isPerformance}
							showDeploymentActions={projection.status !== "resolved" || !deploymentRunning}
							projectionAvailable={projection.status === "resolved"}
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
						projection.status === "resolved" ? (
							<HostedAgentSessionsTab environmentId={environmentId} />
						) : (
							<ProjectionDependentUnavailable label="Sessions" />
						)
					) : null}
					{activeTab === "skills" ? (
						projection.status === "resolved" ? (
							<AgentSkillsTab
								agentId={environmentId}
								agentProjectId={agent?.default_project_id}
								isResolvingAgentProject={false}
							/>
						) : (
							<ProjectionDependentUnavailable label="Skills" />
						)
					) : null}
					{activeTab === "ai" ? <AiProviderTab deployment={deployment} runtime={runtime} /> : null}
					{activeTab === "channels" ? (
						projection.status === "resolved" ? (
							<ChannelsTab environmentId={environmentId} />
						) : (
							<ProjectionDependentUnavailable label="Channels" />
						)
					) : null}
					{activeTab === "settings" ? (
						<HostedAgentSettingsTab
							environmentId={environmentId}
							deployment={deployment}
							runtime={runtime}
							projectionAvailable={projection.status === "resolved"}
						/>
					) : null}
				</div>
			</section>
		</div>
	);
}

function HostedProjectionNotice({
	projection,
	isFetching,
	onRetry,
}: {
	projection: HostedProjectionResolution<components["schemas"]["AgentResponse"]>;
	isFetching: boolean;
	onRetry: () => void;
}) {
	if (projection.status === "resolved") return null;
	if (projection.status === "error") {
		return (
			<ApiErrorPanel
				error={projection.error}
				onRetry={onRetry}
				title="Agent sync service unavailable"
			/>
		);
	}
	if (projection.status === "missing") {
		return (
			<Alert data-hosted="true">
				<AlertCircle />
				<AlertTitle>Agent sync record unavailable</AlertTitle>
				<AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<span>
						Deployment controls remain available; Runtime UI and Terminal continue to follow
						deployment status. Sessions, skills, profile, and channels will recover when the cloud
						projection catches up.
					</span>
					<Button type="button" variant="outline" size="sm" disabled={isFetching} onClick={onRetry}>
						{isFetching ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
						Check again
					</Button>
				</AlertDescription>
			</Alert>
		);
	}
	if (projection.status === "loading") {
		return (
			<Alert data-hosted="true">
				<Spinner className="size-4" />
				<AlertTitle>Loading synced agent data</AlertTitle>
				<AlertDescription>
					Deployment-owned controls are ready while the cloud projection resolves.
				</AlertDescription>
			</Alert>
		);
	}
	return (
		<Alert data-hosted="true">
			<AlertCircle />
			<AlertTitle>Agent sync identity pending</AlertTitle>
			<AlertDescription>
				This deployment has not published an agent identity yet. Deployment controls remain
				available while provisioning continues.
			</AlertDescription>
		</Alert>
	);
}

function ProjectionDependentUnavailable({ label }: { label: string }) {
	return (
		<EmptyState
			title={`${label} unavailable`}
			description="This section depends on the synced agent record. Deployment-owned controls remain available."
		/>
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
	const status = hostedRuntimeStatusView(deployment.resource.status, agent);
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

function DeploymentFailureReasonText({ reason }: { reason: string }) {
	return <p className="mt-2 whitespace-pre-wrap break-words font-mono text-xs">{reason}</p>;
}

function OverviewFailedPanel({
	deployment,
	restartLabel = "Restart compute",
}: {
	deployment: HostedDeployment;
	restartLabel?: string;
}) {
	const status = parseDeploymentStatus(deployment.resource.status.summary_state);
	const failureReason = deploymentFailureReason(deployment.resource.status);
	if (failureReason) {
		return (
			<Alert data-hosted="true" variant="destructive">
				<AlertCircle className="size-4" />
				<AlertTitle>Agent setup failed</AlertTitle>
				<AlertDescription className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
					<div className="min-w-0">
						<p>
							Restart the compute to retry startup. Current status: {deploymentStatusLabel(status)}.
						</p>
						<DeploymentFailureReasonText reason={failureReason} />
					</div>
					<div className="shrink-0">
						<RestartComputeAction deployment={deployment} label={restartLabel} />
					</div>
				</AlertDescription>
			</Alert>
		);
	}
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
					<RestartComputeAction deployment={deployment} label={restartLabel} />
				</div>
			</div>
		</div>
	);
}

function OverviewTab({
	deployment,
	agent,
	isPerformance,
	showDeploymentActions,
	projectionAvailable,
	sessions,
	sessionsLoading,
	sessionsError,
	onRetrySessions,
	sessionLink,
}: {
	deployment: HostedDeployment;
	agent: components["schemas"]["AgentResponse"] | null | undefined;
	isPerformance: boolean;
	showDeploymentActions: boolean;
	projectionAvailable: boolean;
	sessions: SessionListItem[];
	sessionsLoading: boolean;
	sessionsError: unknown;
	onRetrySessions: () => void;
	sessionLink: (session: SessionListItem) => {
		to: "/agents/$id/sessions/$sessionId";
		params: { id: string; sessionId: string };
	};
}) {
	const spec = deployment.resource.spec;
	const model = spec.runtime_configuration.primary_model?.model || "Managed default";
	const deploymentStatus = parseDeploymentStatus(deployment.resource.status.summary_state);
	const deploymentRunning = isRunningStatus(deploymentStatus);
	const sessionsEmptyMessage = deploymentRunning
		? "No sessions from this agent yet."
		: "Sessions appear once your agent is running.";
	return (
		<div className="flex flex-col gap-5">
			{isProvisioningStatus(deploymentStatus) ? (
				<OverviewProvisioningPanel status={deploymentStatus} />
			) : null}
			{deploymentStatus.kind === "failed" ? (
				<OverviewFailedPanel deployment={deployment} restartLabel="Retry startup" />
			) : null}
			<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
				<StatCard
					label="Status"
					value={<RuntimeStatusValue deployment={deployment} agent={agent} />}
				/>
				<StatCard label="Compute" value={isPerformance ? "Performance" : "Basic"} />
				<StatCard label="Model" value={model} />
				<StatCard
					label="Resources"
					value={`${spec.resources.vcpu} vCPU · ${formatMemoryMib(spec.resources.memory_mib)}`}
				/>
			</div>
			<div>
				<div className="mb-2 text-sm font-medium">Recent sessions</div>
				{!projectionAvailable ? (
					<EmptyState
						variant="inset"
						title="Sessions unavailable"
						description="Sessions depend on the synced agent record and will recover when it becomes available."
					/>
				) : sessionsError ? (
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
			{showDeploymentActions ? <OverviewDeploymentActions deployment={deployment} /> : null}
		</div>
	);
}

function OverviewDeploymentActions({ deployment }: { deployment: HostedDeployment }) {
	const status = parseDeploymentStatus(deployment.resource.status.summary_state);
	const failed = status.kind === "failed";
	return (
		<SettingsSection
			title="Deployment actions"
			description="Manage hosted compute independently of synced agent data."
		>
			<div className="flex flex-wrap gap-2.5">
				{canRestartDeployment(status) && !failed ? (
					<RestartComputeAction deployment={deployment} />
				) : null}
				{canStartDeployment(status) && !failed ? (
					<StartComputeAction deployment={deployment} />
				) : null}
				<DeleteComputeAction deployment={deployment} />
			</div>
		</SettingsSection>
	);
}

// ── Runtime UI ───────────────────────────────────────────────────────────────

function RuntimeUiOpenButton({
	deployment,
	endpointUrl,
	label,
	children,
	className,
	variant = "outline",
	size = "sm",
}: {
	deployment: HostedDeployment;
	endpointUrl: string;
	label: string;
	children: React.ReactNode;
	className?: string;
	variant?: React.ComponentProps<typeof Button>["variant"];
	size?: React.ComponentProps<typeof Button>["size"];
}) {
	const client = useBillingClient();
	const [isPending, setIsPending] = useState(false);
	const openUi = useCallback(async () => {
		const popup = window.open("", "_blank");
		if (!popup) {
			toast.error("Couldn't open runtime UI", {
				description: "Your browser blocked the new window.",
			});
			return;
		}
		setIsPending(true);
		try {
			const credentials = await client.getRuntimeUiCredentials(deployment.resource.id);
			const url = openClawUiUrl(credentials, endpointUrl);
			if (!url) throw new Error("Runtime UI credential response was invalid");
			popup.location.replace(url);
		} catch {
			popup.close();
			toast.error("Couldn't open runtime UI", { description: "Please try again." });
		} finally {
			setIsPending(false);
		}
	}, [client, deployment.resource.id, endpointUrl]);

	return (
		<Button
			type="button"
			variant={variant}
			size={size}
			className={className}
			disabled={isPending}
			aria-label={`Open ${label}`}
			onClick={() => void openUi()}
		>
			{isPending ? <Spinner className="size-3.5" /> : null}
			{children}
		</Button>
	);
}

/**
 * Native runtime dashboards are top-level only. Hermes exposes explicit Basic
 * credentials; OpenClaw receives its official token handoff in the URL fragment.
 */
function ConsoleTab({ deployment, runtime }: { deployment: HostedDeployment; runtime: Runtime }) {
	const status = parseDeploymentStatus(deployment.resource.status.summary_state);
	const isRunning = isRunningStatus(status);
	const isProvisioning = isProvisioningStatus(status);
	const label = runtimeDisplayName(runtime);
	const browserUiLabel = runtimeBrowserUiLabel(runtime);
	const url = runtimeConsoleUrl(deployment, runtime);
	const client = useBillingClient();
	const [credentials, setCredentials] = useState<HermesUiCredentials | null>(null);
	const [credentialError, setCredentialError] = useState<Error | null>(null);
	const [isLoadingCredentials, setIsLoadingCredentials] = useState(false);
	const loadHermesCredentials = useCallback(async () => {
		if (!url) return;
		setIsLoadingCredentials(true);
		setCredentialError(null);
		try {
			const response = await client.getRuntimeUiCredentials(deployment.resource.id);
			const resolved = hermesUiCredentials(response, url);
			if (!resolved) throw new Error("Runtime UI credential response was invalid");
			setCredentials(resolved);
		} catch (error) {
			setCredentialError(error instanceof Error ? error : new Error("Credential request failed"));
		} finally {
			setIsLoadingCredentials(false);
		}
	}, [client, deployment.resource.id, url]);

	// Native runtime UI exposure exists only after the runtime is running.
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
		<LiveToolFrame icon={MonitorPlay} title={browserUiLabel}>
			<div className="flex min-h-[420px] flex-1 items-center justify-center p-6">
				<div className="w-full max-w-xl space-y-4 text-center">
					<p className="text-sm text-muted-foreground">
						{runtime === "hermes"
							? "Hermes uses native password authentication in a top-level window."
							: "OpenClaw uses its native token and device authentication in a top-level window."}
					</p>
					{runtime === "hermes" ? (
						credentials ? (
							<div className="space-y-3 text-left">
								<Label htmlFor={`hermes-username-${deployment.resource.id}`}>Username</Label>
								<Input
									id={`hermes-username-${deployment.resource.id}`}
									readOnly
									value={credentials.username}
								/>
								<Label htmlFor={`hermes-password-${deployment.resource.id}`}>Password</Label>
								<Input
									id={`hermes-password-${deployment.resource.id}`}
									readOnly
									value={credentials.password}
								/>
								<Button
									type="button"
									onClick={() => window.open(credentials.url, "_blank", "noopener,noreferrer")}
								>
									Open {browserUiLabel}
									<ExternalLink className="size-3.5" />
								</Button>
							</div>
						) : (
							<Button
								type="button"
								disabled={isLoadingCredentials}
								onClick={() => void loadHermesCredentials()}
							>
								{isLoadingCredentials ? <Spinner className="size-3.5" /> : null}
								Show Hermes credentials
							</Button>
						)
					) : (
						<RuntimeUiOpenButton deployment={deployment} endpointUrl={url} label={browserUiLabel}>
							Open {browserUiLabel}
							<Maximize2 className="size-3.5" />
						</RuntimeUiOpenButton>
					)}
					{credentialError ? (
						<ApiErrorPanel
							error={credentialError}
							onRetry={() => void loadHermesCredentials()}
							normalizer={billingErrorNormalizer}
							title="Couldn't load Hermes credentials"
						/>
					) : null}
				</div>
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
	const status = parseDeploymentStatus(deployment.resource.status.summary_state);
	const isRunning = isRunningStatus(status);
	const isProvisioning = isProvisioningStatus(status);
	const label = deploymentDisplayName(deployment.resource.spec.name);
	const terminal = useCreateTerminalSession();
	const { isPending: isOpeningTerminal, mutateAsync: createTerminalSession } = terminal;
	const [websocketUrl, setWebsocketUrl] = useState<string | null>(null);
	const [terminalStatus, setTerminalStatus] = useState<HostedTerminalStatus>("disconnected");
	const [terminalFailure, setTerminalFailure] = useState<string | null>(null);
	const autoStartedDeploymentRef = useRef<string | null>(null);
	const currentDeploymentIdRef = useRef(deployment.resource.id);
	const terminalRequestRef = useRef(0);

	const startTerminal = useCallback(async () => {
		if (!isRunning || isOpeningTerminal) return;
		const requestId = terminalRequestRef.current + 1;
		terminalRequestRef.current = requestId;
		setTerminalFailure(null);
		setTerminalStatus("connecting");
		try {
			const session = await createTerminalSession({ id: deployment.resource.id });
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
	}, [createTerminalSession, deployment.resource.id, isOpeningTerminal, isRunning]);

	useEffect(() => {
		if (currentDeploymentIdRef.current === deployment.resource.id) return;
		currentDeploymentIdRef.current = deployment.resource.id;
		autoStartedDeploymentRef.current = null;
		setWebsocketUrl(null);
		setTerminalFailure(null);
		setTerminalStatus("disconnected");
	}, [deployment.resource.id]);

	useEffect(() => {
		if (isRunning) return;
		autoStartedDeploymentRef.current = null;
		setWebsocketUrl(null);
		setTerminalFailure(null);
		setTerminalStatus("disconnected");
	}, [isRunning]);

	useEffect(() => {
		if (!isRunning || websocketUrl || isOpeningTerminal || terminalFailure) return;
		if (autoStartedDeploymentRef.current === deployment.resource.id) return;
		autoStartedDeploymentRef.current = deployment.resource.id;
		void startTerminal();
	}, [
		deployment.resource.id,
		isOpeningTerminal,
		isRunning,
		startTerminal,
		terminalFailure,
		websocketUrl,
	]);

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
	const runtimeConfiguration = deployment.resource.spec.runtime_configuration;
	const list = providers.data?.providers ?? [];
	const customProviders = useMemo(
		() => list.filter((provider) => !isFirstPartyManagedAiProvider(provider)),
		[list],
	);
	// Selected-runtime binding: the deployment owns one runtime in the v2 model.
	const configuredProviders = runtimeConfiguration.providers;
	const configuredPrimaryModel = runtimeConfiguration.primary_model;
	const primaryConfiguredProvider = configuredPrimaryModel
		? configuredProviders.find(
				(provider) => provider.provider_id === configuredPrimaryModel.provider_id,
			)
		: undefined;
	const currentAuthKind = runtimeAiProviderAuthKind(deployment, runtime);
	const initialMode: AiBindingMode = currentAuthKind === "unmanaged" ? "unmanaged" : "configured";
	const legacyProviderRef =
		currentAuthKind === "unmanaged" ? null : (primaryConfiguredProvider?.provider_id ?? null);
	const rawProviderRefs =
		currentAuthKind === "unmanaged"
			? []
			: configuredProviders.length > 0
				? configuredProviders.map((provider) => provider.provider_id)
				: legacyProviderRef
					? [legacyProviderRef]
					: [MANAGED_PROVIDER_ID];
	const primaryProviderRef =
		currentAuthKind === "unmanaged"
			? MANAGED_PROVIDER_ID
			: (primaryModelProviderId(configuredPrimaryModel) ??
				legacyProviderRef ??
				rawProviderRefs[0] ??
				MANAGED_PROVIDER_ID);
	const initialPrimaryChoice =
		currentAuthKind === "unmanaged"
			? MANAGED_AI_CHOICE
			: (agentChoiceFromProviderRef(primaryProviderRef, list) ??
				(isManagedProviderId(primaryProviderRef)
					? MANAGED_AI_CHOICE
					: unresolvedProviderChoice(primaryProviderRef)));
	const initialProviderChoices =
		currentAuthKind === "unmanaged"
			? []
			: normalizeSelectedProviderIds(
					rawProviderRefs
						.map((providerRef) => agentChoiceFromProviderRef(providerRef, list))
						.filter((choice): choice is string => Boolean(choice)),
					initialPrimaryChoice,
				);
	const currentModel =
		currentAuthKind === "unmanaged"
			? ""
			: primaryModelValue(configuredPrimaryModel) ||
				firstModelForProvider(initialPrimaryChoice, list);

	const [selectedProviders, setSelectedProviders] = useState<string[]>(initialProviderChoices);
	const [bindingMode, setBindingMode] = useState<AiBindingMode>(initialMode);
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
		initialMode,
		initialProviderChoices,
		initialPrimaryChoice,
		currentModel,
	]);
	const [syncedIdentity, setSyncedIdentity] = useState(bindingIdentity);
	if (bindingIdentity !== syncedIdentity) {
		setSyncedIdentity(bindingIdentity);
		setBindingMode(initialMode);
		setSelectedProviders(initialProviderChoices);
		setPrimaryProviderChoice(initialPrimaryChoice);
		setPrimaryModel(currentModel || MANAGED_PRIMARY_MODEL_FALLBACK);
	}

	const selectedIdentity = JSON.stringify(
		normalizeSelectedProviderIds(selectedProviders, primaryProviderChoice),
	);
	const initialSelectedIdentity = JSON.stringify(initialProviderChoices);
	const dirty =
		bindingMode !== initialMode ||
		(bindingMode === "configured" &&
			(selectedIdentity !== initialSelectedIdentity ||
				primaryProviderChoice !== initialPrimaryChoice ||
				primaryModel !== (currentModel || MANAGED_PRIMARY_MODEL_FALLBACK)));

	function setPrimaryProvider(choice: string) {
		setBindingMode("configured");
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
		setBindingMode("configured");
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

	return (
		<div className="flex flex-col gap-4">
			<LiveNote>
				Existing provider bindings are shown here. Choose providers in the deploy wizard while the
				declarative update contract is being expanded.
			</LiveNote>

			<div className="flex flex-col gap-2">
				<button
					type="button"
					onClick={() => setBindingMode("unmanaged")}
					className={selectableCard(bindingMode === "unmanaged")}
				>
					<div className="flex items-center justify-between gap-2">
						<span className="text-sm font-medium">{authCardLabel("unmanaged")}</span>
						{bindingMode === "unmanaged" ? <Badge variant="secondary">Current</Badge> : null}
					</div>
					<p className="mt-0.5 text-sm text-muted-foreground">
						Remove the hosted provider binding and configure model access inside the runtime.
					</p>
				</button>
				<button
					type="button"
					onClick={() => toggleProvider(MANAGED_AI_CHOICE)}
					className={selectableCard(
						bindingMode === "configured" && selectedProviders.includes(MANAGED_AI_CHOICE),
					)}
				>
					<div className="flex items-center justify-between gap-2">
						<span className="text-sm font-medium">Managed by Clawdi</span>
						{bindingMode === "configured" && primaryProviderChoice === MANAGED_AI_CHOICE ? (
							<Badge variant="secondary">Primary</Badge>
						) : bindingMode === "configured" && selectedProviders.includes(MANAGED_AI_CHOICE) ? (
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
				{bindingMode === "configured"
					? selectedProviders.filter(isUnresolvedProviderChoice).map((choice) => (
							<button key={choice} type="button" disabled className={selectableCard(true)}>
								<div className="flex items-center justify-between gap-2">
									<span className="text-sm font-medium">Provider unavailable</span>
									<Badge variant="secondary">In use</Badge>
								</div>
								<p className="mt-0.5 text-sm text-muted-foreground">
									This runtime is bound to {unresolvedProviderRef(choice)}, but that provider could
									not be loaded. Choose Managed by Clawdi to replace it.
								</p>
							</button>
						))
					: null}
				{customProviders.map((p) => {
					const selected =
						bindingMode === "configured" && selectedProviders.includes(p.provider_id);
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
							{bindingMode === "configured" && primaryProviderChoice === p.provider_id ? (
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

			{bindingMode === "unmanaged" ? (
				<p className="text-sm text-muted-foreground">
					This runtime now carries no hosted provider binding. Configure models inside the agent
					after it starts.
				</p>
			) : (
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
			)}

			<div className="flex items-center gap-2">
				<Button disabled>{dirty ? "Changes unavailable" : "No changes"}</Button>
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
	runtime,
	projectionAvailable,
}: {
	environmentId: string;
	deployment: HostedDeployment;
	runtime: Runtime;
	projectionAvailable: boolean;
}) {
	return (
		<div className="flex flex-col gap-10">
			{projectionAvailable ? (
				<AgentSettingsPanel environmentId={environmentId} />
			) : (
				<ProjectionDependentUnavailable label="Profile settings" />
			)}
			<LanguageTimezoneSettingsSection deployment={deployment} runtime={runtime} />
			<ComputeSettingsSections deployment={deployment} />
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
	const runtimeConfiguration = deployment.resource.spec.runtime_configuration;
	const configLanguage = runtimeConfiguration.language ?? "";
	const configTimezone = runtimeConfiguration.timezone ?? "";
	const runtimeLabel = runtimeDisplayName(runtime);
	const languageLabel =
		LANGUAGE_OPTIONS.find((option) => option.code === configLanguage)?.label ?? "Runtime default";

	return (
		<SettingsSection
			title="Language & timezone"
			description="Locale context configured for this hosted agent."
		>
			<div className="flex max-w-2xl flex-col gap-4">
				<LiveNote>{`Current locale settings for ${runtimeLabel}. New settings are selected during deployment.`}</LiveNote>
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="rounded-lg border bg-muted/30 p-3">
						<div className="text-xs text-muted-foreground">Language</div>
						<div className="mt-1 text-sm font-medium">{languageLabel}</div>
					</div>
					<div className="rounded-lg border bg-muted/30 p-3">
						<div className="text-xs text-muted-foreground">Timezone</div>
						<div className="mt-1 text-sm font-medium">{configTimezone || "Runtime default"}</div>
					</div>
				</div>
			</div>
		</SettingsSection>
	);
}

function ComputeSettingsSections({ deployment }: { deployment: HostedDeployment }) {
	const router = useRouter();
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const hostedAccess = useHostedProductAccess();
	const lifecycle = useDeploymentLifecycle();
	const del = useDeleteDeployment();
	const plans = usePlans();
	const refreshCheckoutReturn = useCheckoutReturnRefresh();
	const quotePlanChange = useQuotePlanChange();
	const changePlan = useChangePlan();
	const [subscriptionCreateOpen, setSubscriptionCreateOpen] = useState(false);
	const [planChangeOpen, setPlanChangeOpen] = useState(false);
	const wallet = useWallet({
		enabled:
			deployment.commercial_display?.compute_subscription?.funding_source === "wallet" ||
			(hostedAccess.canUsePlanCBilling && planChangeOpen),
	});
	const cancelSubscription = useCancelSubscription();
	const resumeSubscription = useResumeSubscription();
	const runAction = useActionLock();
	const checkoutReturnRef = useRef<string | null>(null);
	const deploymentStatus = parseDeploymentStatus(deployment.resource.status.summary_state);
	const canStop = canStopDeployment(deploymentStatus);
	const canStart = canStartDeployment(deploymentStatus);
	const canRestart = canRestartDeployment(deploymentStatus);
	const primaryLifecycleAction: "stop" | "start" = canStop ? "stop" : "start";
	const canRunPrimaryLifecycleAction = canStop || canStart;
	const fundingFact = deployment.commercial_display?.latest_funding_fact;
	const rawComputePlanSlug = deployment.current_plan_slug;
	const computePlanSlug =
		rawComputePlanSlug === COMPUTE_BASIC_SLUG || rawComputePlanSlug === COMPUTE_PERFORMANCE_SLUG
			? rawComputePlanSlug
			: undefined;
	const currentSubscription = deployment.commercial_display?.compute_subscription;
	const fundingMode = computeFundingMode(computePlanSlug, currentSubscription);
	const fundingSource = computeFundingSource(computePlanSlug, currentSubscription);
	const isIncludedBasic = fundingMode === "included_basic";
	const isPaidCompute = fundingMode === "subscription";
	const isWalletFunded = fundingSource === "wallet";
	const terminalFundingFact =
		isIncludedBasic && fundingFact?.fact_kind === "funding_revoked" ? fundingFact : null;
	const hasWalletFallback = terminalFundingFact?.funding_source === "wallet";
	const hasTerminalFallback = terminalFundingFact !== null;
	const subscriptionId = computeSubscriptionId(currentSubscription);
	const pendingPlanSlug = pendingComputePlanSlug(currentSubscription);
	const tierLabel = computeTierLabel(computePlanSlug);
	const currentBillingTerm = planChangeBillingTerm(currentSubscription?.billing_term_months ?? 1);
	const [planChangeQuote, setPlanChangeQuote] = useState<ComputePlanChangeQuoteResponse | null>(
		null,
	);
	const [walletTopUpOpen, setWalletTopUpOpen] = useState(false);
	const [walletTopUpAmountCents, setWalletTopUpAmountCents] = useState<number | null>(null);
	const basicPlan = useMemo(() => resolveBasicPlan(plans.data), [plans.data]);
	const perfPlan = useMemo(() => resolvePerformancePlan(plans.data), [plans.data]);
	const currentPaidPlan =
		computePlanSlug === COMPUTE_BASIC_SLUG
			? basicPlan
			: computePlanSlug === COMPUTE_PERFORMANCE_SLUG
				? perfPlan
				: undefined;
	const currentOfferSelection = useMemo(
		() =>
			currentPaidPlan
				? computePlanSlug === COMPUTE_BASIC_SLUG
					? selectExplicitOfferForTerm(currentPaidPlan, currentBillingTerm)
					: selectOfferForTerm(currentPaidPlan, currentBillingTerm)
				: null,
		[computePlanSlug, currentPaidPlan, currentBillingTerm],
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
	const subscriptionLifecycle = currentSubscription
		? computeSubscriptionLifecycle(currentSubscription)
		: null;
	const subscriptionLifecycleDateLabel = formatShortDate(subscriptionLifecycle?.dateAt);
	const pendingPlanCopy = pendingPlanSlug
		? pendingPlanScheduleCopy(
				pendingPlanSlug,
				currentSubscription?.current_period_end,
				subscriptionPeriodLabel,
			)
		: null;
	const subscriptionCancelable = isComputeSubscriptionCancelable(currentSubscription);
	const planChangeUnavailable = currentSubscription
		? planChangeUnavailableReason({
				canUsePlanCBilling: hostedAccess.canUsePlanCBilling,
				cancelAtPeriodEnd: subscriptionCancelPending,
				status: currentSubscription.status,
				subscriptionId,
			})
		: "Start a new subscription to change this deployment’s paid compute.";
	const canUpgrade =
		hostedAccess.canUsePlanCBilling &&
		isIncludedBasic &&
		deployment.upgrade_available &&
		planChangeUnavailable === null;
	const canStartNewSubscription =
		hostedAccess.canUsePlanCBilling && hasTerminalFallback && !!(basicPlan || perfPlan);
	const subscriptionCreatePlanSlug = resolveSubscriptionCreatePlanSlug(
		terminalFundingFact?.prior_plan_slug,
		{
			basicAvailable: !!basicPlan,
			performanceAvailable: !!perfPlan,
		},
	);
	const upgradeUnavailableMessage = plans.isLoading
		? "Checking Performance availability…"
		: !hostedAccess.canUsePlanCBilling
			? "Upgrades are temporarily unavailable."
			: !perfPlan
				? "Performance compute is unavailable right now."
				: isRunningStatus(deploymentStatus) || deploymentStatus.kind === "stopped"
					? "An upgrade may already be pending for this Basic agent."
					: "Upgrade is available once this Basic agent is running or stopped.";
	const createUnavailableMessage = plans.isLoading
		? "Checking paid compute availability…"
		: !hostedAccess.canUsePlanCBilling
			? hasTerminalFallback
				? "New subscriptions are temporarily unavailable."
				: "Upgrades are temporarily unavailable."
			: hasTerminalFallback && !(basicPlan || perfPlan)
				? "Paid compute plans are unavailable right now."
				: isIncludedBasic && planChangeUnavailable
					? planChangeUnavailable
					: upgradeUnavailableMessage;
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
			if (deploymentId && deploymentId !== deployment.resource.id) {
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
	}, [deployment.resource.id, refreshCheckoutReturn, router, searchStr]);
	useEffect(() => {
		if (hostedAccess.isLoading || hostedAccess.canUsePlanCBilling) return;
		setSubscriptionCreateOpen(false);
		setPlanChangeOpen(false);
		setPlanChangeQuote(null);
		setWalletTopUpOpen(false);
	}, [hostedAccess.canUsePlanCBilling, hostedAccess.isLoading]);

	function setPlanChangeDialogOpen(open: boolean) {
		setPlanChangeOpen(open);
		if (!open) setPlanChangeQuote(null);
	}

	function openPlanChangeTopUp(shortfallCredits: number | null = null) {
		setWalletTopUpAmountCents(
			topUpAmountCentsForCreditShortfall(shortfallCredits, wallet.data?.points_per_usd ?? 0),
		);
		setWalletTopUpOpen(true);
	}

	async function requestPlanChangeQuote(selection: PlanChangeSelection) {
		if (!hostedAccess.canUsePlanCBilling || !subscriptionId || planChangeUnavailable !== null) {
			return;
		}
		try {
			if (!(await hostedAccess.recheckPlanCBilling())) {
				setPlanChangeDialogOpen(false);
				return;
			}
			const quote = await quotePlanChange.mutateAsync({
				subscription_id: subscriptionId,
				...selection,
			});
			setPlanChangeQuote(quote);
		} catch (error) {
			toast.error("Couldn’t quote plan change", {
				description: normalizeBillingError(error),
			});
		}
	}

	async function confirmPlanChange(operationId: string) {
		if (!planChangeQuote) return;
		try {
			if (!(await hostedAccess.recheckPlanCBilling())) {
				setPlanChangeDialogOpen(false);
				return;
			}
			const result = await changePlan.mutateAsync({ operation_id: operationId });
			if (result.status === "scheduled") {
				toast.success("Downgrade scheduled", {
					description: `Your current compute remains active until ${formatShortDate(result.effective_at)}.`,
				});
			} else {
				toast.success("Plan change started", {
					description:
						result.status === "complete"
							? "Your compute subscription has been updated."
							: "Compute updates after Stripe confirms the invoice payment.",
				});
			}
			setPlanChangeDialogOpen(false);
		} catch (error) {
			const detail = billingErrorDetail(error);
			if (
				detail?.code === "insufficient_wallet_balance" ||
				detail?.code === "insufficient_balance"
			) {
				openPlanChangeTopUp(decimalCredits(detail.shortfall_credits));
				toast.error("Not enough AI Credits", {
					description: "Top up the shortfall, then request a fresh plan-change quote.",
				});
				return;
			}
			if (detail?.code === "open_refund_debt") {
				openPlanChangeTopUp(decimalCredits(detail.outstanding_debt_credits));
				toast.error("Refund debt must be repaid", {
					description: "Top up before confirming this wallet-funded plan change.",
				});
				return;
			}
			toast.error("Couldn’t change plan", {
				description: normalizeBillingError(error),
			});
		}
	}

	async function cancelComputeSubscription() {
		if (!subscriptionCancelable || subscriptionCancelPending) {
			return;
		}
		try {
			const res = await cancelSubscription.mutateAsync({ deployment_id: deployment.resource.id });
			toast.success("Subscription cancellation scheduled", {
				description: res.current_period_end
					? `Cancellation takes effect ${formatShortDate(
							res.current_period_end,
						)}. The deployment then falls back to included Basic funding if available; otherwise, it stops.`
					: "The deployment falls back to included Basic funding if available when cancellation takes effect; otherwise, it stops.",
			});
		} catch (error) {
			toast.error("Couldn’t cancel subscription", { description: normalizeBillingError(error) });
			throw error;
		}
	}

	async function resumeComputeSubscription() {
		if (!subscriptionCancelable || !subscriptionCancelPending) {
			return;
		}
		try {
			await resumeSubscription.mutateAsync({ deployment_id: deployment.resource.id });
			toast.success("Subscription resumed");
		} catch (error) {
			toast.error("Couldn’t resume subscription", { description: normalizeBillingError(error) });
		}
	}

	async function runLifecycleAction(action: "restart" | "stop" | "start") {
		await lifecycle.mutateAsync({ id: deployment.resource.id, action });
	}

	async function deleteCompute() {
		await del.mutateAsync(deployment.resource.id);
		await router.navigate({ href: "/" });
	}

	return (
		<div className="flex flex-col gap-9">
			{wallet.data ? (
				<TopUpDialog
					open={walletTopUpOpen}
					onOpenChange={(open) => {
						setWalletTopUpOpen(open);
						if (!open) setWalletTopUpAmountCents(null);
					}}
					wallet={wallet.data}
					initialAmountCents={walletTopUpAmountCents}
					onComplete={() => setPlanChangeQuote(null)}
				/>
			) : null}
			{hasTerminalFallback && (basicPlan || perfPlan) ? (
				<SubscriptionCreateDialog
					open={subscriptionCreateOpen}
					onOpenChange={setSubscriptionCreateOpen}
					plans={plans.data ?? []}
					deploymentId={deployment.resource.id}
					initialPlanSlug={subscriptionCreatePlanSlug}
					initialBillingTermMonths={currentBillingTerm}
				/>
			) : null}
			{currentSubscription &&
			(computePlanSlug === COMPUTE_BASIC_SLUG || computePlanSlug === COMPUTE_PERFORMANCE_SLUG) ? (
				<PlanChangeDialog
					open={planChangeOpen}
					onOpenChange={setPlanChangeDialogOpen}
					plans={plans.data ?? []}
					currentPlanSlug={computePlanSlug}
					currentBillingTermMonths={currentBillingTerm}
					defaultFundingSource={isWalletFunded ? "wallet" : "stripe"}
					fundingSourceSelectable={isIncludedBasic}
					quote={planChangeQuote}
					walletBalanceCredits={wallet.data?.balance_credits ?? null}
					isQuoting={quotePlanChange.isPending}
					isConfirming={changePlan.isPending}
					onQuote={requestPlanChangeQuote}
					onConfirm={confirmPlanChange}
					onTopUp={() => openPlanChangeTopUp()}
				/>
			) : null}

			<SettingsSection title="Compute plan" description="Compute resources for this hosted agent.">
				<div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
							{tierLabel === "Performance" ? (
								<Zap className="size-4" />
							) : (
								<Cpu className="size-4" />
							)}
							<span>{tierLabel} compute</span>
							<Badge variant="outline" className="font-normal text-muted-foreground">
								{isPaidCompute && subscriptionLifecycle
									? subscriptionLifecycle.badgeLabel
									: "Current"}
							</Badge>
							{isPaidCompute ? (
								<Badge variant="outline" className="font-normal text-muted-foreground">
									{isWalletFunded ? "Wallet" : "Card"}
								</Badge>
							) : hasWalletFallback ? (
								<Badge variant="outline" className="font-normal text-muted-foreground">
									Wallet fallback
								</Badge>
							) : null}
						</div>
						<p className="mt-1 text-xs text-muted-foreground">
							Basic includes one free active slot per user. Paid Basic and Performance each use one
							subscription per deployment.
						</p>
						{isPaidCompute && currentSubscription ? (
							<div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
								<p>
									{billingTermLabel(currentBillingTerm)}
									{currentPriceCents !== null ? (
										<>
											{" "}
											· {formatCentsCompact(currentPriceCents)}
											{billingTermSuffix(currentBillingTerm)}
										</>
									) : null}
									{subscriptionLifecycle?.dateVerb && subscriptionLifecycle.dateAt ? (
										<>
											{" · "}
											{subscriptionLifecycle.dateVerb} {subscriptionLifecycleDateLabel}
										</>
									) : null}
								</p>
								{pendingPlanCopy ? (
									<p className="font-medium text-warning-muted-foreground">{pendingPlanCopy}</p>
								) : null}
							</div>
						) : null}
					</div>
					<div
						id="compute-plan-controls"
						className="flex w-full scroll-mt-6 flex-col gap-2 lg:w-auto lg:min-w-64 lg:items-end"
					>
						{(hasTerminalFallback || isIncludedBasic) && plans.error ? (
							<div className="w-full lg:w-72">
								<ApiErrorPanel
									normalizer={billingErrorNormalizer}
									error={plans.error}
									onRetry={() => void plans.refetch()}
									title="Couldn’t check paid compute availability"
								/>
							</div>
						) : hasTerminalFallback || isIncludedBasic ? (
							<div className="flex w-full flex-col gap-2 lg:w-64">
								<Button
									size="sm"
									disabled={
										plans.isLoading ||
										(hasTerminalFallback ? !canStartNewSubscription : !canUpgrade || !perfPlan)
									}
									onClick={() =>
										hasTerminalFallback
											? setSubscriptionCreateOpen(true)
											: setPlanChangeDialogOpen(true)
									}
								>
									{hasTerminalFallback ? (
										<Plus data-icon="inline-start" />
									) : (
										<Zap data-icon="inline-start" />
									)}
									{hasTerminalFallback ? "Start a new subscription" : "Upgrade to Performance"}
								</Button>
								{hasTerminalFallback ? (
									canStartNewSubscription ? null : (
										<p className="text-xs text-muted-foreground">{createUnavailableMessage}</p>
									)
								) : canUpgrade ? null : (
									<p className="text-xs text-muted-foreground">{createUnavailableMessage}</p>
								)}
							</div>
						) : isPaidCompute && currentSubscription ? (
							<div className="flex w-full flex-col gap-2 lg:w-72">
								{subscriptionCancelPending ? (
									<>
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={resumeSubscription.isPending || !subscriptionCancelable}
											onClick={() =>
												void runAction(resumeComputeSubscription).catch(() => undefined)
											}
										>
											{resumeSubscription.isPending ? (
												<Spinner data-icon="inline-start" />
											) : (
												<RefreshCw data-icon="inline-start" />
											)}
											Resume subscription
										</Button>
										<p className="text-xs text-muted-foreground">{planChangeUnavailable}</p>
									</>
								) : (
									<>
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={planChangeUnavailable !== null || !!pendingPlanSlug}
											onClick={() => setPlanChangeDialogOpen(true)}
										>
											Change plan or billing term
										</Button>
										<ConfirmAction
											title={`Cancel ${tierLabel} subscription?`}
											description={
												<p>
													Cancellation takes effect {subscriptionPeriodLabel}. The deployment then
													falls back to included Basic funding if available; otherwise, it stops.
												</p>
											}
											confirmLabel="Cancel at period end"
											destructive
											onConfirm={() => runAction(cancelComputeSubscription)}
										>
											<Button
												type="button"
												variant="outline"
												size="sm"
												disabled={cancelSubscription.isPending || !subscriptionCancelable}
											>
												{cancelSubscription.isPending ? (
													<Spinner data-icon="inline-start" />
												) : (
													<Link2Off data-icon="inline-start" />
												)}
												Cancel subscription
											</Button>
										</ConfirmAction>
										{pendingPlanSlug ? (
											<p className="text-xs text-muted-foreground">
												A plan change is already scheduled. It will apply on the effective date
												shown above.
											</p>
										) : planChangeUnavailable ? (
											<p className="text-xs text-muted-foreground">{planChangeUnavailable}</p>
										) : null}
									</>
								)}
							</div>
						) : null}
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
						title={`Delete ${deploymentDisplayName(deployment.resource.spec.name)}?`}
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
