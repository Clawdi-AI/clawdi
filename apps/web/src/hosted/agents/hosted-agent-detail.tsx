"use client";

import type { components } from "@clawdi/shared/api";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import {
	AlertCircle,
	Bot,
	CircleCheck,
	Cpu,
	ExternalLink,
	Info,
	Link2,
	Link2Off,
	type LucideIcon,
	MonitorPlay,
	Plus,
	QrCode,
	RefreshCw,
	Settings,
	Sparkles,
	TerminalSquare,
	Trash2,
	WalletCards,
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
import { EntityCardSkeleton } from "@/components/entity-card";
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
import { StatusDot, type StatusTone } from "@/components/ui/status-badge";
import { deploymentDisplayName, isCloudEnvId } from "@/hosted/agent-identity";
import { HostedDeploymentDeleteAction } from "@/hosted/agents/deployment-delete-action";
import { useDeploymentLifecycle, useUpdateDeployment } from "@/hosted/agents/deployment-hooks";
import {
	HostedTerminalPanel,
	type HostedTerminalStatus,
} from "@/hosted/agents/hosted-terminal-panel";
import {
	type HermesUiCredentials,
	hermesUiCredentials,
	type OpenClawUiCredentials,
	openClawUiCredentials,
	openClawUiUrl,
	openSecureRuntimeWindow,
} from "@/hosted/agents/runtime-ui-credentials";
import { useBillingClient } from "@/hosted/billing/billing-client";
import { useCheckoutReturnHandler } from "@/hosted/billing/checkout-return";
import { ComputeDunningBanner } from "@/hosted/billing/components/compute-dunning-banner";
import type {
	ComputePlanChangeQuoteRequest,
	ComputePlanChangeQuoteResponse,
	DeploymentUpdateRequest,
	HostedDeployment,
	HostedDeploymentStatus,
} from "@/hosted/billing/contracts";
import {
	LANGUAGE_OPTIONS,
	LANGUAGE_SELECT_ITEMS,
	normalizeHostedLanguage,
	supportedTimezones,
	TimezoneCombobox,
} from "@/hosted/billing/deploy/language-timezone-controls";
import {
	billingErrorNormalizer,
	normalizeBillingError,
	PlanChangePendingError,
	PlanChangeTerminalError,
} from "@/hosted/billing/errors";
import { billingTermLabel, billingTermSuffix, formatCents } from "@/hosted/billing/format";
import {
	useCancelSubscription,
	useChangePlan,
	useCheckPlanChange,
	useManagedModelCatalog,
	usePlans,
	useQuotePlanChange,
	useResumeSubscription,
} from "@/hosted/billing/hooks";
import {
	type PlanChangeSelection,
	performanceUpgradeUnavailableReason,
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
import {
	useWalletTopUpDialog,
	type WalletFundingErrorCopy,
} from "@/hosted/billing/wallet/wallet-funding";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";
import {
	type DeploymentFailurePresentation,
	deploymentFailurePresentation,
} from "@/hosted/deployment-failure";
import {
	canDelete as canDeleteDeployment,
	canQueryDeploymentProjection,
	canRestart as canRestartDeployment,
	canStart as canStartDeployment,
	canStop as canStopDeployment,
	type DeploymentStatus,
	deploymentStatusFromResource,
	deploymentStatusLabel,
	isRunningStatus,
} from "@/hosted/deployment-status";
import { DeploymentStatusUnavailableState } from "@/hosted/deployment-status-unavailable";
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
import {
	aiBindingBuildErrorCopy,
	buildAiBindingFields,
	isUnresolvedProviderChoice,
	unresolvedProviderChoice,
	unresolvedProviderRef,
	updateProviderChoiceFromRef,
} from "@/hosted/v2/ai-providers/ai-provider-binding";
import { useUserAiProviders } from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { AuthBadge, ProviderTypeChip } from "@/hosted/v2/ai-providers/ai-providers-ui";
import { authCardLabel } from "@/hosted/v2/ai-providers/auth-card-label";
import {
	firstModelForProvider,
	isManagedProviderId,
	MANAGED_AI_CHOICE,
	MANAGED_PROVIDER_ID,
	MANAGED_PROVIDER_LABEL,
	modelBindingDisplayName,
	modelOptionsForProvider,
	normalizeSelectedProviderIds,
	primaryModelProviderId,
	primaryModelValue,
	providerCatalogDescription,
	providerDisplayLabel,
} from "@/hosted/v2/ai-providers/model-binding";
import { ModelBindingPicker } from "@/hosted/v2/ai-providers/model-binding-picker";
import { useAiProviderBindingDraft } from "@/hosted/v2/ai-providers/use-ai-provider-binding-draft";
import type { AgentChannelLink } from "@/hosted/v2/channels/channel-edit-client";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";
import {
	ChannelStatusBadge,
	HealthBadge,
	ProviderChip,
	TokenReveal,
} from "@/hosted/v2/channels/channel-ui";
import {
	useAgentChannelLinks,
	useBotPool,
	useChannelHealth,
	useChannels,
	useCreatePairCode,
	useUnlinkAgentChannel,
} from "@/hosted/v2/channels/channels-hooks";
import { ConnectBotDialog } from "@/hosted/v2/channels/connect-bot-dialog";
import {
	channelActivityAfterLink,
	channelProviderLinkingReady,
	pairingCommand,
} from "@/hosted/v2/channels/link-agent-dialog.logic";
import {
	type AgentSectionId,
	agentSectionHref,
	agentSectionLabel,
	HOSTED_AGENT_SECTION_IDS,
} from "@/lib/agent-routes";
import { toastApiError, unwrap, useApi } from "@/lib/api";
import type { SessionListItem } from "@/lib/api-schemas";
import { formatMemoryMib, formatShortDate } from "@/lib/format";
import { useHostedProductAccess } from "@/lib/hosted-product-access";
import { sessionListQueryOptions } from "@/lib/session-queries";
import { settingsQueryHref } from "@/lib/settings-routes";
import { useSensitiveAction } from "@/lib/use-sensitive-action";
import { cn } from "@/lib/utils";

type Runtime = HostedRuntime;
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
	const status = deploymentStatusFromResource(deployment.resource.status);
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

function DeleteComputeAction({
	deployment,
	onDeleteAccepted,
	variant = "destructive",
	className,
	label = "Delete",
}: {
	deployment: HostedDeployment;
	onDeleteAccepted: (deploymentId: string) => void;
	variant?: React.ComponentProps<typeof Button>["variant"];
	className?: string;
	label?: string;
}) {
	const status = deploymentStatusFromResource(deployment.resource.status);
	const canDelete = canDeleteDeployment(status);
	return (
		<HostedDeploymentDeleteAction
			deployment={deployment}
			onDeleted={() => onDeleteAccepted(deployment.resource.id)}
		>
			<Button type="button" variant={variant} size="sm" className={className} disabled={!canDelete}>
				<Trash2 />
				{label}
			</Button>
		</HostedDeploymentDeleteAction>
	);
}

function StartComputeAction({
	deployment,
	label = "Start compute",
}: {
	deployment: HostedDeployment;
	label?: string;
}) {
	const lifecycle = useDeploymentLifecycle();
	const runAction = useActionLock();
	const status = deploymentStatusFromResource(deployment.resource.status);
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
			{label}
		</Button>
	);
}

function planChangeBillingTerm(
	value: number,
): ComputePlanChangeQuoteRequest["target_billing_term_months"] {
	return value === 12 ? 12 : 1;
}

const PLAN_CHANGE_WALLET_FUNDING_ERROR_COPY = {
	insufficientBalance: "Top up the shortfall, then request a fresh plan-change quote.",
	refundDebt: "Top up before confirming this wallet-funded plan change.",
} satisfies WalletFundingErrorCopy;

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
	onDeleteAccepted,
	autoOpenRuntimeUi = false,
	runtimeUiSettlingTimedOut = false,
	deploymentTransitionTimedOut,
	isCheckingDeployment,
	onCheckDeploymentAgain,
}: {
	environmentId: string;
	deployment: HostedDeployment;
	runtime: Runtime;
	section?: AgentSectionId;
	onDeleteAccepted: (deploymentId: string) => void;
	autoOpenRuntimeUi?: boolean;
	runtimeUiSettlingTimedOut?: boolean;
	deploymentTransitionTimedOut: boolean;
	isCheckingDeployment: boolean;
	onCheckDeploymentAgain: () => void;
}) {
	const api = useApi();
	const router = useRouter();
	const deploymentStatus = deploymentStatusFromResource(deployment.resource.status);
	const deploymentRunning = isRunningStatus(deploymentStatus);
	const deploymentProjectionQueryable = canQueryDeploymentProjection(deploymentStatus);
	const cloudEnvironmentId = isCloudEnvId(environmentId);
	const agentQuery = useQuery({
		queryKey: ["agents", environmentId],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/agents/{agent_id}", {
					params: { path: { agent_id: environmentId } },
				}),
			),
		enabled: cloudEnvironmentId && deploymentProjectionQueryable,
		refetchInterval: (query) =>
			missingProjectionRefetchInterval(
				query.state.error,
				deploymentStatus,
				query.state.fetchFailureCount,
			),
		refetchIntervalInBackground: false,
	});
	const projection = resolveHostedAgentProjection({
		enabled: cloudEnvironmentId && deploymentProjectionQueryable,
		data: agentQuery.data,
		error: agentQuery.error,
		isPending: agentQuery.isPending,
	});
	const agent = projection.status === "resolved" ? projection.data : null;
	const name = agent
		? deploymentDisplayName(agentDisplayName(agent), runtime)
		: deploymentDisplayName(deployment.resource.spec.name, runtime);
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
	const terminalHref = agentSectionHref(environmentId, "terminal", searchStr);
	const planChangeHref = `${agentSectionHref(environmentId, "settings", searchStr)}#compute-plan-controls`;

	useEffect(() => {
		if (
			!autoOpenRuntimeUi ||
			activeTab !== "overview" ||
			!canOpenHostedRuntimeUi(deploymentStatus, consoleUrl)
		) {
			return;
		}
		void router.navigate({
			href: agentSectionHref(environmentId, "console", searchStr),
			replace: true,
		});
	}, [
		activeTab,
		autoOpenRuntimeUi,
		consoleUrl,
		deploymentStatus.kind,
		environmentId,
		router,
		searchStr,
	]);
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
			canOpenHostedRuntimeUi(deploymentStatus, consoleUrl) ? (
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
				{!deploymentStatus.known ? (
					<DeploymentStatusUnavailableState
						deployment={deployment}
						isRetrying={isCheckingDeployment}
						onRetry={onCheckDeploymentAgain}
					/>
				) : null}
				{deploymentStatus.known && deploymentProjectionQueryable && activeTab !== "channels" ? (
					<HostedProjectionNotice
						projection={projection}
						isFetching={agentQuery.isFetching}
						onRetry={() => {
							void agentQuery.refetch();
						}}
					/>
				) : null}
				<div className={isLiveToolTab ? "flex min-h-0 flex-1 flex-col" : "w-full"}>
					{deploymentStatus.known && activeTab === "overview" ? (
						<OverviewTab
							deployment={deployment}
							runtime={runtime}
							agent={isCloudEnvId(environmentId) ? agent : null}
							isPerformance={isPerformance}
							showDeploymentActions={projection.status !== "resolved" || !deploymentRunning}
							onDeleteAccepted={onDeleteAccepted}
							projectionAvailable={projection.status === "resolved"}
							sessions={sessions.data?.items ?? []}
							sessionsLoading={sessions.isLoading}
							sessionsError={sessions.error}
							onRetrySessions={() => sessions.refetch()}
							sessionLink={(session) => scopedSessionLink(session.id)}
							terminalHref={terminalHref}
							planChangeHref={planChangeHref}
							runtimeUiSettlingTimedOut={runtimeUiSettlingTimedOut}
							deploymentTransitionTimedOut={deploymentTransitionTimedOut}
							isCheckingDeployment={isCheckingDeployment}
							onCheckDeploymentAgain={onCheckDeploymentAgain}
						/>
					) : null}
					{deploymentStatus.known && activeTab === "console" ? (
						<ConsoleTab
							deployment={deployment}
							runtime={runtime}
							terminalHref={terminalHref}
							runtimeUiSettlingTimedOut={runtimeUiSettlingTimedOut}
							deploymentTransitionTimedOut={deploymentTransitionTimedOut}
							isCheckingDeployment={isCheckingDeployment}
							onCheckDeploymentAgain={onCheckDeploymentAgain}
						/>
					) : null}
					{deploymentStatus.known && activeTab === "terminal" ? (
						<TerminalTab deployment={deployment} />
					) : null}
					{deploymentStatus.known && activeTab === "sessions" ? (
						!deploymentProjectionQueryable ? (
							<StoppedAgentState deployment={deployment} />
						) : projection.status === "resolved" ? (
							<HostedAgentSessionsTab
								environmentId={environmentId}
								enabled={deploymentProjectionQueryable}
							/>
						) : (
							<ProjectionDependentUnavailable label="Sessions" />
						)
					) : null}
					{deploymentStatus.known && activeTab === "skills" ? (
						!deploymentProjectionQueryable ? (
							<StoppedAgentState deployment={deployment} />
						) : projection.status === "resolved" ? (
							<AgentSkillsTab
								agentId={environmentId}
								agentProjectId={agent?.default_project_id}
								isResolvingAgentProject={false}
							/>
						) : (
							<ProjectionDependentUnavailable label="Skills" />
						)
					) : null}
					{deploymentStatus.known && activeTab === "ai" ? (
						<AiProviderTab deployment={deployment} runtime={runtime} />
					) : null}
					{deploymentStatus.known && activeTab === "channels" ? (
						!deploymentProjectionQueryable ? (
							<StoppedAgentState deployment={deployment} />
						) : projection.status === "resolved" ? (
							<ChannelsTab environmentId={environmentId} />
						) : (
							<ChannelsSyncState
								isChecking={isCheckingDeployment || agentQuery.isFetching}
								onCheckAgain={() => {
									onCheckDeploymentAgain();
									if (cloudEnvironmentId) void agentQuery.refetch();
								}}
							/>
						)
					) : null}
					{deploymentStatus.known && activeTab === "settings" ? (
						<HostedAgentSettingsTab
							environmentId={environmentId}
							deployment={deployment}
							runtime={runtime}
							projectionAvailable={projection.status === "resolved"}
							onDeleteAccepted={onDeleteAccepted}
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
				title="Couldn’t sync agent details"
			/>
		);
	}
	if (projection.status === "missing") {
		return (
			<Alert data-hosted="true">
				<AlertCircle />
				<AlertTitle>Some details are still syncing</AlertTitle>
				<AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<span>
						You can manage compute and open available tools now. Sessions, skills, profile, and
						channels will appear when syncing finishes.
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
				<AlertTitle>Some details are still syncing</AlertTitle>
				<AlertDescription>
					You can manage compute while the rest of this agent finishes syncing.
				</AlertDescription>
			</Alert>
		);
	}
	return (
		<Alert data-hosted="true">
			<AlertCircle />
			<AlertTitle>Finishing agent setup</AlertTitle>
			<AlertDescription>
				You can manage compute now. The rest of this agent will appear when setup finishes.
			</AlertDescription>
		</Alert>
	);
}

function ProjectionDependentUnavailable({ label }: { label: string }) {
	return (
		<EmptyState
			title={`${label} unavailable`}
			description="This section will be available when the agent finishes syncing. You can manage compute in the meantime."
		/>
	);
}

function StoppedAgentState({
	deployment,
	variant = "page",
}: {
	deployment: HostedDeployment;
	variant?: React.ComponentProps<typeof EmptyState>["variant"];
}) {
	return (
		<EmptyState
			variant={variant}
			title="Stopped"
			description="Hosted compute has been released. Start this agent to provision compute again."
			action={<StartComputeAction deployment={deployment} label="Start" />}
		/>
	);
}

function HostedAgentSessionsTab({
	environmentId,
	enabled,
}: {
	environmentId: string;
	enabled: boolean;
}) {
	const api = useApi();
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(20);

	useEffect(() => {
		setPage(1);
	}, [environmentId]);

	const sessions = useQuery({
		...sessionListQueryOptions(api, { environment_id: environmentId, page, page_size: pageSize }),
		enabled: enabled && isCloudEnvId(environmentId),
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
	const failure = deploymentFailurePresentation(deployment);
	const status = hostedRuntimeStatusView(
		deployment.resource.status,
		agent,
		failure?.failedVerb ? failure : null,
	);
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<span
				className={cn("inline-flex min-w-0 items-center gap-1.5", status.primary.textClass)}
				title={`Compute ${status.primary.label}`}
			>
				<StatusDot status={status.primary.tone} />
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

type DeploymentReadinessStage = "provisioning" | "booting" | "ready";

function deploymentReadinessStage(
	status: HostedDeploymentStatus,
	runtimeUiAvailable: boolean,
): DeploymentReadinessStage {
	if (runtimeUiAvailable) return "ready";
	const computeReady = status.conditions.some(
		(condition) => condition.type === "Ready" && condition.status === "True",
	);
	if (status.summary_state === "starting" || status.summary_state === "running" || computeReady) {
		return "booting";
	}
	return "provisioning";
}

export function OverviewProvisioningPanel({
	deployment,
	runtime,
	runtimeUiAvailable,
	runtimeUiSettlingTimedOut,
	deploymentTransitionTimedOut,
	isCheckingDeployment,
	onCheckDeploymentAgain,
	terminalHref,
}: {
	deployment: HostedDeployment;
	runtime: Runtime;
	runtimeUiAvailable: boolean;
	runtimeUiSettlingTimedOut: boolean;
	deploymentTransitionTimedOut: boolean;
	isCheckingDeployment: boolean;
	onCheckDeploymentAgain: () => void;
	terminalHref: string;
}) {
	const status = deployment.resource.status;
	if (status === null) {
		return (
			<DeploymentStatusUnavailableState
				deployment={deployment}
				isRetrying={isCheckingDeployment}
				onRetry={onCheckDeploymentAgain}
			/>
		);
	}
	const stage = deploymentReadinessStage(status, runtimeUiAvailable);
	const browserUiLabel = runtimeBrowserUiLabel(runtime);
	const settlingTimedOut = deploymentTransitionTimedOut || runtimeUiSettlingTimedOut;
	const title = deploymentTransitionTimedOut
		? "Your agent is taking longer than expected"
		: runtimeUiSettlingTimedOut
			? `${browserUiLabel} is taking longer than expected`
			: stage === "provisioning"
				? "Getting your agent ready…"
				: stage === "booting"
					? `Opening ${browserUiLabel}…`
					: "Your agent is ready";
	const description = deploymentTransitionTimedOut
		? "Your agent did not finish getting ready within five minutes. Automatic checks have stopped. Check again to load the latest update."
		: runtimeUiSettlingTimedOut
			? `${browserUiLabel} did not open within five minutes. We’ll keep checking automatically, and Terminal is available now.`
			: stage === "provisioning"
				? "This step should finish within five minutes. Your agent will keep getting ready if you leave this page."
				: stage === "booting"
					? `This step should finish within five minutes. We’ll open ${browserUiLabel} automatically; Terminal is available now.`
					: `${browserUiLabel} is ready to use.`;
	return (
		<div
			className={cn(
				"rounded-xl border p-5",
				settlingTimedOut
					? "border-warning/30 bg-warning-muted text-warning-muted-foreground"
					: "border-info-muted bg-info-muted text-info-muted-foreground",
			)}
		>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start">
				<div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-info-muted bg-background">
					{settlingTimedOut ? <AlertCircle className="size-5" /> : <Spinner className="size-5" />}
				</div>
				<div className="min-w-0 flex-1">
					<h2 className="text-sm font-semibold text-foreground">{title}</h2>
					<p className="mt-1 text-sm">{description}</p>
					{deploymentTransitionTimedOut || stage === "booting" ? (
						<div className="mt-3 flex flex-wrap gap-2">
							{deploymentTransitionTimedOut ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={isCheckingDeployment}
									onClick={onCheckDeploymentAgain}
								>
									{isCheckingDeployment ? (
										<Spinner className="size-3.5" />
									) : (
										<RefreshCw className="size-3.5" />
									)}
									Check again
								</Button>
							) : null}
							{stage === "booting" ? (
								<Button
									render={<Link to={terminalHref} />}
									nativeButton={false}
									variant="outline"
									size="sm"
								>
									<TerminalSquare className="size-3.5" />
									Use Terminal now
								</Button>
							) : null}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

function DeploymentFailureReasonText({ reason }: { reason: string }) {
	return <p className="mt-2 whitespace-pre-wrap break-words text-sm">{reason}</p>;
}

function OverviewFailureAction({
	deployment,
	failure,
	planChangeHref,
	onDeleteAccepted,
}: {
	deployment: HostedDeployment;
	failure: DeploymentFailurePresentation;
	planChangeHref: string;
	onDeleteAccepted: (deploymentId: string) => void;
}) {
	const remediation = failure.remediation;
	return (
		<div className="flex shrink-0 flex-wrap gap-2">
			{remediation.requiresWalletTopUp && remediation.kind === "restart" ? (
				<Button
					render={<a href={settingsQueryHref("billing-wallet")} />}
					nativeButton={false}
					variant="outline"
					size="sm"
				>
					<WalletCards className="size-3.5" />
					Open Wallet
				</Button>
			) : null}
			{remediation.kind === "restart" ? (
				<RestartComputeAction deployment={deployment} label={remediation.label} />
			) : remediation.kind === "review_plan_change" ? (
				<Button
					render={<a href={planChangeHref} />}
					nativeButton={false}
					variant="outline"
					size="sm"
				>
					{remediation.label}
				</Button>
			) : remediation.kind === "retry_delete" ? (
				<DeleteComputeAction
					deployment={deployment}
					onDeleteAccepted={onDeleteAccepted}
					label={remediation.label}
				/>
			) : null}
		</div>
	);
}

export function OverviewFailedPanel({
	deployment,
	planChangeHref,
	onDeleteAccepted,
}: {
	deployment: HostedDeployment;
	planChangeHref: string;
	onDeleteAccepted: (deploymentId: string) => void;
}) {
	const status = deploymentStatusFromResource(deployment.resource.status);
	const failure = deploymentFailurePresentation(deployment);
	if (failure) {
		return (
			<Alert data-hosted="true" variant="destructive">
				<AlertCircle className="size-4" />
				<AlertTitle>{failure.title}</AlertTitle>
				<AlertDescription className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
					<div className="min-w-0">
						<p>
							{failure.description} Current status: {deploymentStatusLabel(status)}.
						</p>
						<DeploymentFailureReasonText reason={failure.reason} />
					</div>
					<OverviewFailureAction
						deployment={deployment}
						failure={failure}
						planChangeHref={planChangeHref}
						onDeleteAccepted={onDeleteAccepted}
					/>
				</AlertDescription>
			</Alert>
		);
	}
	return (
		<div className="rounded-xl border border-destructive-muted bg-destructive-muted p-5 text-destructive-muted-foreground">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start">
				<div className="flex min-w-0 gap-3">
					<div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-destructive-muted bg-background">
						<AlertCircle className="size-5" />
					</div>
					<div className="min-w-0">
						<h2 className="text-sm font-semibold text-foreground">Deployment operation failed</h2>
						<p className="mt-1 text-sm">
							The failure reason and operation are unavailable, so there is no safe automatic retry.
							Current status: {deploymentStatusLabel(status)}.
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}

function OverviewTab({
	deployment,
	runtime,
	agent,
	isPerformance,
	showDeploymentActions,
	onDeleteAccepted,
	projectionAvailable,
	sessions,
	sessionsLoading,
	sessionsError,
	onRetrySessions,
	sessionLink,
	terminalHref,
	planChangeHref,
	runtimeUiSettlingTimedOut,
	deploymentTransitionTimedOut,
	isCheckingDeployment,
	onCheckDeploymentAgain,
}: {
	deployment: HostedDeployment;
	runtime: Runtime;
	agent: components["schemas"]["AgentResponse"] | null | undefined;
	isPerformance: boolean;
	showDeploymentActions: boolean;
	onDeleteAccepted: (deploymentId: string) => void;
	projectionAvailable: boolean;
	sessions: SessionListItem[];
	sessionsLoading: boolean;
	sessionsError: unknown;
	onRetrySessions: () => void;
	sessionLink: (session: SessionListItem) => {
		to: "/agents/$id/sessions/$sessionId";
		params: { id: string; sessionId: string };
	};
	terminalHref: string;
	planChangeHref: string;
	runtimeUiSettlingTimedOut: boolean;
	deploymentTransitionTimedOut: boolean;
	isCheckingDeployment: boolean;
	onCheckDeploymentAgain: () => void;
}) {
	const spec = deployment.resource.spec;
	const providers = useUserAiProviders();
	const managedModelCatalog = useManagedModelCatalog();
	const primaryModel = spec.runtime_configuration.primary_model;
	const bindingProvider =
		spec.runtime_configuration.providers.find(
			(provider) => provider.provider_id === primaryModelProviderId(primaryModel),
		) ?? spec.runtime_configuration.providers[0];
	const model = modelBindingDisplayName(
		primaryModel,
		runtimeAiProviderAuthKind(deployment) ?? bindingProvider?.auth_kind,
		modelOptionsForProvider(
			primaryModelProviderId(primaryModel) ?? MANAGED_PROVIDER_ID,
			providers.data ?? [],
			managedModelCatalog.data?.models ?? [],
		),
	);
	const deploymentStatus = deploymentStatusFromResource(deployment.resource.status);
	const deploymentRunning = isRunningStatus(deploymentStatus);
	const runtimeUiAvailable = Boolean(runtimeConsoleUrl(deployment, runtime));
	const agentGettingReady =
		deploymentTransitionTimedOut ||
		isProvisioningStatus(deploymentStatus) ||
		(deploymentStatus.kind === "running" && !runtimeUiAvailable);
	const sessionsEmptyMessage = deploymentRunning
		? "No sessions from this agent yet."
		: "Sessions appear once your agent is running.";
	return (
		<div className="flex flex-col gap-5">
			{agentGettingReady ? (
				<OverviewProvisioningPanel
					deployment={deployment}
					runtime={runtime}
					runtimeUiAvailable={runtimeUiAvailable}
					runtimeUiSettlingTimedOut={runtimeUiSettlingTimedOut}
					deploymentTransitionTimedOut={deploymentTransitionTimedOut}
					isCheckingDeployment={isCheckingDeployment}
					onCheckDeploymentAgain={onCheckDeploymentAgain}
					terminalHref={terminalHref}
				/>
			) : null}
			{deploymentStatus.kind === "failed" ? (
				<OverviewFailedPanel
					deployment={deployment}
					planChangeHref={planChangeHref}
					onDeleteAccepted={onDeleteAccepted}
				/>
			) : null}
			{deploymentStatus.kind === "stopped" ? (
				<StoppedAgentState deployment={deployment} variant="inset" />
			) : null}
			<div
				className={cn(
					"grid gap-2 sm:grid-cols-2",
					agentGettingReady ? "lg:grid-cols-3" : "lg:grid-cols-4",
				)}
			>
				{agentGettingReady ? null : (
					<StatCard
						label="Status"
						value={<RuntimeStatusValue deployment={deployment} agent={agent} />}
					/>
				)}
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
			{showDeploymentActions ? (
				<OverviewDeploymentActions deployment={deployment} onDeleteAccepted={onDeleteAccepted} />
			) : null}
		</div>
	);
}

function OverviewDeploymentActions({
	deployment,
	onDeleteAccepted,
}: {
	deployment: HostedDeployment;
	onDeleteAccepted: (deploymentId: string) => void;
}) {
	const status = deploymentStatusFromResource(deployment.resource.status);
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
				{canStartDeployment(status) && !failed && status.kind !== "stopped" ? (
					<StartComputeAction deployment={deployment} />
				) : null}
				<DeleteComputeAction deployment={deployment} onDeleteAccepted={onDeleteAccepted} />
			</div>
		</SettingsSection>
	);
}

// ── Runtime UI ───────────────────────────────────────────────────────────────

function RuntimeUiOpenButton({
	deployment,
	endpointUrl,
	resolvedUrl,
	label,
	children,
	className,
	disabled = false,
	variant = "outline",
	size = "sm",
}: {
	deployment: HostedDeployment;
	endpointUrl: string;
	resolvedUrl?: string;
	label: string;
	children: React.ReactNode;
	className?: string;
	disabled?: boolean;
	variant?: React.ComponentProps<typeof Button>["variant"];
	size?: React.ComponentProps<typeof Button>["size"];
}) {
	const client = useBillingClient();
	const [isPending, setIsPending] = useState(false);
	const openUi = useCallback(async () => {
		const popup = openSecureRuntimeWindow(window.open.bind(window));
		if (!popup) {
			toast.error("Couldn't open runtime UI", {
				description: "Your browser blocked the new window.",
			});
			return;
		}
		if (resolvedUrl) {
			popup.location.replace(resolvedUrl);
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
	}, [client, deployment.resource.id, endpointUrl, resolvedUrl]);

	return (
		<Button
			type="button"
			variant={variant}
			size={size}
			className={className}
			disabled={disabled || isPending}
			aria-label={`Open ${label}`}
			onClick={() => void openUi()}
		>
			{isPending ? <Spinner className="size-3.5" /> : null}
			{children}
		</Button>
	);
}

type ResolvedRuntimeUiCredentials =
	| { runtime: "hermes"; value: HermesUiCredentials }
	| { runtime: "openclaw"; value: OpenClawUiCredentials };

/**
 * Live agent browser UI embedded inline. The deployment's selected runtime UI
 * URL points at owner-only exposure. When the runtime
 * allows dashboard framing, the bridge cookie + WS work in-frame; otherwise
 * the full-screen link is the alternate path.
 */
function ConsoleTab({
	deployment,
	runtime,
	terminalHref,
	runtimeUiSettlingTimedOut,
	deploymentTransitionTimedOut,
	isCheckingDeployment,
	onCheckDeploymentAgain,
}: {
	deployment: HostedDeployment;
	runtime: Runtime;
	terminalHref: string;
	runtimeUiSettlingTimedOut: boolean;
	deploymentTransitionTimedOut: boolean;
	isCheckingDeployment: boolean;
	onCheckDeploymentAgain: () => void;
}) {
	const status = deploymentStatusFromResource(deployment.resource.status);
	const isRunning = isRunningStatus(status);
	const isProvisioning = isProvisioningStatus(status);
	const label = runtimeDisplayName(runtime);
	const browserUiLabel = runtimeBrowserUiLabel(runtime);
	const url = runtimeConsoleUrl(deployment, runtime);
	const client = useBillingClient();
	const [credentials, setCredentials] = useState<ResolvedRuntimeUiCredentials | null>(null);
	const [showCredentials, setShowCredentials] = useState(false);
	const [credentialError, setCredentialError] = useState<Error | null>(null);
	const [isLoadingCredentials, setIsLoadingCredentials] = useState(false);
	const credentialRequestRef = useRef(0);
	const automaticCredentialKeyRef = useRef<string | null>(null);
	const credentialIdentity = `${deployment.resource.id}\0${deployment.resource.metadata.generation}\0${runtime}\0${url ?? ""}`;
	const [syncedCredentialIdentity, setSyncedCredentialIdentity] = useState(credentialIdentity);
	if (credentialIdentity !== syncedCredentialIdentity) {
		setSyncedCredentialIdentity(credentialIdentity);
		credentialRequestRef.current += 1;
		setCredentials(null);
		setShowCredentials(false);
		setCredentialError(null);
		setIsLoadingCredentials(false);
	}
	const loadCredentials = useCallback(
		async (reveal: boolean) => {
			if (!url) return;
			const requestId = credentialRequestRef.current + 1;
			credentialRequestRef.current = requestId;
			setIsLoadingCredentials(true);
			setCredentialError(null);
			try {
				const response = await client.getRuntimeUiCredentials(deployment.resource.id);
				let resolved: ResolvedRuntimeUiCredentials | null;
				if (runtime === "hermes") {
					const value = hermesUiCredentials(response, url);
					resolved = value ? { runtime: "hermes", value } : null;
				} else {
					const value = openClawUiCredentials(response, url);
					resolved = value ? { runtime: "openclaw", value } : null;
				}
				if (!resolved) throw new Error("Runtime UI credential response was invalid");
				if (credentialRequestRef.current !== requestId) return;
				setCredentials(resolved);
				setShowCredentials(reveal);
			} catch (error) {
				if (credentialRequestRef.current !== requestId) return;
				setCredentialError(error instanceof Error ? error : new Error("Credential request failed"));
			} finally {
				if (credentialRequestRef.current === requestId) setIsLoadingCredentials(false);
			}
		},
		[client, deployment.resource.id, runtime, url],
	);
	useEffect(() => {
		const automaticCredentialKey = `${credentialIdentity}\0openclaw`;
		if (
			!isRunning ||
			!url ||
			runtime !== "openclaw" ||
			credentials?.runtime === "openclaw" ||
			credentialError ||
			isLoadingCredentials ||
			automaticCredentialKeyRef.current === automaticCredentialKey
		) {
			return;
		}
		automaticCredentialKeyRef.current = automaticCredentialKey;
		void loadCredentials(false);
	}, [
		credentialIdentity,
		credentialError,
		credentials,
		isLoadingCredentials,
		isRunning,
		loadCredentials,
		runtime,
		url,
	]);

	const toggleCredentials = () => {
		if (showCredentials) {
			setShowCredentials(false);
			if (runtime === "hermes") setCredentials(null);
			return;
		}
		if (credentials?.runtime === runtime) setShowCredentials(true);
		else void loadCredentials(true);
	};

	if (status.kind === "stopped") {
		return <StoppedAgentState deployment={deployment} />;
	}

	if (!isRunning) {
		return (
			<EmptyState
				icon={deploymentTransitionTimedOut ? AlertCircle : MonitorPlay}
				title={
					deploymentTransitionTimedOut
						? "Deployment is taking longer than expected"
						: isProvisioning
							? provisioningTitle(status)
							: "Compute is not running"
				}
				description={
					deploymentTransitionTimedOut
						? "The latest deployment change did not finish within five minutes. Automatic checks have stopped. Check again to load the latest status."
						: isProvisioning
							? `The live ${browserUiLabel} opens here once your agent is running. This page updates automatically.`
							: `Start the compute to open the live ${browserUiLabel}. Current status: ${deploymentStatusLabel(status).toLowerCase()}.`
				}
				action={
					deploymentTransitionTimedOut ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={isCheckingDeployment}
							onClick={onCheckDeploymentAgain}
						>
							{isCheckingDeployment ? (
								<Spinner className="size-3.5" />
							) : (
								<RefreshCw className="size-3.5" />
							)}
							Check again
						</Button>
					) : canStartDeployment(status) ? (
						<StartComputeAction deployment={deployment} />
					) : null
				}
			/>
		);
	}

	// Running, but this runtime hasn't published a UI endpoint.
	if (!url) {
		return (
			<EmptyState
				icon={runtimeUiSettlingTimedOut ? AlertCircle : <Spinner className="size-5" />}
				title={
					runtimeUiSettlingTimedOut
						? "Live UI is taking longer than expected"
						: "Starting the live UI…"
				}
				description={
					runtimeUiSettlingTimedOut
						? `${label} did not publish its browser UI within the startup window. Automatic periodic checks will continue.`
						: `Opening the live UI automatically… You can use Terminal right now while ${label} finishes booting.`
				}
				action={
					<Button
						render={<Link to={terminalHref} />}
						nativeButton={false}
						variant="outline"
						size="sm"
					>
						<TerminalSquare className="size-3.5" />
						Use Terminal now
					</Button>
				}
			/>
		);
	}
	const frameUrl =
		runtime === "hermes"
			? url
			: credentials?.runtime === "openclaw"
				? credentials.value.url
				: undefined;
	const runtimeActions = (
		<>
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={isLoadingCredentials}
				onClick={toggleCredentials}
			>
				{isLoadingCredentials ? <Spinner className="size-3.5" /> : null}
				{showCredentials ? "Hide credentials" : "Show credentials"}
			</Button>
			{runtime === "openclaw" ? (
				<RuntimeUiOpenButton
					deployment={deployment}
					endpointUrl={url}
					resolvedUrl={credentials?.runtime === "openclaw" ? credentials.value.url : undefined}
					label={browserUiLabel}
					disabled={isLoadingCredentials}
				>
					Open in new window
					<ExternalLink className="size-3.5" />
				</RuntimeUiOpenButton>
			) : (
				<Button
					render={<a href={url} target="_blank" rel="noopener noreferrer" />}
					nativeButton={false}
					variant="outline"
					size="sm"
				>
					Open in new window
					<ExternalLink className="size-3.5" />
				</Button>
			)}
		</>
	);

	return (
		<LiveToolFrame icon={MonitorPlay} title={browserUiLabel} action={runtimeActions}>
			{showCredentials ? (
				<div className="grid shrink-0 gap-3 border-y bg-muted/20 p-4 sm:grid-cols-2 lg:px-6">
					{credentials?.runtime === "hermes" ? (
						<>
							<div className="space-y-1.5">
								<Label htmlFor={`hermes-username-${deployment.resource.id}`}>Username</Label>
								<Input
									id={`hermes-username-${deployment.resource.id}`}
									readOnly
									value={credentials.value.username}
								/>
							</div>
							<TokenReveal label="Password" value={credentials.value.password} />
						</>
					) : credentials?.runtime === "openclaw" ? (
						<div className="sm:col-span-2">
							<TokenReveal label="Token" value={credentials.value.token} />
						</div>
					) : null}
				</div>
			) : null}
			{credentialError ? (
				<div
					className={cn("p-4 lg:px-6", frameUrl ? "shrink-0" : "flex min-h-[420px] items-center")}
				>
					<div className="w-full">
						<ApiErrorPanel
							error={credentialError}
							onRetry={() => void loadCredentials(runtime === "hermes")}
							normalizer={billingErrorNormalizer}
							title={`Couldn't load ${label} credentials`}
						/>
					</div>
				</div>
			) : null}
			{frameUrl ? (
				<iframe
					key={`${runtime}:${frameUrl}`}
					src={frameUrl}
					title={browserUiLabel}
					className="min-h-[420px] flex-1 border-0 bg-background"
					allow="clipboard-read; clipboard-write"
				/>
			) : credentialError ? null : (
				<div className="flex min-h-[420px] flex-1 items-center justify-center bg-background">
					<Spinner className="size-4 text-muted-foreground" />
				</div>
			)}
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

const TERMINAL_STATUS_TONES: Record<HostedTerminalStatus, StatusTone> = {
	connecting: "warning",
	connected: "success",
	disconnected: "destructive",
};

function TerminalStatusIndicator({ status }: { status: HostedTerminalStatus }) {
	return (
		<div className="flex items-center gap-2 text-xs text-muted-foreground">
			<StatusDot status={TERMINAL_STATUS_TONES[status]} className="size-2" />
			<span>{TERMINAL_STATUS_LABELS[status]}</span>
		</div>
	);
}

function TerminalTab({ deployment }: { deployment: HostedDeployment }) {
	const status = deploymentStatusFromResource(deployment.resource.status);
	const isRunning = isRunningStatus(status);
	const isProvisioning = isProvisioningStatus(status);
	const label = deploymentDisplayName(
		deployment.resource.spec.name,
		deployment.resource.spec.runtime,
	);
	const client = useBillingClient();
	const terminal = useSensitiveAction(({ id }: { id: string }) => client.createTerminalSession(id));
	const { isPending: isOpeningTerminal, execute: createTerminalSession } = terminal;
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
		setWebsocketUrl(null);
		setTerminalFailure(null);
		setTerminalStatus("connecting");
		try {
			const session = await createTerminalSession({ id: deployment.resource.id });
			if (terminalRequestRef.current !== requestId) return;
			if (!session.websocket_url) {
				setTerminalStatus("disconnected");
				setTerminalFailure("The secure terminal could not be opened. Try again.");
				toast.error("Terminal unavailable", {
					description: "The secure terminal could not be opened. Try again.",
				});
				return;
			}
			setWebsocketUrl(session.websocket_url);
		} catch (error) {
			if (terminalRequestRef.current !== requestId) return;
			setTerminalStatus("disconnected");
			setTerminalFailure("Couldn't open terminal. Try again.");
			toast.error("Couldn't open terminal", { description: normalizeBillingError(error) });
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
		if (status === "disconnected") {
			setWebsocketUrl(null);
			setTerminalFailure("Terminal connection closed. Reconnect to start a new session.");
		}
	}, []);

	if (status.kind === "stopped") {
		return <StoppedAgentState deployment={deployment} />;
	}

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
								{terminalFailure ? "Terminal unavailable" : "Opening secure terminal"}
							</h2>
							<p className="mt-1 text-sm text-muted-foreground">
								{terminalFailure ?? "Starting a secure shell for your agent."}
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

function AiProviderTab({
	deployment,
	runtime,
}: {
	deployment: HostedDeployment;
	runtime: Runtime;
}) {
	const providers = useUserAiProviders();
	const managedModelCatalog = useManagedModelCatalog();
	const updateDeployment = useUpdateDeployment();
	const updateInProgress =
		deploymentStatusFromResource(deployment.resource.status).kind === "updating";
	const runtimeConfiguration = deployment.resource.spec.runtime_configuration;
	const list = providers.data ?? [];
	const managedModels = managedModelCatalog.data?.models ?? [];
	// Selected-runtime binding: the deployment owns one runtime in the v2 model.
	const configuredProviders = runtimeConfiguration.providers;
	const configuredPrimaryModel = runtimeConfiguration.primary_model;
	const primaryConfiguredProvider = configuredPrimaryModel
		? configuredProviders.find(
				(provider) => provider.provider_id === configuredPrimaryModel.provider_id,
			)
		: undefined;
	const currentAuthKind = runtimeAiProviderAuthKind(deployment, runtime);
	const initialMode = currentAuthKind === "unmanaged" ? "unmanaged" : "configured";
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
			: (updateProviderChoiceFromRef(primaryProviderRef, list) ??
				(isManagedProviderId(primaryProviderRef)
					? MANAGED_AI_CHOICE
					: unresolvedProviderChoice(primaryProviderRef)));
	const initialProviderChoices =
		currentAuthKind === "unmanaged"
			? []
			: normalizeSelectedProviderIds(
					rawProviderRefs
						.map((providerRef) => updateProviderChoiceFromRef(providerRef, list))
						.filter((choice): choice is string => Boolean(choice)),
					initialPrimaryChoice,
				);
	const bindingModelIdentity =
		currentAuthKind === "unmanaged"
			? ""
			: primaryModelValue(configuredPrimaryModel) ||
				(initialPrimaryChoice === MANAGED_AI_CHOICE
					? ""
					: firstModelForProvider(initialPrimaryChoice, list));
	const currentModel =
		currentAuthKind === "unmanaged"
			? ""
			: bindingModelIdentity || firstModelForProvider(initialPrimaryChoice, list, managedModels);

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
		bindingModelIdentity,
	]);
	const {
		draft: aiBindingDraft,
		managedPrimaryModelReady,
		selectedProviderChoices,
		setBindingMode,
		setPrimaryModel,
		setPrimaryProvider,
		toggleProvider,
	} = useAiProviderBindingDraft({
		initialDraft: {
			bindingMode: initialMode,
			providerChoices: initialProviderChoices,
			primaryProviderChoice: initialPrimaryChoice,
			primaryModel: currentModel,
		},
		managedCatalogReady: managedModelCatalog.isSuccess,
		managedModels,
		operationMode: "update",
		providers: list,
		syncIdentity: bindingIdentity,
	});
	const {
		bindingMode,
		primaryModel,
		primaryProviderChoice,
		providerChoices: selectedProviders,
	} = aiBindingDraft;
	const selectedIdentity = JSON.stringify(selectedProviderChoices);
	const initialSelectedIdentity = JSON.stringify(initialProviderChoices);
	const dirty =
		bindingMode !== initialMode ||
		(bindingMode === "configured" &&
			(selectedIdentity !== initialSelectedIdentity ||
				primaryProviderChoice !== initialPrimaryChoice ||
				primaryModel !== currentModel));
	function applyProviderSettings() {
		let update: DeploymentUpdateRequest;
		try {
			update = buildAiBindingFields(aiBindingDraft, {
				managedModels,
				mode: "update",
				providers: list,
			});
		} catch (error) {
			const copy = aiBindingBuildErrorCopy(error, "update");
			toast.error(copy.title, copy.description ? { description: copy.description } : undefined);
			return;
		}
		updateDeployment.mutate({ id: deployment.resource.id, update });
	}

	return (
		<div className="flex flex-col gap-4">
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
						<span className="text-sm font-medium">{MANAGED_PROVIDER_LABEL}</span>
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
				{providers.isLoading ? <EntityCardSkeleton titleBadge trailingBadge /> : null}
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
									<span className="text-sm font-medium">
										Using {providerDisplayLabel(unresolvedProviderRef(choice), list)}
									</span>
									<Badge variant="secondary">In use</Badge>
								</div>
								<p className="mt-0.5 text-sm text-muted-foreground">
									Its saved connection details couldn’t be loaded. Choose {MANAGED_PROVIDER_LABEL}{" "}
									to replace it.
								</p>
							</button>
						))
					: null}
				{list.map((p) => {
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
									<span className="truncate text-sm font-medium">{providerDisplayLabel(p)}</span>
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
				<ModelBindingPicker
					idPrefix="agent"
					providers={list}
					managedModels={managedModels}
					managedModelsLoading={managedModels.length === 0 && managedModelCatalog.isFetching}
					managedModelsError={managedModelCatalog.error}
					managedModelsErrorNormalizer={billingErrorNormalizer}
					onManagedModelsRetry={() => void managedModelCatalog.refetch()}
					customProviders={list}
					additionalProviderItems={selectedProviderChoices
						.filter(isUnresolvedProviderChoice)
						.map((choice) => ({
							value: choice,
							label: providerDisplayLabel(unresolvedProviderRef(choice), list),
						}))}
					selectedProviderChoices={selectedProviderChoices}
					primaryProviderChoice={primaryProviderChoice}
					primaryModel={primaryModel}
					onPrimaryProviderChange={setPrimaryProvider}
					onPrimaryModelChange={setPrimaryModel}
				/>
			)}

			<div className="flex items-center gap-2">
				<Button
					disabled={
						!dirty || !managedPrimaryModelReady || updateDeployment.isPending || updateInProgress
					}
					onClick={applyProviderSettings}
				>
					{updateDeployment.isPending ? <Spinner className="size-3.5" /> : null}
					Save changes
				</Button>
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

function ChannelsSyncState({
	isChecking,
	onCheckAgain,
}: {
	isChecking: boolean;
	onCheckAgain: () => void;
}) {
	return (
		<EmptyState
			icon={isChecking ? <Spinner className="size-5" /> : Link2}
			title="Getting channels ready"
			description="Your agent is finishing setup. This usually takes a few minutes, and this page checks automatically."
			action={
				<div className="flex flex-wrap justify-center gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={isChecking}
						onClick={onCheckAgain}
					>
						{isChecking ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
						{isChecking ? "Checking…" : "Check now"}
					</Button>
					<Button render={<Link to="/channels" />} nativeButton={false} size="sm" variant="outline">
						Choose a channel while you wait
					</Button>
				</div>
			}
		/>
	);
}

type LinkableChannel = { id: string; provider: string; name: string };

function channelSelectItems(channels: LinkableChannel[]) {
	return channels.map((channel) => ({
		value: channel.id,
		label: `${providerMeta(channel.provider).label} · ${channel.name}`,
	}));
}

function ChannelsTab({ environmentId }: { environmentId: string }) {
	const api = useApi();
	const qc = useQueryClient();
	const channels = useChannels();
	const botPool = useBotPool();
	const health = useChannelHealth();
	const linked = useAgentChannelLinks(environmentId, isCloudEnvId(environmentId));
	const unlink = useUnlinkAgentChannel(environmentId);
	const [readyBotId, setReadyBotId] = useState("");
	const [ownedChannelId, setOwnedChannelId] = useState("");
	const [recentLink, setRecentLink] = useState<AgentChannelLink | null>(null);
	const [recentToken, setRecentToken] = useState<{ linkId: string; value: string } | null>(null);
	const [connectOpen, setConnectOpen] = useState(false);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [linkingAccountId, setLinkingAccountId] = useState<string | null>(null);
	const linkInFlightRef = useRef(false);
	const unlinkingLinkIdsRef = useRef<Set<string>>(new Set());
	const [unlinkingLinkIds, setUnlinkingLinkIds] = useState<ReadonlySet<string>>(() => new Set());

	const linkedIds = useMemo(
		() =>
			new Set([
				...(linked.data ?? []).map((link) => link.account_id),
				...(recentLink ? [recentLink.account_id] : []),
			]),
		[linked.data, recentLink],
	);
	const visibleLinks = useMemo(() => {
		const items = linked.data ?? [];
		return recentLink && !items.some((link) => link.id === recentLink.id)
			? [recentLink, ...items]
			: items;
	}, [linked.data, recentLink]);
	const ownedChannels = useMemo(
		() =>
			(channels.data ?? [])
				.map((channel) => ({
					id: channel.id,
					provider: channel.provider,
					name: channel.name,
				}))
				.filter(
					(channel) => channelProviderLinkingReady(channel.provider) && !linkedIds.has(channel.id),
				),
		[channels.data, linkedIds],
	);
	const readyBots = useMemo(
		() =>
			Object.values(botPool.data?.providers ?? {})
				.flat()
				.filter(
					(bot) =>
						bot.access === "public" &&
						bot.available &&
						channelProviderLinkingReady(bot.provider) &&
						!linkedIds.has(bot.id),
				)
				.map((bot) => ({ id: bot.id, provider: bot.provider, name: bot.name })),
		[botPool.data, linkedIds],
	);
	const selectedReadyBotId = readyBotId || (readyBots.length === 1 ? readyBots[0]?.id : "");
	const selectedOwnedChannelId =
		ownedChannelId || (ownedChannels.length === 1 ? ownedChannels[0]?.id : "");

	useEffect(() => {
		if (!botPool.isLoading && !botPool.error && readyBots.length === 0) setAdvancedOpen(true);
	}, [botPool.error, botPool.isLoading, readyBots.length]);

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
	const healthByAccount = useMemo(
		() => new Map((health.data?.items ?? []).map((item) => [item.account_id, item])),
		[health.data],
	);

	const link = useSensitiveAction(async (channelId: string) => {
		try {
			const data = unwrap(
				await api.POST("/v1/channels/{account_id}/agent-links", {
					params: { path: { account_id: channelId } },
					body: { agent_id: environmentId },
				}),
			);
			setRecentToken(data.agent_token ? { linkId: data.id, value: data.agent_token } : null);
			setRecentLink({
				id: data.id,
				account_id: data.account_id,
				agent_id: data.agent_id,
				status: data.status,
				created_at: data.created_at,
			});
			qc.invalidateQueries({ queryKey: ["agent-channel-links", environmentId] });
			qc.invalidateQueries({ queryKey: ["channel-agent-links", data.account_id] });
			qc.invalidateQueries({ queryKey: ["channel-bot-pool"] });
			qc.invalidateQueries({ queryKey: ["channels"] });
			toast.success("Channel linked", {
				description: "Create a pairing code in the linked channel card to connect a conversation.",
			});
			return data;
		} catch (error) {
			toastApiError("Couldn't link channel")(error);
			throw error;
		}
	});

	async function submitLink(channelId: string) {
		if (!channelId || linkInFlightRef.current) return;
		linkInFlightRef.current = true;
		setLinkingAccountId(channelId);
		try {
			await link.execute(channelId);
			setReadyBotId("");
			setOwnedChannelId("");
		} catch {
			// The action already surfaces the API error.
		} finally {
			linkInFlightRef.current = false;
			setLinkingAccountId(null);
		}
	}

	function startUnlink(accountIdToUnlink: string, linkId: string) {
		if (unlinkingLinkIdsRef.current.has(linkId)) return;
		unlinkingLinkIdsRef.current.add(linkId);
		setUnlinkingLinkIds((prev) => new Set(prev).add(linkId));
		void (async () => {
			try {
				await unlink.mutateAsync({ accountId: accountIdToUnlink, linkId });
				setRecentToken((current) => (current?.linkId === linkId ? null : current));
				setRecentLink((current) => (current?.id === linkId ? null : current));
			} catch {
				// useUnlinkAgentChannel already surfaces the API error.
			} finally {
				unlinkingLinkIdsRef.current.delete(linkId);
				setUnlinkingLinkIds((prev) => {
					const next = new Set(prev);
					next.delete(linkId);
					return next;
				});
			}
		})();
	}

	return (
		<div className="space-y-4">
			<LiveNote>
				Hosted agents apply channel credentials automatically — no restart or token copy.
			</LiveNote>

			{/* Linked channels */}
			<div className="space-y-2">
				<div className="text-sm font-medium">Linked channels</div>
				{linked.isLoading && visibleLinks.length === 0 ? (
					<Skeleton className="h-16 w-full rounded-lg" />
				) : linked.error && visibleLinks.length === 0 ? (
					<ApiErrorPanel
						error={linked.error}
						onRetry={() => linked.refetch()}
						title="Couldn't load linked channels"
					/>
				) : visibleLinks.length === 0 ? (
					<EmptyState
						variant="inset"
						title="No channels linked"
						description="Link a channel below so this agent can send and receive messages."
					/>
				) : (
					visibleLinks.map((l) => (
						<LinkedChannelRow
							key={l.id}
							link={l}
							fallbackAccount={accountSummaries.get(l.account_id)}
							health={healthByAccount.get(l.account_id)}
							healthLoading={health.isLoading}
							healthError={Boolean(health.error)}
							token={recentToken?.linkId === l.id ? recentToken.value : undefined}
							unlinking={unlinkingLinkIds.has(l.id)}
							onUnlink={() => startUnlink(l.account_id, l.id)}
						/>
					))
				)}
				{linked.error && visibleLinks.length > 0 ? (
					<ApiErrorPanel
						error={linked.error}
						onRetry={() => linked.refetch()}
						title="Couldn't refresh every linked channel"
					/>
				) : null}
			</div>

			<div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
				<div className="flex items-start gap-3">
					<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-primary ring-1 ring-primary/20">
						<Bot className="size-4" />
					</div>
					<div>
						<div className="text-sm font-medium">Fastest: use a ready-to-go bot</div>
						<p className="mt-1 text-xs text-muted-foreground">
							No bot account, credentials, or developer setup. Choose one and link it now.
						</p>
					</div>
				</div>
				{botPool.isLoading ? (
					<Skeleton className="h-9 w-full rounded-md" />
				) : botPool.error ? (
					<ApiErrorPanel
						error={botPool.error}
						onRetry={() => botPool.refetch()}
						title="Couldn't load ready-to-go bots"
					/>
				) : readyBots.length > 0 ? (
					<div className="flex flex-col gap-2 sm:flex-row">
						<Select
							items={channelSelectItems(readyBots)}
							value={selectedReadyBotId}
							onValueChange={(value) => {
								if (value !== null) setReadyBotId(value);
							}}
						>
							<SelectTrigger aria-label="Choose a ready-to-go bot" className="flex-1 bg-background">
								<SelectValue placeholder="Choose a ready-to-go bot…" />
							</SelectTrigger>
							<SelectContent>
								{readyBots.map((bot) => (
									<SelectItem key={bot.id} value={bot.id}>
										{providerMeta(bot.provider).label} · {bot.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							disabled={!selectedReadyBotId || linkingAccountId !== null}
							onClick={() => void submitLink(selectedReadyBotId)}
						>
							{linkingAccountId === selectedReadyBotId ? (
								<Spinner className="size-3.5" />
							) : (
								<Link2 className="size-3.5" />
							)}
							{linkingAccountId === selectedReadyBotId ? "Linking…" : "Link bot"}
						</Button>
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						No ready-to-go bots are available right now. You can use your own bot below.
					</p>
				)}
			</div>

			<details
				open={advancedOpen}
				onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
				className="group rounded-lg border p-4"
			>
				<summary className="cursor-pointer text-sm font-medium">
					Use your own bot (advanced)
				</summary>
				<div className="mt-3 space-y-3">
					<p className="text-xs text-muted-foreground">
						Choose a Telegram or Discord bot you already connected, or connect a new one.
					</p>
					{channels.isLoading ? (
						<Skeleton className="h-9 w-full rounded-md" />
					) : channels.error ? (
						<ApiErrorPanel
							error={channels.error}
							onRetry={() => channels.refetch()}
							title="Couldn't load your bots"
						/>
					) : ownedChannels.length > 0 ? (
						<div className="flex flex-col gap-2 sm:flex-row">
							<Select
								items={channelSelectItems(ownedChannels)}
								value={selectedOwnedChannelId}
								onValueChange={(value) => {
									if (value !== null) setOwnedChannelId(value);
								}}
							>
								<SelectTrigger aria-label="Choose your bot" className="flex-1">
									<SelectValue placeholder="Choose your bot…" />
								</SelectTrigger>
								<SelectContent>
									{ownedChannels.map((channel) => (
										<SelectItem key={channel.id} value={channel.id}>
											{providerMeta(channel.provider).label} · {channel.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								disabled={!selectedOwnedChannelId || linkingAccountId !== null}
								onClick={() => void submitLink(selectedOwnedChannelId)}
							>
								{linkingAccountId === selectedOwnedChannelId ? (
									<Spinner className="size-3.5" />
								) : (
									<Link2 className="size-3.5" />
								)}
								{linkingAccountId === selectedOwnedChannelId ? "Linking…" : "Link my bot"}
							</Button>
						</div>
					) : (
						<EmptyState
							variant="inset"
							title="No bot connected yet"
							description="Connect a Telegram or Discord bot, then it will appear here automatically."
							action={
								<Button onClick={() => setConnectOpen(true)}>
									<Plus className="size-3.5" />
									Connect my bot
								</Button>
							}
						/>
					)}
					<div className="flex flex-wrap gap-2">
						{ownedChannels.length > 0 ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setConnectOpen(true)}
							>
								<Plus className="size-3.5" />
								Connect another bot
							</Button>
						) : null}
						<Button render={<Link to="/channels" />} nativeButton={false} variant="ghost" size="sm">
							View all channel options
						</Button>
					</div>
				</div>
			</details>

			<ConnectBotDialog open={connectOpen} onOpenChange={setConnectOpen} />
		</div>
	);
}

function LinkedChannelRow({
	link,
	onUnlink,
	unlinking,
	fallbackAccount,
	health,
	healthLoading,
	healthError,
	token,
}: {
	link: AgentChannelLink;
	onUnlink: () => void;
	unlinking: boolean;
	fallbackAccount?: { provider: string; name: string };
	health?: components["schemas"]["ChannelHealthItemResponse"];
	healthLoading: boolean;
	healthError: boolean;
	token?: string;
}) {
	const pair = useCreatePairCode(link.account_id);
	const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
	const [creatingPairCode, setCreatingPairCode] = useState(false);
	const pairInFlightRef = useRef(false);
	// The list-by-agent payload may omit the nested `account`. Fall back to the
	// loaded channels/bot-pool summary, then to the raw account id, so a missing
	// account NEVER white-screens (apps/web/src has no ErrorBoundary).
	const account = link.account ?? fallbackAccount ?? null;
	const provider = account?.provider ?? "";
	const name = account?.name ?? "Unnamed channel";
	const providerLabel = provider ? providerMeta(provider).label : "your chat app";
	const hasActivity = channelActivityAfterLink(health?.last_message_at, link.created_at);
	const chatInstruction =
		provider === "telegram"
			? `Open Telegram and start a conversation with the bot you connected as “${name}”.`
			: provider === "discord"
				? `Open Discord and choose the server channel or direct message where “${name}” should answer.`
				: `Open the conversation where you want “${name}” to answer.`;
	async function createPairCode() {
		if (pairInFlightRef.current) return;
		pairInFlightRef.current = true;
		setCreatingPairCode(true);
		try {
			const data = await pair.execute({ agent_link_id: link.id });
			setCode({ code: data.code, expires_at: data.expires_at });
		} catch {
			// useCreatePairCode already surfaces the API error.
		} finally {
			pairInFlightRef.current = false;
			setCreatingPairCode(false);
		}
	}
	return (
		<div className="rounded-lg border p-4">
			<div className="flex items-center gap-3">
				<ProviderChip provider={provider} />
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium">{name}</div>
					<div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
						{provider ? <span>{providerMeta(provider).label}</span> : null}
						<ChannelStatusBadge status={link.status} />
						{health ? <HealthBadge status={health.health_status} /> : null}
					</div>
				</div>
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
						{unlinking ? <Spinner className="size-4" /> : <Link2Off className="size-4" />}
					</Button>
				</ConfirmAction>
			</div>

			<div
				role="status"
				aria-live="polite"
				className={cn(
					"mt-3 rounded-lg border p-3",
					hasActivity ? "border-success/30 bg-success-muted" : "bg-muted/30",
				)}
			>
				<div className="flex items-center gap-2 text-sm font-medium">
					{healthLoading ? (
						<Spinner className="size-4" />
					) : healthError ? (
						<AlertCircle className="size-4 text-warning-muted-foreground" />
					) : hasActivity ? (
						<CircleCheck className="size-4 text-success-muted-foreground" />
					) : (
						<span className="size-2 animate-pulse rounded-full bg-info" aria-hidden />
					)}
					{healthLoading
						? "Checking channel activity…"
						: healthError
							? "Channel activity is temporarily unavailable"
							: hasActivity
								? "Channel activity detected"
								: "Waiting for channel activity"}
				</div>
				<p className="mt-1 text-xs text-muted-foreground">
					{healthError
						? "Automatic checks will continue. You can finish the steps below while Clawdi reconnects."
						: hasActivity
							? "Clawdi can see activity on this channel. This signal does not yet confirm that the agent received a normal message."
							: "This page checks automatically every 20 seconds. No refresh needed."}
				</p>
			</div>

			{hasActivity ? (
				<div className="mt-3 text-sm">
					<p className="font-medium">Send a normal message to start chatting</p>
					<p className="mt-1 text-xs text-muted-foreground">
						Open {providerLabel} and message the conversation you paired. Channel-level activity is
						live; agent delivery confirmation is not available yet.
					</p>
				</div>
			) : (
				<div className="mt-3 space-y-3">
					<div>
						<p className="text-sm font-medium">Finish connecting your conversation</p>
						<p className="mt-1 text-xs text-muted-foreground">
							Linking gives this agent access to the bot. Pairing chooses the exact conversation
							where it should answer.
						</p>
					</div>
					<ol className="list-decimal space-y-2 pl-4 text-sm text-muted-foreground">
						<li>
							<Button
								variant="outline"
								size="sm"
								className="ml-1"
								disabled={creatingPairCode}
								onClick={() => void createPairCode()}
							>
								{creatingPairCode ? (
									<Spinner className="size-3.5" />
								) : (
									<QrCode className="size-3.5" />
								)}
								{creatingPairCode ? "Creating code…" : "Create pairing code"}
							</Button>
						</li>
						<li>{chatInstruction}</li>
						<li>Send the command below in that conversation, then send a normal message.</li>
					</ol>
					{code ? (
						<div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
							<p className="text-xs font-medium text-primary">Send this exact command</p>
							<code className="mt-1 block break-all font-mono font-semibold tracking-wide">
								{pairingCommand(code.code)}
							</code>
							<p className="mt-1 text-xs text-muted-foreground">
								The code is one-time and expires automatically.
							</p>
						</div>
					) : null}
				</div>
			)}

			{token ? (
				<details className="mt-3 rounded-md border p-3">
					<summary className="cursor-pointer text-xs font-medium">Agent token (advanced)</summary>
					<div className="mt-2">
						<TokenReveal
							label="Agent token"
							value={token}
							note="Hosted agents configure this automatically. You do not need to copy it unless support asks you to."
						/>
					</div>
				</details>
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
	onDeleteAccepted,
}: {
	environmentId: string;
	deployment: HostedDeployment;
	runtime: Runtime;
	projectionAvailable: boolean;
	onDeleteAccepted: (deploymentId: string) => void;
}) {
	const formatName = useCallback((name: string) => deploymentDisplayName(name, runtime), [runtime]);
	return (
		<div className="flex flex-col gap-10">
			{projectionAvailable ? (
				<AgentSettingsPanel environmentId={environmentId} formatName={formatName} />
			) : (
				<ProjectionDependentUnavailable label="Profile settings" />
			)}
			<LanguageTimezoneSettingsSection deployment={deployment} runtime={runtime} />
			<ComputeSettingsSections deployment={deployment} onDeleteAccepted={onDeleteAccepted} />
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
	const updateDeployment = useUpdateDeployment();
	const updateInProgress =
		deploymentStatusFromResource(deployment.resource.status).kind === "updating";
	const localeIdentity = `${configLanguage}\0${configTimezone}`;
	const [syncedLocaleIdentity, setSyncedLocaleIdentity] = useState(localeIdentity);
	const [language, setLanguage] = useState(configLanguage);
	const [timezone, setTimezone] = useState(configTimezone);
	if (syncedLocaleIdentity !== localeIdentity) {
		setSyncedLocaleIdentity(localeIdentity);
		setLanguage(configLanguage);
		setTimezone(configTimezone);
	}
	const timezoneOptions = useMemo(() => {
		const options = supportedTimezones();
		return timezone && !options.includes(timezone) ? [timezone, ...options] : options;
	}, [timezone]);
	const dirty = language !== configLanguage || timezone !== configTimezone;

	return (
		<SettingsSection
			title="Language & timezone"
			description="Locale context configured for this hosted agent."
		>
			<div className="flex max-w-2xl flex-col gap-4">
				<LiveNote>{`Apply locale changes directly to this ${runtimeLabel} deployment.`}</LiveNote>
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="hosted-agent-language">Language</Label>
						<Select
							items={LANGUAGE_SELECT_ITEMS}
							value={language || "default"}
							onValueChange={(value) => setLanguage(value === "default" ? "" : (value ?? ""))}
						>
							<SelectTrigger id="hosted-agent-language" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="default">Runtime default</SelectItem>
								{LANGUAGE_OPTIONS.map((option) => (
									<SelectItem key={option.code} value={option.code}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="hosted-agent-timezone">Timezone</Label>
						<TimezoneCombobox
							id="hosted-agent-timezone"
							value={timezone}
							onValueChange={setTimezone}
							options={timezoneOptions}
						/>
					</div>
				</div>
				<div>
					<Button
						disabled={!dirty || updateDeployment.isPending || updateInProgress}
						onClick={() =>
							updateDeployment.mutate({
								id: deployment.resource.id,
								update: {
									language: normalizeHostedLanguage(language),
									timezone: timezone.trim() || null,
								},
							})
						}
					>
						{updateDeployment.isPending ? <Spinner className="size-3.5" /> : null}
						Save changes
					</Button>
				</div>
			</div>
		</SettingsSection>
	);
}

function ComputeSettingsSections({
	deployment,
	onDeleteAccepted,
}: {
	deployment: HostedDeployment;
	onDeleteAccepted: (deploymentId: string) => void;
}) {
	const router = useRouter();
	const navigateCheckoutReturn = useCallback(
		(checkoutDeploymentId: string): false | undefined => {
			if (checkoutDeploymentId === deployment.resource.id) return false;
			void router.navigate({
				href: agentSectionHref(checkoutDeploymentId, "overview", "source=on-clawdi"),
				replace: true,
			});
		},
		[deployment.resource.id, router],
	);
	useCheckoutReturnHandler({
		onCancelCopy: "You were not charged. Your compute plan is unchanged.",
		onNavigate: navigateCheckoutReturn,
	});
	const hostedAccess = useHostedProductAccess();
	const lifecycle = useDeploymentLifecycle();
	const plans = usePlans();
	const quotePlanChange = useQuotePlanChange();
	const [pendingPlanChangeName, setPendingPlanChangeName] = useState<string | null>(null);
	const changePlan = useChangePlan(setPendingPlanChangeName);
	const checkPlanChange = useCheckPlanChange();
	const [subscriptionCreateOpen, setSubscriptionCreateOpen] = useState(false);
	const [planChangeOpen, setPlanChangeOpen] = useState(false);
	const wallet = useWalletSnapshot({
		enabled:
			deployment.commercial_display?.compute_subscription?.funding_source === "wallet" ||
			(hostedAccess.canCreateCloudAgents && planChangeOpen),
	});
	const cancelSubscription = useCancelSubscription();
	const resumeSubscription = useResumeSubscription();
	const runAction = useActionLock();
	const deploymentStatus = deploymentStatusFromResource(deployment.resource.status);
	const canStop = canStopDeployment(deploymentStatus);
	const canStart = canStartDeployment(deploymentStatus);
	const canRestart = canRestartDeployment(deploymentStatus);
	const primaryLifecycleAction: "stop" | "start" =
		canStop ||
		deploymentStatus.kind === "stopping" ||
		deploymentStatus.kind === "restarting" ||
		deploymentStatus.kind === "updating"
			? "stop"
			: "start";
	const canRunPrimaryLifecycleAction = primaryLifecycleAction === "stop" ? canStop : canStart;
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
	const walletTopUp = useWalletTopUpDialog(PLAN_CHANGE_WALLET_FUNDING_ERROR_COPY);
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
				canCreateCloudAgents: hostedAccess.canCreateCloudAgents,
				cancelAtPeriodEnd: subscriptionCancelPending,
				status: currentSubscription.status,
				subscriptionId,
			})
		: "Start a new subscription to change this deployment’s paid compute.";
	const upgradeUnavailableMessage = performanceUpgradeUnavailableReason({
		plansLoading: plans.isLoading,
		canCreateCloudAgents: hostedAccess.canCreateCloudAgents,
		isIncludedBasic,
		performancePlanAvailable: Boolean(perfPlan),
		pendingPlanSlug,
		planChangeUnavailable,
		deploymentStatusSupportsUpgrade:
			isRunningStatus(deploymentStatus) || deploymentStatus.kind === "stopped",
		upgradeAvailable: deployment.upgrade_available,
	});
	const canUpgrade = upgradeUnavailableMessage === null;
	const canStartNewSubscription =
		hostedAccess.canCreateCloudAgents && hasTerminalFallback && !!(basicPlan || perfPlan);
	const subscriptionCreatePlanSlug = resolveSubscriptionCreatePlanSlug(
		terminalFundingFact?.prior_plan_slug,
		{
			basicAvailable: !!basicPlan,
			performanceAvailable: !!perfPlan,
		},
	);
	const createUnavailableMessage = plans.isLoading
		? "Checking paid compute availability…"
		: !hostedAccess.canCreateCloudAgents
			? hasTerminalFallback
				? "New subscriptions are temporarily unavailable."
				: "Upgrades are temporarily unavailable."
			: hasTerminalFallback && !(basicPlan || perfPlan)
				? "Paid compute plans are unavailable right now."
				: isIncludedBasic && planChangeUnavailable
					? planChangeUnavailable
					: upgradeUnavailableMessage;
	useEffect(() => {
		if (hostedAccess.isLoading || hostedAccess.canCreateCloudAgents) return;
		setSubscriptionCreateOpen(false);
		setPlanChangeOpen(false);
		setPlanChangeQuote(null);
		setPendingPlanChangeName(null);
		walletTopUp.reset();
	}, [hostedAccess.canCreateCloudAgents, hostedAccess.isLoading, walletTopUp.reset]);

	function setPlanChangeDialogOpen(open: boolean) {
		setPlanChangeOpen(open);
		if (!open && pendingPlanChangeName === null) {
			setPlanChangeQuote(null);
		}
	}

	async function requestPlanChangeQuote(selection: PlanChangeSelection) {
		if (!hostedAccess.canCreateCloudAgents || !subscriptionId || planChangeUnavailable !== null) {
			return;
		}
		try {
			if (pendingPlanChangeName === null && !(await hostedAccess.recheckCanCreateCloudAgents())) {
				setPlanChangeDialogOpen(false);
				return;
			}
			const quote = await quotePlanChange.mutateAsync({
				subscription_id: subscriptionId,
				...selection,
			});
			setPendingPlanChangeName(null);
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
			if (!(await hostedAccess.recheckCanCreateCloudAgents())) {
				setPlanChangeDialogOpen(false);
				return;
			}
			const result = pendingPlanChangeName
				? await checkPlanChange.mutateAsync(pendingPlanChangeName)
				: await changePlan.mutateAsync({ operation_id: operationId });
			if (result.kind === "scheduled") {
				toast.success("Downgrade scheduled", {
					description: `Your current compute remains active until ${formatShortDate(result.effectiveAt)}.`,
				});
			} else if (result.kind === "complete") {
				toast.success("Plan changed", {
					description: "Your compute subscription has been updated.",
				});
			} else {
				toast.info("Plan change in progress", {
					description:
						result.waitingFor === "payment"
							? "We’re still waiting for payment confirmation. Your compute plan has not changed yet."
							: "Your request was received, but the compute plan has not updated yet. You can watch its status here.",
				});
			}
			setPendingPlanChangeName(null);
			setPlanChangeQuote(null);
			setPlanChangeDialogOpen(false);
		} catch (error) {
			if (error instanceof PlanChangePendingError) {
				setPendingPlanChangeName(error.operationName);
				toast.info("Still waiting for confirmation", {
					description:
						"We don’t have a final result yet. Don’t submit another plan change. Check again in a few minutes; if it still hasn’t finished, contact support. Checking only reads the status and does not submit another charge.",
				});
				return;
			}
			if (error instanceof PlanChangeTerminalError) {
				setPendingPlanChangeName(null);
			}
			if (walletTopUp.handleFundingError(error)) return;
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

	return (
		<div className="flex flex-col gap-9">
			{wallet.data ? (
				<TopUpDialog {...walletTopUp.dialogProps} onComplete={() => setPlanChangeQuote(null)} />
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
					walletBalanceUsd={wallet.data?.balance_usd ?? null}
					isQuoting={quotePlanChange.isPending}
					isConfirming={changePlan.isPending || checkPlanChange.isPending}
					hasAcceptedChange={pendingPlanChangeName !== null}
					onQuote={requestPlanChangeQuote}
					onConfirm={confirmPlanChange}
					onTopUp={() => walletTopUp.show()}
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
											· {formatCents(currentPriceCents)}
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
										pendingPlanChangeName === null &&
										(plans.isLoading ||
											(hasTerminalFallback ? !canStartNewSubscription : !canUpgrade || !perfPlan))
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
									{pendingPlanChangeName
										? "Check plan change status"
										: hasTerminalFallback
											? "Start a new subscription"
											: "Upgrade to Performance"}
								</Button>
								{hasTerminalFallback ? (
									canStartNewSubscription ? null : (
										<p className="text-xs text-muted-foreground">{createUnavailableMessage}</p>
									)
								) : canUpgrade ? null : (
									<p className="text-xs text-muted-foreground">{upgradeUnavailableMessage}</p>
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
											disabled={
												pendingPlanChangeName === null &&
												(planChangeUnavailable !== null || !!pendingPlanSlug)
											}
											onClick={() => setPlanChangeDialogOpen(true)}
										>
											{pendingPlanChangeName
												? "Check plan change status"
												: "Change plan or billing term"}
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
					{primaryLifecycleAction === "stop" ? (
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
					<DeleteComputeAction
						deployment={deployment}
						onDeleteAccepted={onDeleteAccepted}
						variant="outline"
						className="text-destructive"
					/>
				</div>
			</SettingsSection>
		</div>
	);
}
