"use client";

import type { components, RuntimeUiCredentials } from "@clawdi/shared/api";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
	AlertCircle,
	ArrowRight,
	Check,
	Copy,
	Cpu,
	CreditCard,
	ExternalLink,
	Eye,
	EyeOff,
	FolderOpen,
	Info,
	LifeBuoy,
	Link2,
	Link2Off,
	type LucideIcon,
	MonitorPlay,
	Plus,
	QrCode,
	RefreshCw,
	Settings,
	TerminalSquare,
	Trash2,
	X,
} from "lucide-react";
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { ConnectorsSurface } from "@/components/connectors/connectors-surface";
import { AgentSourceBadge, agentDisplayName } from "@/components/dashboard/agent-label";
import {
	AgentOverviewCapabilities,
	AgentOverviewStatusCard,
	OverviewDescriptionSkeleton,
	OverviewModuleError,
} from "@/components/dashboard/agent-overview-capabilities";
import {
	overviewProjectsModule,
	overviewWorkspaceSkillsModule,
	useOverviewConnectorsModule,
	useOverviewMemoriesModule,
	useOverviewVaultsModule,
} from "@/components/dashboard/agent-overview-resource-bodies";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import {
	linkedAgentProjectCount,
	resolveAgentWorkspaceProjectId,
} from "@/components/dashboard/agent-project-scope";
import { AgentProjectsTab } from "@/components/dashboard/agent-projects-tab";
import { AgentSettingsPanel } from "@/components/dashboard/agent-settings-panel";
import { DetailPanel } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import {
	ENTITY_CHOICE_GRID_CLASS,
	EntityAddCard,
	EntityCardSkeleton,
	EntityChoiceCard,
} from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { MemoriesPageActions, MemoriesSurface } from "@/components/memories/memories-surface";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SectionLabel } from "@/components/section-label";
import { OverviewSessionList, SessionFeed } from "@/components/sessions/session-feed";
import { SettingsSection } from "@/components/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot, type StatusTone } from "@/components/ui/status-badge";
import { useDialogExitLifecycle } from "@/components/ui/use-dialog-exit-lifecycle";
import {
	UnsavedNavigationBoundary,
	useUnsavedNavigationState,
} from "@/components/unsaved-navigation-state";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { DeploymentCancelAction } from "@/hosted/agents/deployment-cancel-action";
import { HostedDeploymentDeleteAction } from "@/hosted/agents/deployment-delete-action";
import {
	useDeploymentLifecycle,
	useResetRuntimeUiAccess,
	useUpdateDeployment,
} from "@/hosted/agents/deployment-hooks";
import {
	canQueryHostedAgentSessions,
	HOSTED_AGENT_SESSIONS_EMPTY_MESSAGE,
	HOSTED_AGENT_SESSIONS_REFRESH_POLICY,
} from "@/hosted/agents/hosted-agent-session-query";
import {
	HostedTerminalPanel,
	type HostedTerminalStatus,
} from "@/hosted/agents/hosted-terminal-panel";
import {
	forgetOpenClawNativeHandoffLoaded,
	hasOpenClawNativeHandoffLoaded,
	markOpenClawNativeHandoffLoaded,
	openClawRuntimeUiWindowTarget,
	openSecureRuntimeWindow,
	resolveRuntimeUiCredentials,
	runtimeUiLaunchTarget,
	runtimeUiLocalStorage,
} from "@/hosted/agents/runtime-ui-credentials";
import { trackRuntimeWindow } from "@/hosted/agents/runtime-window-lifecycle";
import {
	useFilesGrantBootstrap,
	useOpenFilesInNewWindow,
} from "@/hosted/agents/use-files-grant-bootstrap";
import { useBillingClient } from "@/hosted/billing/billing-client";
import {
	type CheckoutReturnNavigationTarget,
	useCheckoutReturnHandler,
} from "@/hosted/billing/checkout-return";
import {
	computeDunningState,
	computeSubscriptionRequiredToStart,
} from "@/hosted/billing/components/compute-dunning.logic";
import { ComputeDunningBanner } from "@/hosted/billing/components/compute-dunning-banner";
import type { DeploymentUpdateRequest, HostedDeployment } from "@/hosted/billing/contracts";
import { navigateToAcceptedDeployment } from "@/hosted/billing/deploy/accepted-deployment-navigation";
import {
	fallbackTimezones,
	LANGUAGE_OPTIONS,
	LANGUAGE_SELECT_ITEMS,
	mergeTimezoneOptions,
	normalizeHostedLanguage,
	supportedTimezones,
	TimezoneCombobox,
} from "@/hosted/billing/deploy/language-timezone-controls";
import { billingErrorNormalizer, billingQueryRetry } from "@/hosted/billing/errors";
import { billingKeys, useManagedModelCatalog, usePlans } from "@/hosted/billing/hooks";
import { ComputeSubscriptionActionList } from "@/hosted/billing/subscription/compute-subscription-action-list";
import { resolveComputeSubscriptionActions } from "@/hosted/billing/subscription/compute-subscription-actions";
import {
	ComputeSubscriptionCard,
	computeSubscriptionCardView,
} from "@/hosted/billing/subscription/compute-subscription-card";
import {
	type ComputeSubscriptionManagementResult,
	computeSubscriptionManagement,
} from "@/hosted/billing/subscription/compute-subscription-management";
import { computeSubscriptionRecoveryPresentation } from "@/hosted/billing/subscription/compute-subscription-recovery";
import {
	PlanChangeController,
	planChangeBillingTerm,
} from "@/hosted/billing/subscription/plan-change-controller";
import { SubscriptionCreateDialog } from "@/hosted/billing/subscription/subscription-create-dialog";
import {
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	computeFundingSource,
	computeSubscriptionCancellationCopy,
	computeSubscriptionCancellationSuccessCopy,
	computeSubscriptionLifecycle,
	computeTierLabel,
	pendingComputePlanSlug,
	pendingPlanScheduleCopy,
	resolveBasicPlan,
	resolvePerformancePlan,
	resolveSubscriptionCreatePlanSlug,
	selectExplicitOfferForTerm,
	selectOfferForTerm,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";
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
	deploymentRuntimeStatusPresentation,
	deploymentStatusFromResource,
	deploymentStatusLabel,
	isRunningStatus,
} from "@/hosted/deployment-status";
import { DeploymentStatusUnavailableState } from "@/hosted/deployment-status-unavailable";
import {
	type HostedProjectionResolution,
	missingProjectionRefetchInterval,
	resolveHostedAgentProjection,
} from "@/hosted/hosted-agent-resolution";
import {
	deploymentFilesUrl,
	type HostedRuntime,
	runtimeAiProviderAuthKind,
	runtimeConsoleUrl,
	runtimeDisplayName,
} from "@/hosted/runtimes";
import { agentPluginOverviewState } from "@/hosted/v2/agent-plugins/agent-plugin-model";
import { agentPluginDesiredStateQueryOptions } from "@/hosted/v2/agent-plugins/agent-plugin-query";
import { AgentPluginsSurface } from "@/hosted/v2/agent-plugins/agent-plugins-surface";
import { AddProviderDialog } from "@/hosted/v2/ai-providers/add-provider-dialog";
import {
	aiBindingBuildErrorCopy,
	buildAiBindingFields,
	isUnresolvedProviderChoice,
	unresolvedProviderChoice,
	unresolvedProviderRef,
	updateProviderChoiceFromRef,
} from "@/hosted/v2/ai-providers/ai-provider-binding";
import { useUserAiProviders } from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { AuthBadge, ProviderIcon } from "@/hosted/v2/ai-providers/ai-providers-ui";
import { authCardLabel } from "@/hosted/v2/ai-providers/auth-card-label";
import {
	firstModelForProvider,
	isManagedProviderId,
	MANAGED_AI_CHOICE,
	MANAGED_PROVIDER_ID,
	MANAGED_PROVIDER_LABEL,
	modelBindingDisplayName,
	modelOptionsForProvider,
	primaryModelProviderId,
	primaryModelValue,
	providerAvailabilityIssue,
	providerCatalogDescription,
	providerChoiceFromRef,
	providerDisplayLabel,
} from "@/hosted/v2/ai-providers/model-binding";
import { ModelBindingPicker } from "@/hosted/v2/ai-providers/model-binding-picker";
import { useAiProviderBindingDraft } from "@/hosted/v2/ai-providers/use-ai-provider-binding-draft";
import type { ChannelAccountSummary } from "@/hosted/v2/channels/agent-channel-bindings.logic";
import {
	type AgentChannelCardItem,
	activeAgentLinkForAccount,
	activeLinkedProviders,
	buildAgentChannelCardGroups,
	canonicalAgentChannelLinks,
} from "@/hosted/v2/channels/agent-channel-cards.logic";
import { CHANNEL_CARD_GRID_CLASS, ChannelCard } from "@/hosted/v2/channels/channel-card";
import { pairCodeExpiryLabel } from "@/hosted/v2/channels/channel-detail-page.logic";
import type { AgentChannelLink } from "@/hosted/v2/channels/channel-edit-client.logic";
import {
	agentProviderLinkReplacementRequired,
	agentProviderLinkStatusUnknown,
} from "@/hosted/v2/channels/channel-linking.logic";
import { channelKeys } from "@/hosted/v2/channels/channel-query-cache";
import {
	CHANNEL_DESTRUCTIVE_ACTION_CLASS,
	ChannelStatusBadge,
	CopyInline,
	isNormalChannelStatus,
} from "@/hosted/v2/channels/channel-ui";
import {
	agentChannelLinksQueryOptions,
	isWhatsAppRepairConflict,
	useAgentChannelLinks,
	useBotPool,
	useChannels,
	useCreatePairCode,
	useDeleteChannel,
	useUnlinkAgentChannel,
} from "@/hosted/v2/channels/channels-hooks";
import { ConnectBotDialog } from "@/hosted/v2/channels/connect-bot-dialog";
import { DiscordPairDialog } from "@/hosted/v2/channels/discord-pair-dialog";
import { PairedChatsDialog } from "@/hosted/v2/channels/paired-chats-dialog";
import { ProviderLinkReplacementConfirm } from "@/hosted/v2/channels/provider-link-replacement-confirm";
import { TelegramPairDialog } from "@/hosted/v2/channels/telegram-pair-dialog";
import { WhatsAppPairDialog } from "@/hosted/v2/channels/whatsapp-pair-dialog";
import { WhatsAppRepairDialog } from "@/hosted/v2/channels/whatsapp-repair-dialog";
import { agentDetailQueryOptions } from "@/lib/agent-queries";
import {
	type AgentRouteSearch,
	type AgentSectionId,
	agentProjectResourceLink,
	agentSectionHref,
	agentSectionLabel,
	agentSectionLink,
	agentSessionDetailLink,
	agentTerminalWindowHref,
	HOSTED_AGENT_SECTION_IDS,
	isAgentRouteId,
} from "@/lib/agent-routes";
import { ApiError, toastApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import type { SessionListItem } from "@/lib/api-schemas";
import { eventStreamFallbackInterval } from "@/lib/event-stream-refresh";
import { formatMemoryMib, formatShortDate } from "@/lib/format";
import {
	AGENT_SECTION_NAVIGATION_ITEMS,
	hostedAgentVisibleSectionIds,
} from "@/lib/navigation-model";
import { useProductAccess } from "@/lib/product-access";
import { shouldBlockQueryError } from "@/lib/query-state";
import { agentResourceScope } from "@/lib/resource-navigation";
import { sessionListQueryOptions } from "@/lib/session-queries";
import { useSensitiveAction } from "@/lib/use-sensitive-action";
import { cn } from "@/lib/utils";

type Runtime = HostedRuntime;
type HostedAgentTab =
	| "overview"
	| "console"
	| "files"
	| "terminal"
	| "sessions"
	| "memories"
	| "connectors"
	| "projects"
	| "ai"
	| "channels"
	| "plugins"
	| "settings";
function parseHostedAgentTab(value: AgentSectionId | string | null): HostedAgentTab | null {
	if (!value) return null;
	return HOSTED_AGENT_SECTION_IDS.includes(value as HostedAgentTab)
		? (value as HostedAgentTab)
		: null;
}

/** Only surfaces whose primary content needs the cloud-agent projection own its notice. */
export function shouldShowHostedProjectionNotice(section: AgentSectionId): boolean {
	return section === "projects";
}

function LiveNote({ children }: { children: React.ReactNode }) {
	return (
		<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
			<Info className="size-3.5 shrink-0" />
			{children}
		</p>
	);
}

function isStartingStatus(status: DeploymentStatus): boolean {
	return status.kind === "creating" || status.kind === "starting";
}

export function shouldShowInitialDeploymentProgress(
	status: DeploymentStatus,
	failure: DeploymentFailurePresentation | null,
): boolean {
	return (isStartingStatus(status) && failure === null) || failure?.failedVerb === "create";
}

export function canRetryInitialDeployment(failure: DeploymentFailurePresentation): boolean {
	return failure.retryable !== false && failure.remediation.kind === "restart";
}

function startingTitle(): string {
	return "Starting your agent…";
}

function DeleteComputeAction({
	deployment,
	onDeleteAccepted,
	variant = "destructive",
	className,
	label = "Delete",
}: {
	deployment: HostedDeployment;
	onDeleteAccepted: (deploymentId: string) => Promise<void> | void;
	variant?: React.ComponentProps<typeof Button>["variant"];
	className?: string;
	label?: string;
}) {
	const status = deploymentStatusFromResource(deployment.resource.status);
	const canDelete = canDeleteDeployment(status);
	return (
		<HostedDeploymentDeleteAction
			deployment={deployment}
			onAccepted={() => onDeleteAccepted(deployment.resource.id)}
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
	label = "Start agent",
	variant = "default",
	disabled = false,
	onSubscribe,
}: {
	deployment: HostedDeployment;
	label?: string;
	variant?: ComponentProps<typeof Button>["variant"];
	disabled?: boolean;
	onSubscribe?: () => void;
}) {
	const lifecycle = useDeploymentLifecycle();
	const runAction = useActionLock();
	const status = deploymentStatusFromResource(deployment.resource.status);
	const canStart = canStartDeployment(status);
	const startAction = deployment.start_action;
	const needsSubscription = computeSubscriptionRequiredToStart(deployment);
	if (needsSubscription || startAction === "fix_payment" || startAction === "top_up") {
		const subscribe = needsSubscription ? onSubscribe : undefined;
		const Icon = needsSubscription ? Plus : CreditCard;
		return (
			<Button
				type="button"
				size="sm"
				variant={variant}
				disabled={disabled || !canStart || (needsSubscription && lifecycle.isPending)}
				onClick={subscribe}
				render={
					subscribe ? undefined : (
						<Link
							to={agentSectionHref(deployment.agent_id, "settings", {
								settings: "billing-plan",
								subscription_action: needsSubscription ? "start_new" : undefined,
							})}
						/>
					)
				}
				nativeButton={Boolean(subscribe)}
			>
				<Icon className="size-3.5" />
				{needsSubscription
					? "Subscribe to start"
					: startAction === "top_up"
						? "Top up to start"
						: "Pay to start"}
			</Button>
		);
	}
	if (startAction === "contact_support") {
		return (
			<Button
				size="sm"
				variant={variant}
				disabled={disabled}
				render={<a href="mailto:support@clawdi.ai" />}
				nativeButton={false}
			>
				<LifeBuoy className="size-3.5" />
				Contact support
			</Button>
		);
	}
	if (startAction !== "start") {
		return (
			<Button size="sm" variant={variant} disabled>
				{startAction === "unavailable" ? "Start unavailable" : "Updating subscription"}
			</Button>
		);
	}
	return (
		<Button
			type="button"
			size="sm"
			variant={variant}
			disabled={disabled || lifecycle.isPending || !canStart}
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
	routeSearch,
	onDeleteAccepted,
	deploymentTransitionTimedOut,
	deploymentTransitionEscalated,
	isCheckingDeployment,
	onCheckDeploymentAgain,
	eventStreamActive = false,
	standalone = false,
}: {
	environmentId: string;
	deployment: HostedDeployment;
	runtime: Runtime;
	section?: AgentSectionId;
	routeSearch: AgentRouteSearch;
	onDeleteAccepted: (deploymentId: string) => Promise<void> | void;
	deploymentTransitionTimedOut: boolean;
	deploymentTransitionEscalated: boolean;
	isCheckingDeployment: boolean;
	onCheckDeploymentAgain: () => void;
	eventStreamActive?: boolean;
	standalone?: boolean;
}) {
	const $api = useOpenApi();
	const queryClient = useQueryClient();
	const [isCheckingProjection, setIsCheckingProjection] = useState(false);
	const deploymentStatus = deploymentStatusFromResource(deployment.resource.status);
	const deploymentFailure = deploymentFailurePresentation(deployment);
	const deploymentProjectionQueryable = canQueryDeploymentProjection(deploymentStatus);
	const cloudAgentId = isAgentRouteId(environmentId);
	const sessionsQueryable = canQueryHostedAgentSessions(environmentId);
	const agentQuery = useQuery({
		...agentDetailQueryOptions($api, queryClient, environmentId),
		enabled: cloudAgentId && deploymentProjectionQueryable,
		refetchInterval: (query) =>
			eventStreamFallbackInterval(
				missingProjectionRefetchInterval(
					query.state.error,
					deploymentStatus,
					query.state.fetchFailureCount,
				),
				eventStreamActive,
			),
		refetchIntervalInBackground: false,
	});
	const projection = resolveHostedAgentProjection({
		enabled: cloudAgentId && deploymentProjectionQueryable,
		data: agentQuery.data,
		error: agentQuery.error,
		isPending: agentQuery.isPending,
	});
	const checkProjectionAgain = async () => {
		if (isCheckingProjection) return;
		setIsCheckingProjection(true);
		try {
			await agentQuery.refetch();
		} finally {
			setIsCheckingProjection(false);
		}
	};
	const agent = projection.status === "resolved" ? projection.data : null;
	const availableAgentTitle = agent
		? agentDisplayName(agent)
		: agentDisplayName({ default_name: deployment.resource.name, agent_type: runtime });
	const parsedTab = parseHostedAgentTab(section) ?? "overview";
	const filesUrl = deploymentFilesUrl(deployment);
	const visibleSectionIds = hostedAgentVisibleSectionIds(filesUrl !== null);
	const activeTab = visibleSectionIds.includes(parsedTab) ? parsedTab : "overview";
	useSetBreadcrumbTitle(
		activeTab === "overview" ? availableAgentTitle : agentSectionLabel(activeTab),
	);

	const isPerformance = deployment.current_plan_slug === COMPUTE_PERFORMANCE_SLUG;
	const terminalHref = agentSectionHref(environmentId, "terminal");
	const terminalWindowHref = agentTerminalWindowHref(environmentId);
	const scopedSessionLink = (sessionId: string) => ({
		...agentSessionDetailLink(environmentId, sessionId),
	});

	const sessions = useQuery({
		...sessionListQueryOptions($api, { environment_id: environmentId, page_size: 3 }),
		enabled: activeTab === "overview" && sessionsQueryable,
	});

	const activeNavItem = AGENT_SECTION_NAVIGATION_ITEMS[activeTab];
	const activeTabLabel = agentSectionLabel(activeTab);
	const ActiveTabIcon = activeNavItem.icon;
	const resourceScope = agentResourceScope(environmentId);
	const showInitialDeploymentPage =
		activeTab === "overview" &&
		shouldShowInitialDeploymentProgress(deploymentStatus, deploymentFailure);
	const interfaceAvailable =
		activeTab === "overview" && !showInitialDeploymentPage && isRunningStatus(deploymentStatus);
	const isLiveToolTab =
		activeTab === "console" || activeTab === "files" || activeTab === "terminal";
	return (
		<div
			data-hosted="true"
			data-testid={isLiveToolTab ? "hosted-agent-live-surface" : undefined}
			className={cn(
				isLiveToolTab
					? "flex min-h-0 w-full flex-1 flex-col overflow-hidden"
					: cn(
							activeTab === "settings" ? "w-full" : CENTERED_PAGE_WIDTH_CLASS.page,
							"flex flex-col gap-6 px-4 lg:px-6",
						),
			)}
		>
			{isLiveToolTab ? <h1 className="sr-only">{availableAgentTitle}</h1> : null}
			<section className={isLiveToolTab ? "flex min-h-0 flex-1 flex-col" : "flex flex-col gap-6"}>
				{isLiveToolTab ||
				activeTab === "plugins" ||
				(activeTab === "projects" && projection.status === "resolved") ? null : (
					<PageHeader
						title={activeTab === "overview" ? availableAgentTitle : activeTabLabel}
						titleAdornment={
							activeTab === "overview" ? <AgentSourceBadge source="hosted" compact /> : null
						}
						description={activeNavItem.description}
						icon={ActiveTabIcon ? <ActiveTabIcon className="size-4 text-muted-foreground" /> : null}
						actions={
							activeTab === "memories" ? (
								<MemoriesPageActions scope={resourceScope} />
							) : interfaceAvailable ? (
								<Button
									render={<Link {...agentSectionLink(environmentId, "console")} />}
									nativeButton={false}
									variant="outline"
								>
									<MonitorPlay />
									Open Agent Interface
								</Button>
							) : null
						}
					/>
				)}
				{isLiveToolTab || activeTab === "settings" ? null : (
					<ComputeDunningBanner deployment={deployment} />
				)}
				{!deploymentStatus.known && activeTab !== "overview" ? (
					<DeploymentStatusUnavailableState
						deployment={deployment}
						isRetrying={isCheckingDeployment}
						onRetry={onCheckDeploymentAgain}
					/>
				) : null}
				{deploymentStatus.known &&
				deploymentProjectionQueryable &&
				!(activeTab === "overview" && isStartingStatus(deploymentStatus)) &&
				shouldShowHostedProjectionNotice(activeTab) ? (
					<HostedProjectionNotice
						projection={projection}
						isChecking={isCheckingProjection}
						onRetry={() => {
							void checkProjectionAgain();
						}}
					/>
				) : null}
				<div className={isLiveToolTab ? "flex min-h-0 flex-1 flex-col" : "w-full"}>
					{showInitialDeploymentPage ? (
						<InitialDeploymentPage
							deployment={deployment}
							failure={deploymentFailure}
							deploymentTransitionTimedOut={deploymentTransitionTimedOut}
							deploymentTransitionEscalated={deploymentTransitionEscalated}
							isCheckingDeployment={isCheckingDeployment}
							onCheckDeploymentAgain={onCheckDeploymentAgain}
						/>
					) : activeTab === "overview" ? (
						<OverviewTab
							agentId={environmentId}
							deployment={deployment}
							agent={isAgentRouteId(environmentId) ? agent : null}
							projectionStatus={projection.status}
							isPerformance={isPerformance}
							sessions={sessions.data?.items ?? []}
							sessionsLoading={sessions.isLoading}
							sessionsError={
								shouldBlockQueryError(sessions.error, sessions.data) ? sessions.error : null
							}
							onRetrySessions={() => sessions.refetch()}
							sessionLink={(session) => scopedSessionLink(session.id)}
							deploymentTransitionTimedOut={deploymentTransitionTimedOut}
							deploymentTransitionEscalated={deploymentTransitionEscalated}
							eventStreamActive={eventStreamActive}
						/>
					) : null}
					{deploymentStatus.known && activeTab === "console" ? (
						<ConsoleTab
							deployment={deployment}
							runtime={runtime}
							terminalHref={terminalHref}
							deploymentTransitionTimedOut={deploymentTransitionTimedOut}
							deploymentTransitionEscalated={deploymentTransitionEscalated}
							isCheckingDeployment={isCheckingDeployment}
							onCheckDeploymentAgain={onCheckDeploymentAgain}
						/>
					) : null}
					{deploymentStatus.known && activeTab === "terminal" ? (
						<TerminalTab
							key={deployment.resource.id}
							deployment={deployment}
							agentName={availableAgentTitle}
							terminalWindowHref={terminalWindowHref}
							standalone={standalone}
						/>
					) : null}
					{deploymentStatus.known && activeTab === "files" && filesUrl ? (
						<FilesTab deployment={deployment} url={filesUrl} />
					) : null}
					{activeTab === "sessions" ? (
						<HostedAgentSessionsTab environmentId={environmentId} />
					) : null}
					{activeTab === "memories" ? <MemoriesSurface scope={resourceScope} /> : null}
					{activeTab === "connectors" ? <ConnectorsSurface embedded scope={resourceScope} /> : null}
					{activeTab === "projects" ? (
						projection.status === "resolved" ? (
							<AgentProjectsTab
								agentId={environmentId}
								headerAdornment={<AgentSourceBadge source="hosted" compact />}
								headerIcon={
									ActiveTabIcon ? <ActiveTabIcon className="size-4 text-muted-foreground" /> : null
								}
							/>
						) : (
							<ProjectionDependentUnavailable label="Projects" />
						)
					) : null}
					{activeTab === "plugins" ? (
						<AgentPluginsSurface
							agentId={environmentId}
							runtime={runtime}
							eventStreamActive={eventStreamActive}
						/>
					) : null}
					{deploymentStatus.known && activeTab === "ai" ? (
						<AiProviderTab
							deployment={deployment}
							runtime={runtime}
							environmentId={environmentId}
						/>
					) : null}
					{deploymentStatus.known && activeTab === "channels" ? (
						!deploymentProjectionQueryable ? (
							<StoppedAgentState deployment={deployment} />
						) : projection.status === "resolved" ? (
							<ChannelsTab
								environmentId={environmentId}
								agentType={runtime}
								agentName={availableAgentTitle}
							/>
						) : (
							<ChannelsSyncState
								isChecking={isCheckingDeployment || isCheckingProjection}
								onCheckAgain={() => {
									onCheckDeploymentAgain();
									if (cloudAgentId) void checkProjectionAgain();
								}}
							/>
						)
					) : null}
					{deploymentStatus.known && activeTab === "settings" ? (
						<HostedAgentSettingsTab
							environmentId={environmentId}
							deployment={deployment}
							agent={agent}
							routeSearch={routeSearch}
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
	isChecking,
	onRetry,
}: {
	projection: HostedProjectionResolution<components["schemas"]["AgentResponse"]>;
	isChecking: boolean;
	onRetry: () => void;
}) {
	if (projection.status === "resolved") return null;
	if (projection.status === "error") {
		return (
			<ApiErrorPanel
				error={projection.error}
				onRetry={onRetry}
				title="Couldn’t load all agent details"
			/>
		);
	}
	if (projection.status === "missing") {
		return (
			<Alert data-hosted="true">
				<AlertCircle />
				<AlertTitle>Some agent details are not ready</AlertTitle>
				<AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<span>
						Projects, Skills, Vaults, and Channels will appear when this agent is ready. Available
						actions and tools still work.
					</span>
					<Button type="button" variant="outline" size="sm" disabled={isChecking} onClick={onRetry}>
						{isChecking ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
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
				<AlertTitle>Loading agent details</AlertTitle>
				<AlertDescription>
					Available actions still work while the rest of this agent loads.
				</AlertDescription>
			</Alert>
		);
	}
	return (
		<Alert data-hosted="true">
			<AlertCircle />
			<AlertTitle>Some agent details are unavailable</AlertTitle>
			<AlertDescription>
				Clawdi can’t load every part of this agent right now. Available actions still work.
			</AlertDescription>
		</Alert>
	);
}

function ProjectionDependentUnavailable({ label }: { label: string }) {
	return (
		<EmptyState
			title={`${label} unavailable`}
			description="Clawdi can’t load this part of the agent yet. Other available actions still work."
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
			description={
				computeSubscriptionRequiredToStart(deployment)
					? "This agent is stopped. Choose a subscription to start it. Your saved data is kept."
					: deployment.start_action === "start"
						? "This agent is stopped. Start it to use its tools again."
						: "This agent is stopped. Your saved data is kept."
			}
			action={<StartComputeAction deployment={deployment} label="Start" />}
		/>
	);
}

function HostedAgentSessionsTab({ environmentId }: { environmentId: string }) {
	const $api = useOpenApi();
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(20);
	const sessionsQueryable = canQueryHostedAgentSessions(environmentId);

	useEffect(() => {
		setPage(1);
	}, [environmentId]);

	const sessions = useQuery({
		...sessionListQueryOptions($api, { environment_id: environmentId, page, page_size: pageSize }),
		enabled: sessionsQueryable,
		placeholderData: keepPreviousData,
		// staleTime only controls freshness; this mounted-tab observer owns visibility refreshes.
		...HOSTED_AGENT_SESSIONS_REFRESH_POLICY,
	});
	const total = sessions.data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / pageSize));

	useEffect(() => {
		if (sessions.data && page > pageCount) setPage(pageCount);
	}, [page, pageCount, sessions.data]);

	if (shouldBlockQueryError(sessions.error, sessions.data)) {
		return (
			<ApiErrorPanel
				error={sessions.error}
				onRetry={() => sessions.refetch()}
				title="Couldn't load sessions"
			/>
		);
	}

	if (!sessionsQueryable) {
		return (
			<EmptyState
				title="Sessions unavailable"
				description="Sessions will appear after this agent is created."
			/>
		);
	}

	return (
		<div className="space-y-4">
			<SessionFeed
				sessions={sessions.data?.items ?? []}
				isLoading={sessions.isLoading && !sessions.data}
				emptyMessage={HOSTED_AGENT_SESSIONS_EMPTY_MESSAGE}
				showAgent={false}
				sessionLink={(session) => agentSessionDetailLink(environmentId, session.id)}
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

export function OverviewComputeStatus({
	deployment,
	failure,
	deploymentTransitionTimedOut,
	deploymentTransitionEscalated,
}: {
	deployment: HostedDeployment;
	failure: DeploymentFailurePresentation | null;
	deploymentTransitionTimedOut: boolean;
	deploymentTransitionEscalated: boolean;
}) {
	const status = deploymentStatusFromResource(deployment.resource.status);
	return (
		<div className="space-y-3 text-xs">
			{failure?.status.kind === "runtime_unavailable" ? (
				<p className="text-warning-muted-foreground" role="status">
					{failure.reason}
				</p>
			) : failure ? (
				<div className="space-y-1 text-destructive-muted-foreground" role="status">
					<p className="font-medium">{failure.title}</p>
					<p className="line-clamp-2">{failure.reason}</p>
				</div>
			) : status.kind === "failed" ? (
				<p className="text-destructive-muted-foreground" role="status">
					The last compute change did not complete.
				</p>
			) : deploymentTransitionEscalated ? (
				<div className="flex flex-wrap items-center justify-between gap-2" role="status">
					<p className="text-warning-muted-foreground">
						This change appears to be stuck. You can cancel it and try again.
					</p>
					<DeploymentCancelAction deployment={deployment} />
				</div>
			) : status.kind === "restarting" ? (
				<p className="inline-flex items-center gap-2 text-muted-foreground" role="status">
					<Spinner className="size-3.5" /> Restarting
				</p>
			) : deploymentTransitionTimedOut ? (
				<p className="text-warning-muted-foreground" role="status">
					This compute change is taking longer than expected.
				</p>
			) : status.kind === "updating" ? (
				<p className="inline-flex items-center gap-2 text-muted-foreground" role="status">
					<Spinner className="size-3.5" /> Updating compute settings.
				</p>
			) : isStartingStatus(status) ? (
				<p className="inline-flex items-center gap-2 text-muted-foreground" role="status">
					<Spinner className="size-3.5" /> Startup is still in progress.
				</p>
			) : status.kind === "stopping" ? (
				<p className="text-muted-foreground" role="status">
					Compute is stopping.
				</p>
			) : status.kind === "stopped" ? (
				<p className="text-muted-foreground" role="status">
					Compute is stopped. Channels and the agent interface are unavailable.
				</p>
			) : status.kind === "deleting" ? (
				<p className="text-muted-foreground" role="status">
					Compute is being removed.
				</p>
			) : status.kind === "deleted" ? (
				<p className="text-muted-foreground" role="status">
					Compute is no longer available.
				</p>
			) : status.kind === "unknown" ? (
				<p className="text-warning-muted-foreground" role="status">
					Clawdi cannot confirm the current compute status.
				</p>
			) : null}
		</div>
	);
}

export function OverviewComputeSummary({
	plan,
	vcpu,
	memoryMib,
	storageGib,
}: {
	plan: string;
	vcpu: number;
	memoryMib: number;
	storageGib: number;
}) {
	const configuration = [
		`${vcpu} vCPU`,
		`${formatMemoryMib(memoryMib)} memory`,
		`${storageGib} GiB storage`,
	];
	return (
		<div className="space-y-1.5" data-testid="overview-compute-summary">
			<p data-overview-compute-plan className="text-sm text-muted-foreground">
				{plan} plan
			</p>
			<ul
				aria-label={`Configuration: ${configuration.join(", ")}`}
				className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
			>
				{configuration.map((item) => (
					<li key={item}>{item}</li>
				))}
			</ul>
		</div>
	);
}

export function InitialDeploymentPage({
	deployment,
	failure = null,
	deploymentTransitionTimedOut,
	deploymentTransitionEscalated,
	isCheckingDeployment,
	onCheckDeploymentAgain,
}: {
	deployment: HostedDeployment;
	failure?: DeploymentFailurePresentation | null;
	deploymentTransitionTimedOut: boolean;
	deploymentTransitionEscalated: boolean;
	isCheckingDeployment: boolean;
	onCheckDeploymentAgain: () => void;
}) {
	const status = deploymentStatusFromResource(deployment.resource.status);
	const runtimeLabel = runtimeDisplayName(deployment.resource.spec.runtime);
	if (failure?.failedVerb === "create") {
		const canRetry = canRetryInitialDeployment(failure);
		return (
			<DetailPanel className="border-destructive/30 bg-destructive-muted p-6 md:p-8">
				<div data-testid="hosted-initial-deployment-panel" role="alert" className="space-y-5">
					<div>
						<h2 className="flex items-center gap-2 text-lg font-semibold">
							<AlertCircle className="size-5 text-destructive" />
							Agent setup failed
						</h2>
						<p className="mt-1 text-sm text-muted-foreground">
							Setup stopped before this agent became ready.
						</p>
					</div>
					<Alert variant="destructive">
						<AlertCircle />
						<AlertTitle>{failure.title}</AlertTitle>
						<AlertDescription className="space-y-1">
							<p>{failure.reason}</p>
							<p>{failure.description}</p>
						</AlertDescription>
					</Alert>
					{canRetry ? <StartComputeAction deployment={deployment} label="Retry startup" /> : null}
				</div>
			</DetailPanel>
		);
	}
	const stages = [
		{ status: "creating", label: "Cloud resources" },
		{ status: "starting", label: "Agent software" },
		{ status: "running", label: "Ready" },
	] as const;
	const activeStageIndex = status.kind === "starting" ? 1 : status.kind === "running" ? 2 : 0;
	const activeStage =
		activeStageIndex === 0
			? {
					label: "Preparing cloud resources",
					description: "Creating a private environment and connecting your AI provider.",
				}
			: activeStageIndex === 1
				? {
						label: `Installing and starting ${runtimeLabel}`,
						description:
							"Provisioning a private workspace, installing the Agent, and confirming readiness.",
					}
				: {
						label: "Ready",
						description: "Setup is complete.",
					};
	return (
		<DetailPanel
			className={cn(
				"p-6 md:p-8",
				(deploymentTransitionTimedOut || deploymentTransitionEscalated) &&
					"border-warning/30 bg-warning-muted",
			)}
		>
			<div
				data-testid="hosted-initial-deployment-panel"
				role={deploymentTransitionTimedOut || deploymentTransitionEscalated ? "alert" : undefined}
				className="space-y-6"
			>
				<div>
					<h2 className="flex items-center gap-2 text-lg font-semibold">
						{deploymentTransitionTimedOut || deploymentTransitionEscalated ? (
							<AlertCircle className="size-5" />
						) : null}
						{deploymentTransitionEscalated
							? "Setup appears to be stuck"
							: deploymentTransitionTimedOut
								? "Setup is taking longer than expected"
								: `Setting up ${runtimeLabel}`}
					</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						{deploymentTransitionEscalated
							? "We’ll keep checking automatically. If you want, cancel this setup and try again."
							: deploymentTransitionTimedOut
								? "Your agent may still be starting. We’ll keep checking automatically."
								: "Setup usually takes about 7–10 minutes. It continues if you leave, and this page updates automatically while open."}
					</p>
				</div>
				<div>
					<div className="flex items-baseline justify-between gap-4">
						<p
							className="inline-flex items-center gap-2 text-base font-semibold"
							role="status"
							aria-live="polite"
							aria-atomic="true"
						>
							{!deploymentTransitionTimedOut &&
							!deploymentTransitionEscalated &&
							status.kind !== "running" ? (
								<span className="inline-flex" aria-hidden="true">
									<Spinner className="size-3.5 shrink-0 text-primary" />
								</span>
							) : null}
							{activeStage.label}
						</p>
						<p className="shrink-0 text-xs font-medium text-muted-foreground">
							Step {activeStageIndex + 1} of {stages.length}
						</p>
					</div>
					<p className="mt-2 text-sm text-muted-foreground">{activeStage.description}</p>
					<ol aria-label="Deployment progress" className="mt-4 grid w-full grid-cols-3 gap-2">
						{stages.map((stage, index) => {
							const stageState =
								status.kind === "running" || index < activeStageIndex
									? "completed"
									: index === activeStageIndex
										? "active"
										: "pending";
							return (
								<li
									key={stage.status}
									data-deployment-stage={stage.status}
									data-stage-state={stageState}
									aria-current={index === activeStageIndex ? "step" : undefined}
									aria-label={`${stage.label}, ${stageState}`}
								>
									<div
										aria-hidden="true"
										className={cn(
											"h-2 rounded-full",
											stageState === "active"
												? "bg-primary"
												: stageState === "completed"
													? "bg-primary/50"
													: "bg-muted",
										)}
									/>
									<p
										aria-hidden="true"
										className={cn(
											"mt-2 text-xs",
											stageState === "pending"
												? "text-muted-foreground"
												: "font-medium text-foreground",
										)}
									>
										{stage.label}
									</p>
								</li>
							);
						})}
					</ol>
				</div>
				{deploymentTransitionTimedOut || deploymentTransitionEscalated ? (
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={isCheckingDeployment}
							onClick={onCheckDeploymentAgain}
						>
							{isCheckingDeployment ? <Spinner className="size-3.5" /> : <RefreshCw />}Check again
						</Button>
						{deploymentTransitionEscalated ? (
							<DeploymentCancelAction deployment={deployment} />
						) : null}
					</div>
				) : null}
			</div>
		</DetailPanel>
	);
}

function OverviewTab({
	agentId,
	deployment,
	agent,
	projectionStatus,
	isPerformance,
	sessions,
	sessionsLoading,
	sessionsError,
	onRetrySessions,
	sessionLink,
	deploymentTransitionTimedOut,
	deploymentTransitionEscalated,
	eventStreamActive,
}: {
	agentId: string;
	deployment: HostedDeployment;
	agent: components["schemas"]["AgentResponse"] | null | undefined;
	projectionStatus: HostedProjectionResolution<unknown>["status"];
	isPerformance: boolean;
	sessions: SessionListItem[];
	sessionsLoading: boolean;
	sessionsError: unknown;
	onRetrySessions: () => void;
	sessionLink: (session: SessionListItem) => {
		to: "/agents/$id/sessions/$sessionId";
		params: { id: string; sessionId: string };
	};
	deploymentTransitionTimedOut: boolean;
	deploymentTransitionEscalated: boolean;
	eventStreamActive: boolean;
}) {
	const spec = deployment.resource.spec;
	const primaryModel = spec.runtime_configuration.primary_model;
	const bindingProvider =
		spec.runtime_configuration.providers.find(
			(provider) => provider.provider_id === primaryModelProviderId(primaryModel),
		) ?? spec.runtime_configuration.providers[0];
	const providerId = primaryModelProviderId(primaryModel) ?? bindingProvider?.provider_id;
	const managedProvider = !providerId || isManagedProviderId(providerId);
	const providers = useUserAiProviders({ enabled: !managedProvider });
	const managedModelCatalog = useManagedModelCatalog({ enabled: managedProvider });
	const model = modelBindingDisplayName(
		primaryModel,
		runtimeAiProviderAuthKind(deployment) ?? bindingProvider?.auth_kind,
		modelOptionsForProvider(
			primaryModelProviderId(primaryModel) ?? MANAGED_PROVIDER_ID,
			providers.data ?? [],
			managedModelCatalog.data?.models ?? [],
		),
	);
	const runtimeStatusPresentation = deploymentRuntimeStatusPresentation(deployment.resource.status);
	const deploymentStatus = runtimeStatusPresentation.status;
	const deploymentFailure = deploymentFailurePresentation(deployment);
	const computeStatusPresentation = deploymentFailure?.status ?? {
		label: runtimeStatusPresentation.label,
		tone: runtimeStatusPresentation.tone,
	};
	const billingClient = useBillingClient();
	const projectBindings = useAgentProjectBindings(agentId, { enabled: Boolean(agent) });
	const channelLinks = useAgentChannelLinks(agentId, Boolean(agent));
	const linkedChannelCount = channelLinks.data?.length ?? 0;
	const projectionLoading = projectionStatus === "loading";
	const projectionUnavailable = projectionStatus !== "resolved" && !projectionLoading;
	const workspaceProjectId = agent
		? resolveAgentWorkspaceProjectId(projectBindings.data ?? [], agent.default_project_id)
		: null;
	const workspaceResolution =
		projectionLoading || projectBindings.isLoading
			? "loading"
			: projectionUnavailable || projectBindings.error || !workspaceProjectId
				? "unavailable"
				: "ready";
	const runtimeSkills = useQuery({
		queryKey: billingKeys.workspaceSkills(deployment.resource.id),
		queryFn: () => billingClient.listWorkspaceSkills(deployment.resource.id),
		enabled: isRunningStatus(deploymentStatus),
		retry: billingQueryRetry,
	});
	const pluginDesiredState = useQuery(
		agentPluginDesiredStateQueryOptions(useOpenApi(), agentId, eventStreamActive),
	);
	const pluginOverview = agentPluginOverviewState({
		plugins: pluginDesiredState.data?.plugins,
		isLoading: pluginDesiredState.isLoading,
		error: shouldBlockQueryError(pluginDesiredState.error, pluginDesiredState.data)
			? pluginDesiredState.error
			: null,
	});
	const pluginsModule = {
		description:
			pluginOverview.kind === "loading" ? (
				<OverviewDescriptionSkeleton label="plugins" />
			) : pluginOverview.kind === "error" ? (
				"Unavailable right now"
			) : (
				pluginOverview.description
			),
	};
	const skillsModule = runtimeSkills.isLoading
		? { description: <OverviewDescriptionSkeleton label="skills" /> }
		: runtimeSkills.error
			? { description: "Unavailable right now" }
			: overviewWorkspaceSkillsModule(
					(runtimeSkills.data?.items ?? []).map((skill) => skill.skill_key),
				);
	const vaultsModule = useOverviewVaultsModule({
		projectIds: workspaceProjectId ? [workspaceProjectId] : [],
		resolution: workspaceResolution,
	});
	const memoriesModule = useOverviewMemoriesModule();
	const connectorsModule = useOverviewConnectorsModule();
	return (
		<div className="flex flex-col gap-8">
			<div className="grid items-stretch gap-4 @3xl/main:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)] @3xl/main:gap-y-3">
				<div className="grid min-w-0 gap-3 @3xl/main:row-span-2 @3xl/main:row-start-1 @3xl/main:grid-rows-subgrid">
					<div className="flex items-center justify-between">
						<h2 id="hosted-recent-sessions" className="text-sm font-semibold">
							Recent sessions
						</h2>
						<Button
							render={<Link {...agentSectionLink(agentId, "sessions")} />}
							nativeButton={false}
							variant="ghost"
							size="sm"
							className="text-muted-foreground"
						>
							View all
							<ArrowRight />
						</Button>
					</div>
					<section aria-labelledby="hosted-recent-sessions" className="min-w-0">
						{sessionsError ? (
							<OverviewModuleError label="Sessions" onRetry={() => void onRetrySessions()} />
						) : (
							<OverviewSessionList
								sessions={sessions}
								isLoading={sessionsLoading}
								emptyMessage={HOSTED_AGENT_SESSIONS_EMPTY_MESSAGE}
								sessionLink={sessionLink}
							/>
						)}
					</section>
				</div>
				<div className="@3xl/main:row-start-2">
					<AgentOverviewStatusCard
						agentId={agentId}
						section="settings"
						title="Compute"
						icon={Cpu}
						tint="bg-identity-4-bg text-identity-4-fg"
						description={
							<span
								data-overview-compute-status
								className="inline-flex items-center gap-2"
								title={`Agent status: ${computeStatusPresentation.label}`}
							>
								<StatusDot status={computeStatusPresentation.tone} />
								{computeStatusPresentation.label}
							</span>
						}
					>
						<div className="flex h-full flex-col gap-4">
							<OverviewComputeSummary
								plan={isPerformance ? "Performance" : "Basic"}
								vcpu={spec.resources.vcpu}
								memoryMib={spec.resources.memory_mib}
								storageGib={spec.resources.disk_gib}
							/>
							{deploymentStatus.kind === "running" && !deploymentFailure ? null : (
								<div className="mt-auto border-t pt-3">
									<OverviewComputeStatus
										deployment={deployment}
										failure={deploymentFailure}
										deploymentTransitionTimedOut={deploymentTransitionTimedOut}
										deploymentTransitionEscalated={deploymentTransitionEscalated}
									/>
								</div>
							)}
						</div>
					</AgentOverviewStatusCard>
				</div>
			</div>
			<AgentOverviewCapabilities
				agentId={agentId}
				variant="hosted"
				content={{
					projects: overviewProjectsModule({
						bindings: {
							count:
								agent && projectBindings.data
									? linkedAgentProjectCount(projectBindings.data)
									: null,
							isLoading: projectionLoading || projectBindings.isLoading,
							isUnavailable: projectionUnavailable,
							error: projectBindings.error,
						},
					}),
					skills: {
						...skillsModule,
						link: workspaceProjectId
							? agentProjectResourceLink(agentId, workspaceProjectId, "skills")
							: null,
					},
					plugins: pluginsModule,
					memories: memoriesModule,
					vaults: {
						...vaultsModule,
						link: workspaceProjectId
							? agentProjectResourceLink(agentId, workspaceProjectId, "vaults")
							: null,
					},
					connectors: connectorsModule,
					"model-provider": {
						description:
							providers.isLoading || managedModelCatalog.isLoading ? (
								<OverviewDescriptionSkeleton label="model and provider" />
							) : providers.error || managedModelCatalog.error ? (
								"Unavailable right now"
							) : (
								model
							),
					},
					channels: {
						description:
							projectionLoading || channelLinks.isLoading ? (
								<OverviewDescriptionSkeleton label="channels" />
							) : projectionUnavailable || channelLinks.error ? (
								"Unavailable right now"
							) : linkedChannelCount === 0 ? (
								"No channels linked"
							) : (
								`${linkedChannelCount} linked ${linkedChannelCount === 1 ? "channel" : "channels"}`
							),
					},
				}}
			/>
		</div>
	);
}

// ── Runtime UI ───────────────────────────────────────────────────────────────

const RUNTIME_UI_LAUNCH_TOAST_ID = "runtime-ui-launch";
const HERMES_ACCESS_HINT_STORAGE_PREFIX = "clawdi.hermes-access-hint.dismissed";

function hermesAccessHintStorageKey(deploymentId: string): string {
	return `${HERMES_ACCESS_HINT_STORAGE_PREFIX}.${deploymentId}`;
}

function useRuntimeUiCredentialRequest(
	deployment: HostedDeployment,
	endpointUrl: string | null,
	runtime: Runtime,
): () => Promise<RuntimeUiCredentials> {
	const client = useBillingClient();
	const deploymentId = deployment.resource.id;
	const resourceVersion = deployment.resource.metadata.resourceVersion;
	return useCallback(async () => {
		if (!endpointUrl) throw new Error("The agent dashboard isn't available right now.");
		const credentials = await client.getRuntimeUiCredentials(deploymentId, resourceVersion);
		const resolved = resolveRuntimeUiCredentials(credentials, endpointUrl, resourceVersion);
		if (!resolved || resolved.runtime !== runtime) {
			throw new Error("Clawdi couldn't load the agent dashboard sign-in details.");
		}
		return resolved;
	}, [client, deploymentId, endpointUrl, resourceVersion, runtime]);
}

function ConsoleTab({
	deployment,
	runtime,
	terminalHref,
	deploymentTransitionTimedOut,
	deploymentTransitionEscalated,
	isCheckingDeployment,
	onCheckDeploymentAgain,
}: {
	deployment: HostedDeployment;
	runtime: Runtime;
	terminalHref: string;
	deploymentTransitionTimedOut: boolean;
	deploymentTransitionEscalated: boolean;
	isCheckingDeployment: boolean;
	onCheckDeploymentAgain: () => void;
}) {
	const status = deploymentStatusFromResource(deployment.resource.status);
	const isRunning = isRunningStatus(status);
	const isStarting = isStartingStatus(status);
	const label = runtimeDisplayName(runtime);
	const browserUiLabel = runtimeBrowserUiLabel(runtime);
	const url = runtimeConsoleUrl(deployment, runtime);
	const [credentials, setCredentials] = useState<RuntimeUiCredentials | null>(null);
	const [credentialError, setCredentialError] = useState<Error | null>(null);
	const [isCredentialLoading, setIsCredentialLoading] = useState(false);
	const [credentialLoadState, setCredentialLoadState] = useState<"loading" | "ready" | "error">(
		runtime === "openclaw" ? "loading" : "ready",
	);
	const [openClawNativeHandoffLoaded, setOpenClawNativeHandoffLoaded] = useState(false);
	const [openClawFrameLoaded, setOpenClawFrameLoaded] = useState(false);
	const requestCredentials = useRuntimeUiCredentialRequest(deployment, url, runtime);
	const requestVersionRef = useRef(0);
	const loadedCredentialIdentityRef = useRef<string | null>(null);
	const credentialIdentity = `${deployment.resource.id}\0${deployment.resource.metadata.resourceVersion}\0${runtime}\0${url ?? ""}\0${isRunning}`;

	const loadCredentials = useCallback(async (): Promise<RuntimeUiCredentials | null> => {
		const requestVersion = requestVersionRef.current + 1;
		requestVersionRef.current = requestVersion;
		setIsCredentialLoading(true);
		setCredentialError(null);
		setCredentialLoadState("loading");
		if (runtime === "openclaw") {
			setCredentials(null);
			setOpenClawNativeHandoffLoaded(false);
			setOpenClawFrameLoaded(false);
		}
		try {
			const resolved = await requestCredentials();
			if (requestVersionRef.current !== requestVersion) return null;
			setCredentials(resolved);
			setCredentialLoadState("ready");
			return resolved;
		} catch (error) {
			if (requestVersionRef.current === requestVersion) {
				setCredentialError(
					error instanceof Error
						? error
						: new Error("Clawdi couldn't load the agent dashboard sign-in details."),
				);
				setCredentialLoadState("error");
			}
			return null;
		} finally {
			if (requestVersionRef.current === requestVersion) setIsCredentialLoading(false);
		}
	}, [requestCredentials, runtime]);

	const clearCredentials = useCallback(() => {
		requestVersionRef.current += 1;
		setCredentials(null);
		setCredentialError(null);
		setIsCredentialLoading(false);
		setCredentialLoadState(runtime === "openclaw" ? "loading" : "ready");
		setOpenClawNativeHandoffLoaded(false);
		setOpenClawFrameLoaded(false);
	}, [runtime]);

	const reconnectOpenClaw = useCallback(() => {
		forgetOpenClawNativeHandoffLoaded(runtimeUiLocalStorage(), deployment.resource.id);
		return loadCredentials();
	}, [deployment.resource.id, loadCredentials]);

	useEffect(() => {
		if (loadedCredentialIdentityRef.current === credentialIdentity) return;
		loadedCredentialIdentityRef.current = credentialIdentity;
		clearCredentials();
		if (runtime !== "openclaw" || !isRunning || !url) return;
		if (hasOpenClawNativeHandoffLoaded(runtimeUiLocalStorage(), deployment.resource.id, url)) {
			setOpenClawNativeHandoffLoaded(true);
			setCredentialLoadState("ready");
			return;
		}
		void loadCredentials();
	}, [
		clearCredentials,
		credentialIdentity,
		deployment.resource.id,
		isRunning,
		loadCredentials,
		runtime,
		url,
	]);

	if (status.kind === "stopped") {
		return <StoppedAgentState deployment={deployment} />;
	}

	if (!isRunning) {
		return (
			<EmptyState
				icon={
					deploymentTransitionTimedOut || deploymentTransitionEscalated ? AlertCircle : MonitorPlay
				}
				title={
					deploymentTransitionEscalated
						? "Your agent’s setup appears to be stuck"
						: deploymentTransitionTimedOut
							? "Your agent is taking longer than expected"
							: isStarting
								? startingTitle()
								: "Agent is not running"
				}
				description={
					deploymentTransitionEscalated
						? "This change is still in progress. You can cancel it and try again."
						: deploymentTransitionTimedOut
							? "This change is still in progress. Check again now or keep waiting."
							: isStarting
								? `${browserUiLabel} will open here when ready.`
								: `Start the agent to open the live ${browserUiLabel}. Current status: ${deploymentStatusLabel(status).toLowerCase()}.`
				}
				action={
					deploymentTransitionTimedOut || deploymentTransitionEscalated ? (
						<div className="flex flex-wrap justify-center gap-2">
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
							{deploymentTransitionEscalated ? (
								<DeploymentCancelAction deployment={deployment} />
							) : null}
						</div>
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
				icon={MonitorPlay}
				title={`${browserUiLabel} isn’t ready yet`}
				description={`Your agent is running. Check again in a moment, or use Terminal now while ${label} starts its browser interface.`}
				action={
					<div className="flex flex-wrap justify-center gap-2">
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
						<Button
							render={<Link to={terminalHref} />}
							nativeButton={false}
							variant="outline"
							size="sm"
						>
							<TerminalSquare className="size-3.5" />
							Use Terminal now
						</Button>
					</div>
				}
			/>
		);
	}
	const currentCredentials = credentials
		? resolveRuntimeUiCredentials(credentials, url, deployment.resource.metadata.resourceVersion)
		: null;
	const openClawCredentials =
		currentCredentials?.runtime === "openclaw" ? currentCredentials : null;
	const openClawFrameCanLoad =
		credentialLoadState === "ready" &&
		(openClawCredentials !== null || openClawNativeHandoffLoaded);
	const iframeUrl =
		runtime === "openclaw"
			? openClawCredentials
				? runtimeUiLaunchTarget(openClawCredentials)
				: openClawNativeHandoffLoaded
					? url
					: "about:blank"
			: url;
	const windowTarget =
		runtime === "openclaw"
			? openClawRuntimeUiWindowTarget(
					openClawCredentials,
					url,
					openClawNativeHandoffLoaded,
					openClawFrameLoaded,
				)
			: url;

	return (
		<LiveToolFrame
			icon={MonitorPlay}
			title={browserUiLabel}
			action={
				<RuntimeUiAccessDialog
					deployment={deployment}
					endpointUrl={url}
					windowTarget={windowTarget}
					runtime={runtime}
					credentials={currentCredentials}
					credentialError={credentialError}
					isCredentialLoading={isCredentialLoading}
					onLoadCredentials={loadCredentials}
					onClearCredentials={clearCredentials}
					onReconnectOpenClaw={reconnectOpenClaw}
				/>
			}
		>
			{runtime === "openclaw" && !openClawFrameCanLoad ? (
				credentialLoadState === "error" ? (
					<EmptyState
						icon={AlertCircle}
						title={`${browserUiLabel} could not be opened`}
						description="Clawdi couldn't establish this browser session."
						action={
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={isCredentialLoading}
								onClick={() => void reconnectOpenClaw()}
							>
								{isCredentialLoading ? (
									<Spinner className="size-3.5" />
								) : (
									<RefreshCw className="size-3.5" />
								)}
								Retry
							</Button>
						}
					/>
				) : (
					<div role="status" className="flex min-h-0 flex-1">
						<EmptyState
							icon={<Spinner className="size-5" />}
							title={`Opening ${browserUiLabel}…`}
							description="Requesting secure access from your agent."
						/>
					</div>
				)
			) : (
				<iframe
					key={`${runtime}:${iframeUrl}`}
					src={iframeUrl}
					title={browserUiLabel}
					className="min-h-0 flex-1 border-0 bg-background"
					allow="clipboard-read; clipboard-write"
					onLoad={
						runtime === "openclaw"
							? () => {
									if (
										markOpenClawNativeHandoffLoaded(
											runtimeUiLocalStorage(),
											deployment.resource.id,
											url,
											openClawCredentials,
										)
									) {
										setOpenClawNativeHandoffLoaded(true);
									}
									setOpenClawFrameLoaded(true);
								}
							: undefined
					}
				/>
			)}
		</LiveToolFrame>
	);
}

function FilesTab({ deployment, url }: { deployment: HostedDeployment; url: string }) {
	const status = deploymentStatusFromResource(deployment.resource.status);
	const isRunning = isRunningStatus(status);
	const isStarting = isStartingStatus(status);

	if (status.kind === "stopped") {
		return <StoppedAgentState deployment={deployment} />;
	}

	if (!isRunning) {
		return (
			<EmptyState
				icon={FolderOpen}
				title={isStarting ? startingTitle() : "Agent is not running"}
				description={
					isStarting
						? "Files opens once your agent and its private Workspace service are ready. This page updates automatically."
						: `Start the agent to browse its Workspace. Current status: ${deploymentStatusLabel(status).toLowerCase()}.`
				}
				action={canStartDeployment(status) ? <StartComputeAction deployment={deployment} /> : null}
			/>
		);
	}

	return <FilesFrame deploymentId={deployment.resource.id} url={url} />;
}

function FilesFrame({ deploymentId, url }: { deploymentId: string; url: string }) {
	const bootstrap = useFilesGrantBootstrap(url);
	const openInNewWindow = useOpenFilesInNewWindow(url, deploymentId);

	return (
		<LiveToolFrame
			icon={FolderOpen}
			title="Files"
			action={<OpenInNewWindowButton label="Files" onClick={() => void openInNewWindow()} />}
		>
			{bootstrap === "error" ? (
				<EmptyState
					icon={FolderOpen}
					title="Files could not be opened"
					description="We could not authenticate your Files session. Refresh the page and try again."
				/>
			) : bootstrap === "pending" ? (
				<EmptyState
					icon={FolderOpen}
					title="Opening Files…"
					description="Authenticating your private Workspace session."
				/>
			) : (
				<iframe
					src={url}
					title="Files"
					className="min-h-0 flex-1 border-0 bg-background"
					allow="clipboard-read; clipboard-write"
				/>
			)}
		</LiveToolFrame>
	);
}

const MASKED_RUNTIME_UI_CREDENTIAL = "••••••••••••";

function RuntimeUiCredentialRow({
	label,
	value,
	secret = false,
}: {
	label: string;
	value: string;
	secret?: boolean;
}) {
	const [revealed, setRevealed] = useState(!secret);
	const { copied, copy } = useCopyToClipboard({
		success: `${label} copied`,
		error: `Couldn't copy ${label.toLowerCase()}`,
	});
	const visibleValue = secret && !revealed ? MASKED_RUNTIME_UI_CREDENTIAL : value;

	return (
		<div className="grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			<code
				className="block min-w-0 truncate font-mono text-sm font-medium"
				title={secret && !revealed ? undefined : value}
			>
				{visibleValue}
			</code>
			<div className="flex items-center gap-0.5">
				{secret ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						onClick={() => setRevealed((visible) => !visible)}
						aria-label={`${revealed ? "Hide" : "Show"} ${label}`}
						aria-pressed={revealed}
					>
						{revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
					</Button>
				) : null}
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					onClick={() => copy(value)}
					aria-label={`Copy ${label}`}
				>
					{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
				</Button>
			</div>
		</div>
	);
}

function OpenInNewWindowButton({
	label,
	onClick,
	disabled = false,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			disabled={disabled}
			onClick={onClick}
			aria-label={`Open ${label} in new window`}
		>
			<ExternalLink className="size-3.5" />
			<span className="hidden sm:inline">Open in new window</span>
		</Button>
	);
}

function RuntimeUiAccessDialog({
	deployment,
	endpointUrl,
	windowTarget,
	runtime,
	credentials,
	credentialError,
	isCredentialLoading,
	onLoadCredentials,
	onClearCredentials,
	onReconnectOpenClaw,
}: {
	deployment: HostedDeployment;
	endpointUrl: string;
	windowTarget: string | null;
	runtime: Runtime;
	credentials: RuntimeUiCredentials | null;
	credentialError: Error | null;
	isCredentialLoading: boolean;
	onLoadCredentials: () => Promise<RuntimeUiCredentials | null>;
	onClearCredentials: () => void;
	onReconnectOpenClaw: () => Promise<RuntimeUiCredentials | null>;
}) {
	const label = runtimeBrowserUiLabel(runtime);
	const reset = useResetRuntimeUiAccess();
	const [open, setOpen] = useState(false);
	const loadedIdentityRef = useRef<string | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [accessHintOpen, setAccessHintOpen] = useState(false);
	const credentialExit = useDialogExitLifecycle({ open, value: credentials, emptyValue: null });
	const renderedCredentials = credentialExit.renderedValue;
	const identity = `${deployment.resource.id}\0${deployment.resource.metadata.resourceVersion}\0${runtime}\0${endpointUrl}`;
	const accessHintStorageKey = hermesAccessHintStorageKey(deployment.resource.id);

	const dismissAccessHint = useCallback(() => {
		setAccessHintOpen(false);
		try {
			window.localStorage.setItem(accessHintStorageKey, "1");
		} catch {
			// The hint still stays dismissed for this mount when storage is unavailable.
		}
	}, [accessHintStorageKey]);

	useEffect(() => {
		if (loadedIdentityRef.current === identity) return;
		loadedIdentityRef.current = identity;
		if (open) credentialExit.beginClose();
		setOpen(false);
	}, [credentialExit.beginClose, identity, open]);

	useEffect(() => {
		if (runtime !== "hermes") {
			setAccessHintOpen(false);
			return;
		}
		try {
			setAccessHintOpen(window.localStorage.getItem(accessHintStorageKey) !== "1");
		} catch {
			setAccessHintOpen(true);
		}
	}, [accessHintStorageKey, runtime]);

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (nextOpen) credentialExit.beginOpen();
			else credentialExit.beginClose();
			setOpen(nextOpen);
			if (nextOpen) dismissAccessHint();
			if (nextOpen && !credentials && !isCredentialLoading) void onLoadCredentials();
		},
		[
			credentialExit.beginClose,
			credentialExit.beginOpen,
			credentials,
			dismissAccessHint,
			isCredentialLoading,
			onLoadCredentials,
		],
	);

	const openRuntime = useCallback(() => {
		if (!windowTarget) return;
		const popup = openSecureRuntimeWindow(window.open.bind(window), windowTarget);
		if (!popup) {
			toast.error(`Couldn't open ${label}`, {
				id: RUNTIME_UI_LAUNCH_TOAST_ID,
				description: "Allow pop-ups, then try again.",
			});
			return;
		}
		trackRuntimeWindow(deployment.resource.id, popup);
	}, [deployment.resource.id, label, windowTarget]);

	const acceptReset = useCallback(async () => {
		await reset.mutateAsync({ id: deployment.resource.id });
		credentialExit.beginClose();
		onClearCredentials();
		setOpen(false);
	}, [credentialExit.beginClose, deployment.resource.id, onClearCredentials, reset]);

	return (
		<Dialog
			open={runtime === "hermes" && open}
			onOpenChange={handleOpenChange}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) credentialExit.completeClose();
			}}
		>
			<div className="flex items-center gap-1.5">
				{runtime === "hermes" ? (
					<Popover
						open={accessHintOpen}
						onOpenChange={(nextOpen) => {
							if (!nextOpen) dismissAccessHint();
						}}
					>
						<PopoverTrigger
							render={
								<Button
									ref={triggerRef}
									type="button"
									variant="outline"
									size="sm"
									onClick={() => handleOpenChange(true)}
									aria-label={`Access ${label}`}
								/>
							}
						>
							Access
						</PopoverTrigger>
						<PopoverContent side="bottom" align="end" className="w-72 gap-2">
							<div className="flex items-start justify-between gap-3">
								<PopoverHeader>
									<PopoverTitle>Sign in to Hermes</PopoverTitle>
									<PopoverDescription>
										Get your Hermes username and password from Access.
									</PopoverDescription>
								</PopoverHeader>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									onClick={dismissAccessHint}
									aria-label="Dismiss Hermes sign-in hint"
								>
									<X />
								</Button>
							</div>
						</PopoverContent>
					</Popover>
				) : (
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={isCredentialLoading}
						onClick={() => void onReconnectOpenClaw()}
					>
						{isCredentialLoading ? (
							<Spinner className="size-3.5" />
						) : (
							<RefreshCw className="size-3.5" />
						)}
						Reconnect
					</Button>
				)}
				<OpenInNewWindowButton label={label} disabled={!windowTarget} onClick={openRuntime} />
			</div>
			{runtime === "hermes" ? (
				<DialogContent
					data-hosted="true"
					data-v2="true"
					className="sm:max-w-md"
					finalFocus={triggerRef}
				>
					<DialogHeader>
						<DialogTitle>Agent dashboard access</DialogTitle>
						<DialogDescription>
							View or copy the current {label} sign-in details. Resetting them restarts the agent.
						</DialogDescription>
					</DialogHeader>

					{isCredentialLoading ? (
						<div
							role="status"
							className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground"
						>
							<Spinner className="size-4" />
							Loading dashboard access…
						</div>
					) : null}

					{credentialError ? (
						<ApiErrorPanel
							error={credentialError}
							onRetry={() => void onLoadCredentials()}
							normalizer={billingErrorNormalizer}
							title={`Couldn't load ${label} access`}
						/>
					) : null}

					{renderedCredentials?.runtime === "hermes" ? (
						<div className="overflow-hidden rounded-lg border bg-card/60">
							<RuntimeUiCredentialRow label="Username" value={renderedCredentials.username} />
							<Separator />
							<RuntimeUiCredentialRow
								label="Password"
								value={renderedCredentials.password}
								secret
							/>
						</div>
					) : null}

					<div className="flex flex-wrap justify-end gap-2">
						<ConfirmAction
							title="Reset dashboard access?"
							description={<p>This creates new Hermes sign-in details and restarts the agent.</p>}
							confirmLabel="Reset access"
							destructive
							onConfirm={acceptReset}
						>
							<Button
								type="button"
								variant="outline"
								disabled={isCredentialLoading || reset.isPending}
							>
								{reset.isPending ? <Spinner className="size-3.5" /> : null}
								Reset access
							</Button>
						</ConfirmAction>
						<Button
							type="button"
							disabled={!windowTarget || reset.isPending}
							onClick={openRuntime}
							aria-label={`Open ${label} in new window`}
						>
							<ExternalLink className="size-3.5" />
							<span className="hidden sm:inline">Open in new window</span>
						</Button>
					</div>
				</DialogContent>
			) : null}
		</Dialog>
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
	reconnecting: "Reconnecting",
	disconnected: "Disconnected",
};

const TERMINAL_STATUS_TONES: Record<HostedTerminalStatus, StatusTone> = {
	connecting: "warning",
	connected: "success",
	reconnecting: "warning",
	disconnected: "destructive",
};

const TERMINAL_WINDOW_LAUNCH_TOAST_ID = "terminal-window-launch";

function TerminalStatusIndicator({ status }: { status: HostedTerminalStatus }) {
	return (
		<div className="flex items-center gap-2 text-xs text-muted-foreground">
			<StatusDot status={TERMINAL_STATUS_TONES[status]} className="size-2" />
			<span>{TERMINAL_STATUS_LABELS[status]}</span>
		</div>
	);
}

function TerminalTab({
	deployment,
	agentName,
	terminalWindowHref,
	standalone,
}: {
	deployment: HostedDeployment;
	agentName: string;
	terminalWindowHref: string;
	standalone: boolean;
}) {
	const status = deploymentStatusFromResource(deployment.resource.status);
	const isRunning = isRunningStatus(status);
	const isStarting = isStartingStatus(status);
	const label = agentName;
	const client = useBillingClient();
	const terminal = useSensitiveAction(({ id }: { id: string }) => client.createTerminalSession(id));
	const { isPending: isOpeningTerminal, execute: createTerminalSession } = terminal;
	const [terminalStatus, setTerminalStatus] = useState<HostedTerminalStatus>("connecting");
	const [reconnectRequest, setReconnectRequest] = useState(0);
	const openTerminalWindow = useCallback(() => {
		const popup = openSecureRuntimeWindow(window.open.bind(window), terminalWindowHref);
		if (!popup) {
			toast.error("Couldn't open Terminal", {
				id: TERMINAL_WINDOW_LAUNCH_TOAST_ID,
				description: "Allow pop-ups, then try again.",
			});
			return;
		}
		trackRuntimeWindow(deployment.resource.id, popup);
	}, [deployment.resource.id, terminalWindowHref]);
	const requestWebsocketUrl = useCallback(async () => {
		const session = await createTerminalSession({ id: deployment.resource.id });
		return session.websocket_url ?? "";
	}, [createTerminalSession, deployment.resource.id]);

	if (status.kind === "stopped") {
		return <StoppedAgentState deployment={deployment} />;
	}

	if (!isRunning) {
		return (
			<EmptyState
				icon={TerminalSquare}
				title={isStarting ? startingTitle() : "Agent is not running"}
				description={
					isStarting
						? "The browser terminal opens once your agent is running. This page updates automatically."
						: `Start the agent to open a terminal. Current status: ${deploymentStatusLabel(status).toLowerCase()}.`
				}
				action={canStartDeployment(status) ? <StartComputeAction deployment={deployment} /> : null}
			/>
		);
	}

	const terminalAction = (
		<>
			<TerminalStatusIndicator status={terminalStatus} />
			<Button
				type="button"
				variant="outline"
				size="sm"
				aria-label={terminalStatus === "disconnected" ? "Retry terminal" : "Reconnect terminal"}
				disabled={
					isOpeningTerminal || terminalStatus === "connecting" || terminalStatus === "reconnecting"
				}
				onClick={() => setReconnectRequest((request) => request + 1)}
			>
				{isOpeningTerminal ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
				<span className="hidden sm:inline">
					{terminalStatus === "disconnected" ? "Retry" : "Reconnect"}
				</span>
			</Button>
			{standalone ? null : <OpenInNewWindowButton label="Terminal" onClick={openTerminalWindow} />}
		</>
	);

	return (
		<LiveToolFrame icon={TerminalSquare} title="Terminal" detail={label} action={terminalAction}>
			<HostedTerminalPanel
				requestWebsocketUrl={requestWebsocketUrl}
				reconnectRequest={reconnectRequest}
				onStatusChange={setTerminalStatus}
			/>
		</LiveToolFrame>
	);
}

// ── AI Providers ─────────────────────────────────────────────────────────────

function AiProviderTab({
	deployment,
	runtime,
	environmentId,
}: {
	deployment: HostedDeployment;
	runtime: Runtime;
	environmentId: string;
}) {
	const providers = useUserAiProviders();
	const managedModelCatalog = useManagedModelCatalog();
	const updateDeployment = useUpdateDeployment();
	const [addProviderOpen, setAddProviderOpen] = useState(false);
	const updateInProgress =
		deploymentStatusFromResource(deployment.resource.status).kind === "updating";
	const runtimeConfiguration = deployment.resource.spec.runtime_configuration;
	const list = providers.data ?? [];
	const availabilityContext = { runtime, environmentId };
	const managedModels = managedModelCatalog.data?.models ?? [];
	// A provider reference is only unresolved after the catalog has settled. While
	// it is loading, preserve the server id verbatim so the binding does not briefly
	// seed the draft with a stale `unresolved:` choice.
	const providerChoiceFromServerRef = providers.isPending
		? providerChoiceFromRef
		: updateProviderChoiceFromRef;
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
	const primaryProviderRef =
		currentAuthKind === "unmanaged"
			? MANAGED_PROVIDER_ID
			: (primaryModelProviderId(configuredPrimaryModel) ??
				primaryConfiguredProvider?.provider_id ??
				configuredProviders[0]?.provider_id ??
				MANAGED_PROVIDER_ID);
	const initialPrimaryChoice =
		currentAuthKind === "unmanaged"
			? MANAGED_AI_CHOICE
			: (providerChoiceFromServerRef(primaryProviderRef, list) ??
				(isManagedProviderId(primaryProviderRef)
					? MANAGED_AI_CHOICE
					: unresolvedProviderChoice(primaryProviderRef)));
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
	const bindingIdentity = JSON.stringify([initialMode, initialPrimaryChoice, bindingModelIdentity]);
	const {
		draft: aiBindingDraft,
		managedPrimaryModelReady,
		selectCreatedProvider,
		selectProvider,
		setBindingMode,
		setPrimaryModel,
	} = useAiProviderBindingDraft({
		initialDraft: {
			bindingMode: initialMode,
			primaryProviderChoice: initialPrimaryChoice,
			primaryModel: currentModel,
		},
		managedCatalogReady: managedModelCatalog.data !== undefined,
		managedModels,
		operationMode: "update",
		providers: list,
		syncIdentity: bindingIdentity,
	});
	const { bindingMode, primaryModel, primaryProviderChoice } = aiBindingDraft;
	const dirty =
		bindingMode !== initialMode ||
		(bindingMode === "configured" &&
			(primaryProviderChoice !== initialPrimaryChoice || primaryModel !== currentModel));
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
			<div className={ENTITY_CHOICE_GRID_CLASS} data-testid="provider-choice-grid">
				<EntityChoiceCard
					onClick={() => selectProvider(MANAGED_AI_CHOICE)}
					selected={bindingMode === "configured" && primaryProviderChoice === MANAGED_AI_CHOICE}
					icon={<ProviderIcon provider={MANAGED_PROVIDER_ID} />}
					title={MANAGED_PROVIDER_LABEL}
					description="No setup required. Usage draws from your Wallet."
				/>
				<EntityChoiceCard
					onClick={() => setBindingMode("unmanaged")}
					selected={bindingMode === "unmanaged"}
					icon={
						<IconChip tint="bg-muted text-muted-foreground">
							<Settings />
						</IconChip>
					}
					title={authCardLabel("unmanaged")}
					description="Configure model access inside the agent."
				/>
				{providers.isLoading ? <EntityCardSkeleton titleBadge trailingBadge /> : null}
				{shouldBlockQueryError(providers.error, providers.data) ? (
					<div className="@2xl/main:col-span-2">
						<ApiErrorPanel
							normalizer={billingErrorNormalizer}
							error={providers.error}
							onRetry={() => providers.refetch()}
							title="Couldn't load providers"
						/>
					</div>
				) : null}
				{bindingMode === "configured" && isUnresolvedProviderChoice(primaryProviderChoice) ? (
					<EntityChoiceCard
						selected
						disabled
						icon={<ProviderIcon provider={unresolvedProviderRef(primaryProviderChoice)} />}
						title={`Using ${providerDisplayLabel(unresolvedProviderRef(primaryProviderChoice), list)}`}
						description={`Saved connection details couldn't be loaded. Choose ${MANAGED_PROVIDER_LABEL} to replace it.`}
					/>
				) : null}
				{list.map((p) => {
					const selected = bindingMode === "configured" && primaryProviderChoice === p.provider_id;
					const issue = providerAvailabilityIssue(p, availabilityContext);
					const disabled = Boolean(issue) && !selected;
					return (
						<EntityChoiceCard
							key={p.provider_id}
							onClick={() => selectProvider(p.provider_id)}
							disabled={disabled}
							selected={selected}
							icon={<ProviderIcon provider={p} />}
							title={providerDisplayLabel(p)}
							description={issue?.message ?? providerCatalogDescription(p)}
							badge={
								issue ? <Badge variant="secondary">Unavailable</Badge> : <AuthBadge auth={p.auth} />
							}
						/>
					);
				})}
				<EntityAddCard
					title="Add a provider"
					description="Connect OpenAI, Anthropic, or another endpoint."
					onClick={() => setAddProviderOpen(true)}
				/>
			</div>

			{bindingMode === "unmanaged" ? (
				<p className="text-sm text-muted-foreground">
					This agent has no Clawdi provider connection. Configure models inside the agent after it
					starts.
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
					primaryProviderChoice={primaryProviderChoice}
					primaryModel={primaryModel}
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
					AI Providers
				</Link>
				.
			</p>

			<AddProviderDialog
				open={addProviderOpen}
				onOpenChange={setAddProviderOpen}
				onCreated={selectCreatedProvider}
			/>
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

const AGENT_CHANNEL_PAIR_ACTIONS_CLASS = "flex min-h-8 w-auto items-center gap-1.5 xl:gap-2";

const AGENT_CHANNEL_CARD_HEADER_CLASS =
	"h-[7.5rem] flex-none grid-rows-[2.75rem_2rem] xl:h-20 xl:grid-rows-1";

type AgentChannelCardProps = ComponentProps<typeof ChannelCard>;

function AgentChannelCard({ headerClassName, ...props }: AgentChannelCardProps) {
	return (
		<ChannelCard
			{...props}
			headerClassName={cn(AGENT_CHANNEL_CARD_HEADER_CLASS, headerClassName)}
		/>
	);
}

function agentChannelLinkUnavailableReason({
	bot,
	agentType,
	linkedProviders,
}: {
	bot: AgentChannelCardItem;
	agentType: HostedRuntime;
	linkedProviders: ReadonlySet<string> | undefined;
}): string | null {
	if (!bot.available || !bot.canLink || bot.status.toLowerCase() !== "active") {
		return bot.maxLinks !== null ? "At capacity" : "Unavailable";
	}
	if (agentProviderLinkStatusUnknown(agentType, bot.provider, linkedProviders)) {
		return "Agent link status unavailable";
	}
	return null;
}

function ChannelsTab({
	environmentId,
	agentType,
	agentName,
}: {
	environmentId: string;
	agentType: HostedRuntime;
	agentName: string;
}) {
	const api = useApi();
	const openApi = useOpenApi();
	const qc = useQueryClient();
	const channels = useChannels();
	const botPool = useBotPool();
	const linked = useAgentChannelLinks(environmentId, isAgentRouteId(environmentId), true);
	const agentLinksQueryKey = agentChannelLinksQueryOptions(openApi, environmentId).queryKey;
	const unlink = useUnlinkAgentChannel(environmentId);
	const deleteChannel = useDeleteChannel();
	const [recentLinks, setRecentLinks] = useState<ReadonlyMap<string, AgentChannelLink>>(
		() => new Map(),
	);
	const [telegramPair, setTelegramPair] = useState<{
		accountId: string;
		agentLinkId: string;
		channelName: string;
		open: boolean;
	} | null>(null);
	const [discordPair, setDiscordPair] = useState<{
		accountId: string;
		agentLinkId: string;
		channelName: string;
		open: boolean;
	} | null>(null);
	const [whatsappPair, setWhatsappPair] = useState<{
		accountId: string;
		agentLinkId: string;
		channelName: string;
		open: boolean;
	} | null>(null);
	const [whatsappRepair, setWhatsappRepair] = useState<{
		accountId: string;
		channelName: string;
		replaceExistingProviderLink: boolean;
	} | null>(null);
	const [customBotDialogOpen, setCustomBotDialogOpen] = useState(false);
	const linkingAccountIdsRef = useRef<Set<string>>(new Set());
	const [linkingAccountIds, setLinkingAccountIds] = useState<ReadonlySet<string>>(() => new Set());
	const unlinkingLinkIdsRef = useRef<Set<string>>(new Set());
	const [unlinkingLinkIds, setUnlinkingLinkIds] = useState<ReadonlySet<string>>(() => new Set());
	const deletingAccountIdsRef = useRef<Set<string>>(new Set());
	const [deletingAccountIds, setDeletingAccountIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	useEffect(() => {
		if (!linked.data) return;
		setRecentLinks((current) => {
			const next = new Map(current);
			for (const [accountId, recentLink] of current) {
				if (
					linked.data.some((link) => link.account_id === accountId && link.id === recentLink.id)
				) {
					next.delete(accountId);
				}
			}
			return next.size === current.size ? current : next;
		});
	}, [linked.data]);

	const visibleActiveLinks = useMemo(
		() =>
			canonicalAgentChannelLinks({
				links: linked.data ?? [],
				agentId: environmentId,
				recentLinks: Array.from(recentLinks.values()),
			}),
		[environmentId, linked.data, recentLinks],
	);
	const cardGroups = useMemo(
		() =>
			buildAgentChannelCardGroups({
				channels: channels.data ?? [],
				poolProviders: botPool.data?.providers,
				links: visibleActiveLinks,
			}),
		[botPool.data, channels.data, visibleActiveLinks],
	);
	const accountSummaries = useMemo(() => {
		const map = new Map<string, ChannelAccountSummary>();
		for (const bots of [cardGroups.clawdiBots, cardGroups.customBots]) {
			for (const bot of bots) {
				map.set(bot.id, {
					provider: bot.provider,
					name: bot.name,
					visibility: bot.visibility,
				});
			}
		}
		return map;
	}, [cardGroups]);
	const bindingCountForLink = (linkId: string) =>
		visibleActiveLinks.find((link) => link.id === linkId)?.binding_count ?? 0;
	const linkedProviders = useMemo<ReadonlySet<string> | undefined>(() => {
		if (!linked.data) return undefined;
		return (
			activeLinkedProviders({
				links: visibleActiveLinks,
				channels: channels.data ?? [],
				poolProviders: botPool.data?.providers,
			}) ?? undefined
		);
	}, [botPool.data, channels.data, linked.data, visibleActiveLinks]);
	const link = useSensitiveAction(
		async ({
			channelId,
			replaceExistingProviderLink,
		}: {
			channelId: string;
			replaceExistingProviderLink: boolean;
		}) =>
			unwrap(
				await api.POST("/v1/channels/{account_id}/agent-links", {
					params: { path: { account_id: channelId } },
					body: {
						agent_id: environmentId,
						...(replaceExistingProviderLink ? { replace_existing_provider_link: true } : {}),
					},
				}),
			),
	);

	function showPairingForLink(nextLink: AgentChannelLink) {
		const account = accountSummaries.get(nextLink.account_id);
		if (account?.provider === "telegram") {
			setTelegramPair({
				accountId: nextLink.account_id,
				agentLinkId: nextLink.id,
				channelName: account.name,
				open: true,
			});
		} else if (account?.provider === "discord") {
			setDiscordPair({
				accountId: nextLink.account_id,
				agentLinkId: nextLink.id,
				channelName: account.name,
				open: true,
			});
		} else if (account?.provider === "whatsapp") {
			setWhatsappPair({
				accountId: nextLink.account_id,
				agentLinkId: nextLink.id,
				channelName: account.name,
				open: true,
			});
		} else {
			toast.success("Channel linked", {
				description: "Pair a chat from this bot's card.",
			});
		}
	}

	function acceptLinkedChannel(nextLink: AgentChannelLink) {
		setRecentLinks((current) => new Map(current).set(nextLink.account_id, nextLink));
		void qc.invalidateQueries({ queryKey: agentLinksQueryKey, exact: true });
		void qc.invalidateQueries({ queryKey: channelKeys.agentLinks(nextLink.account_id) });
		void qc.invalidateQueries({ queryKey: channelKeys.pool });
		void qc.invalidateQueries({ queryKey: channelKeys.list });
		showPairingForLink(nextLink);
	}

	async function submitLink(
		channelId: string,
		replaceExistingProviderLink: boolean,
	): Promise<void> {
		if (!channelId || linkingAccountIdsRef.current.has(channelId)) return;
		linkingAccountIdsRef.current.add(channelId);
		setLinkingAccountIds((current) => new Set(current).add(channelId));
		try {
			const data = await link.execute({ channelId, replaceExistingProviderLink });
			acceptLinkedChannel({
				id: data.id,
				account_id: data.account_id,
				agent_id: data.agent_id,
				status: data.status,
				runtime_status: data.runtime_status ?? "connecting",
				created_at: data.created_at,
				binding_count: 0,
			});
			return;
		} catch (error) {
			if (isWhatsAppRepairConflict(error)) {
				setWhatsappRepair({
					accountId: channelId,
					channelName: accountSummaries.get(channelId)?.name ?? "Custom WhatsApp",
					replaceExistingProviderLink,
				});
				return;
			}
			if (error instanceof ApiError && error.status === 409) {
				const refreshed = await linked.refetch();
				const existing = activeAgentLinkForAccount({
					links: refreshed.data ?? [],
					agentId: environmentId,
					accountId: channelId,
				});
				if (existing) {
					link.reset();
					acceptLinkedChannel(existing);
					toast.info("Bot already linked", {
						description: "Using the existing link for this Agent.",
					});
					return;
				}
			}
			toastApiError("Couldn't link bot")(error);
			throw error;
		} finally {
			linkingAccountIdsRef.current.delete(channelId);
			setLinkingAccountIds((current) => {
				const next = new Set(current);
				next.delete(channelId);
				return next;
			});
		}
	}

	function startUnlink(accountIdToUnlink: string, linkId: string) {
		if (unlinkingLinkIdsRef.current.has(linkId)) return;
		unlinkingLinkIdsRef.current.add(linkId);
		setUnlinkingLinkIds((prev) => new Set(prev).add(linkId));
		void (async () => {
			try {
				await unlink.mutateAsync({
					params: { path: { account_id: accountIdToUnlink, link_id: linkId } },
				});
				setRecentLinks((current) => {
					if (current.get(accountIdToUnlink)?.id !== linkId) return current;
					const next = new Map(current);
					next.delete(accountIdToUnlink);
					return next;
				});
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
	async function submitDeleteChannel(accountId: string): Promise<void> {
		if (deletingAccountIdsRef.current.has(accountId)) return;
		deletingAccountIdsRef.current.add(accountId);
		setDeletingAccountIds((current) => new Set(current).add(accountId));
		try {
			await deleteChannel.mutateAsync({ params: { path: { account_id: accountId } } });
			setRecentLinks((current) => {
				if (!current.has(accountId)) return current;
				const next = new Map(current);
				next.delete(accountId);
				return next;
			});
		} finally {
			deletingAccountIdsRef.current.delete(accountId);
			setDeletingAccountIds((current) => {
				const next = new Set(current);
				next.delete(accountId);
				return next;
			});
		}
	}
	function renderBot(bot: AgentChannelCardItem) {
		const linkForBot = bot.link;
		return (
			<AgentChannelBotCard
				bot={bot}
				agentId={environmentId}
				agentName={agentName}
				agentType={agentType}
				linkedProviders={linkedProviders}
				linking={linkingAccountIds.has(bot.id)}
				unlinking={Boolean(linkForBot && unlinkingLinkIds.has(linkForBot.id))}
				deleting={deletingAccountIds.has(bot.id)}
				onLink={(replaceExistingProviderLink) => submitLink(bot.id, replaceExistingProviderLink)}
				onUnlink={() => {
					if (linkForBot) startUnlink(bot.id, linkForBot.id);
				}}
				onDelete={() => submitDeleteChannel(bot.id)}
			/>
		);
	}
	return (
		<div data-agent-channels className="flex flex-col gap-8">
			<AgentChannelBotsSection
				kind="clawdi"
				title="Clawdi bots"
				description="Clawdi-managed bots available to your account."
				bots={cardGroups.clawdiBots}
				isLoading={botPool.isLoading}
				error={shouldBlockQueryError(botPool.error, botPool.data) ? botPool.error : null}
				onRetry={() => void botPool.refetch()}
				emptyTitle="No Clawdi bots available"
				renderBot={renderBot}
			/>

			<AgentChannelBotsSection
				kind="custom"
				title="Custom bots"
				description="Bots and WhatsApp accounts whose connection you manage."
				bots={cardGroups.customBots}
				isLoading={channels.isLoading}
				error={shouldBlockQueryError(channels.error, channels.data) ? channels.error : null}
				onRetry={() => void channels.refetch()}
				emptyTitle="No custom bots yet"
				action={
					<Button
						data-agent-add-custom-bot
						type="button"
						variant="outline"
						size="sm"
						className="min-w-0 whitespace-normal"
						onClick={() => setCustomBotDialogOpen(true)}
					>
						<Plus className="size-3.5 shrink-0" />
						Add channel
					</Button>
				}
				renderBot={renderBot}
			/>

			{shouldBlockQueryError(linked.error, linked.data) ? (
				<ApiErrorPanel
					error={linked.error}
					onRetry={() => linked.refetch()}
					title="Couldn't refresh every linked bot"
				/>
			) : null}
			<ConnectBotDialog
				open={customBotDialogOpen}
				onOpenChange={setCustomBotDialogOpen}
				agentId={environmentId}
				agentType={agentType}
				linkedProviders={linked.data ? linkedProviders : undefined}
				onAgentConnected={(bot) => {
					setRecentLinks((current) =>
						new Map(current).set(bot.id, {
							id: bot.agentLinkId,
							account_id: bot.id,
							agent_id: environmentId,
							status: "active",
							runtime_status: "connecting",
							created_at: new Date().toISOString(),
							binding_count: 0,
						}),
					);
					if (bot.provider === "telegram") {
						setTelegramPair({
							accountId: bot.id,
							agentLinkId: bot.agentLinkId,
							channelName: bot.name,
							open: true,
						});
						return;
					}
					if (bot.provider === "discord") {
						setDiscordPair({
							accountId: bot.id,
							agentLinkId: bot.agentLinkId,
							channelName: bot.name,
							open: true,
						});
						return;
					}
					if (bot.provider === "whatsapp") {
						setWhatsappPair({
							accountId: bot.id,
							agentLinkId: bot.agentLinkId,
							channelName: bot.name,
							open: true,
						});
					}
				}}
			/>
			{telegramPair ? (
				<TelegramPairDialog
					open={telegramPair.open}
					onOpenChange={(open) => {
						setTelegramPair((current) => (current ? { ...current, open } : current));
					}}
					onCloseComplete={() => {
						setTelegramPair((current) => (current?.open === false ? null : current));
					}}
					agentId={environmentId}
					accountId={telegramPair.accountId}
					agentLinkId={telegramPair.agentLinkId}
					channelName={telegramPair.channelName}
					bindingCount={bindingCountForLink(telegramPair.agentLinkId)}
				/>
			) : null}
			{discordPair ? (
				<DiscordPairDialog
					open={discordPair.open}
					onOpenChange={(open) => {
						setDiscordPair((current) => (current ? { ...current, open } : current));
					}}
					onCloseComplete={() => {
						setDiscordPair((current) => (current?.open === false ? null : current));
					}}
					agentId={environmentId}
					accountId={discordPair.accountId}
					agentLinkId={discordPair.agentLinkId}
					channelName={discordPair.channelName}
					bindingCount={bindingCountForLink(discordPair.agentLinkId)}
				/>
			) : null}
			{whatsappPair ? (
				<WhatsAppPairDialog
					open={whatsappPair.open}
					onOpenChange={(open) => {
						setWhatsappPair((current) => (current ? { ...current, open } : current));
					}}
					onCloseComplete={() => {
						setWhatsappPair((current) => (current?.open === false ? null : current));
					}}
					agentId={environmentId}
					accountId={whatsappPair.accountId}
					agentLinkId={whatsappPair.agentLinkId}
					channelName={whatsappPair.channelName}
					bindingCount={bindingCountForLink(whatsappPair.agentLinkId)}
				/>
			) : null}
			{whatsappRepair ? (
				<WhatsAppRepairDialog
					open
					accountId={whatsappRepair.accountId}
					channelName={whatsappRepair.channelName}
					onOpenChange={(open) => {
						if (!open) setWhatsappRepair(null);
					}}
					onRepaired={() => {
						const repaired = whatsappRepair;
						setWhatsappRepair(null);
						void submitLink(repaired.accountId, repaired.replaceExistingProviderLink).catch(
							() => undefined,
						);
					}}
				/>
			) : null}
		</div>
	);
}

function AgentChannelBotsSection({
	kind,
	title,
	description,
	bots,
	isLoading,
	error,
	onRetry,
	emptyTitle,
	action,
	renderBot,
}: {
	kind: "clawdi" | "custom";
	title: string;
	description: string;
	bots: AgentChannelCardItem[];
	isLoading: boolean;
	error: Error | null;
	onRetry: () => void;
	emptyTitle: string;
	action?: React.ReactNode;
	renderBot: (bot: AgentChannelCardItem) => React.ReactNode;
}) {
	return (
		<section
			data-agent-channel-section={kind}
			tabIndex={-1}
			className="flex min-w-0 scroll-mt-6 flex-col gap-3 outline-none"
		>
			<div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<SectionLabel count={bots.length}>{title}</SectionLabel>
					<p className="mt-1 min-w-0 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
						{description}
					</p>
				</div>
				{action ? <div className="flex min-w-0 flex-wrap">{action}</div> : null}
			</div>
			{error ? (
				<ApiErrorPanel error={error} title={`Couldn't load ${title}`} onRetry={onRetry} />
			) : null}
			{isLoading && bots.length === 0 ? (
				<div role="status" className={CHANNEL_CARD_GRID_CLASS}>
					<span className="sr-only">Loading {title}</span>
					<EntityCardSkeleton actions />
					<EntityCardSkeleton actions />
				</div>
			) : bots.length > 0 ? (
				<div className={CHANNEL_CARD_GRID_CLASS}>
					{bots.map((bot) => (
						<div key={bot.id} className="h-full min-w-0">
							{renderBot(bot)}
						</div>
					))}
				</div>
			) : !isLoading && !error ? (
				<div className="min-w-0 rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
					{emptyTitle}
				</div>
			) : null}
		</section>
	);
}

function AgentChannelBotCard({
	bot,
	agentId,
	agentName,
	agentType,
	linkedProviders,
	linking,
	unlinking,
	deleting,
	onLink,
	onUnlink,
	onDelete,
}: {
	bot: AgentChannelCardItem;
	agentId: string;
	agentName: string;
	agentType: HostedRuntime;
	linkedProviders: ReadonlySet<string> | undefined;
	linking: boolean;
	unlinking: boolean;
	deleting: boolean;
	onLink: (replaceExistingProviderLink: boolean) => Promise<void>;
	onUnlink: () => void;
	onDelete: () => Promise<void>;
}) {
	const unavailableReason = agentChannelLinkUnavailableReason({ bot, agentType, linkedProviders });
	const replacementRequired = agentProviderLinkReplacementRequired(
		agentType,
		bot.provider,
		linkedProviders,
	);
	const linkButton = (
		<Button
			type="button"
			size="sm"
			className="min-w-20"
			disabled={Boolean(unavailableReason) || linking}
			onClick={replacementRequired ? undefined : () => void onLink(false).catch(() => undefined)}
		>
			{linking ? <Spinner className="size-3.5" /> : <Link2 className="size-3.5" />}
			{linking ? "Linking…" : "Link"}
		</Button>
	);
	const deleteAction =
		bot.visibility === "private" && !bot.link ? (
			<ConfirmAction
				title={`Delete ${bot.name}?`}
				description="This deletes the Custom bot, its Agent links, and its paired chats. This can't be undone."
				confirmLabel="Delete custom bot"
				destructive
				onConfirm={onDelete}
			>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className={cn(CHANNEL_DESTRUCTIVE_ACTION_CLASS, "min-w-20")}
					disabled={deleting}
					aria-label={`Delete ${bot.name}`}
				>
					{deleting ? <Spinner className="size-3.5" /> : <Trash2 className="size-3.5" />}
					{deleting ? "Deleting…" : "Delete"}
				</Button>
			</ConfirmAction>
		) : null;
	return (
		<div data-agent-channel-account-id={bot.id} className="h-full min-w-0">
			{bot.link ? (
				<ConnectedChannelGroup
					link={bot.link}
					agentId={agentId}
					fallbackAccount={{
						provider: bot.provider,
						name: bot.name,
						visibility: bot.visibility,
					}}
					agentName={agentName}
					unlinking={unlinking}
					onUnlink={onUnlink}
				/>
			) : (
				<AgentChannelCard
					provider={bot.provider}
					title={bot.name}
					state={unavailableReason ?? "Available"}
					actions={
						<div className="flex min-w-0 items-center gap-2">
							{deleteAction}
							{replacementRequired ? (
								<ProviderLinkReplacementConfirm
									provider={bot.provider}
									targetName={bot.name}
									onConfirm={() => onLink(true)}
								>
									{linkButton}
								</ProviderLinkReplacementConfirm>
							) : (
								linkButton
							)}
						</div>
					}
				/>
			)}
		</div>
	);
}

function ConnectedChannelGroup({
	link,
	agentId,
	onUnlink,
	unlinking,
	fallbackAccount,
	agentName,
}: {
	link: AgentChannelLink;
	agentId: string;
	onUnlink: () => void;
	unlinking: boolean;
	fallbackAccount?: ChannelAccountSummary;
	agentName: string;
}) {
	const provider = link.account?.provider ?? fallbackAccount?.provider ?? "";
	const channelName = link.account?.name ?? fallbackAccount?.name ?? "Unnamed channel";

	return (
		<div data-agent-channel-group-id={link.id} className="h-full min-w-0">
			<LinkedChannelRow
				link={link}
				agentId={agentId}
				fallbackAccount={fallbackAccount}
				agentName={agentName}
				unlinking={unlinking}
				onUnlink={onUnlink}
				pairedChatsControl={
					<PairedChatsDialog
						agentId={agentId}
						accountId={link.account_id}
						linkId={link.id}
						channelName={channelName}
						provider={provider}
						bindingCount={link.binding_count}
					/>
				}
			/>
		</div>
	);
}

type AgentPairCodeResult = {
	code: string;
	expires_at: string;
	pairing_command: string;
};

function LinkedChannelRow({
	link,
	agentId,
	onUnlink,
	unlinking,
	fallbackAccount,
	agentName,
	pairedChatsControl,
}: {
	link: AgentChannelLink;
	agentId: string;
	onUnlink: () => void;
	unlinking: boolean;
	fallbackAccount?: ChannelAccountSummary;
	agentName: string;
	pairedChatsControl: React.ReactNode;
}) {
	const pair = useCreatePairCode(link.account_id, { agentId });
	const [code, setCode] = useState<AgentPairCodeResult | null>(null);
	const [telegramPairOpen, setTelegramPairOpen] = useState(false);
	const [discordPairOpen, setDiscordPairOpen] = useState(false);
	const [whatsappPairOpen, setWhatsappPairOpen] = useState(false);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const [creatingPairCode, setCreatingPairCode] = useState(false);
	const pairInFlightRef = useRef(false);
	// The list-by-agent payload may omit the nested `account`. Fall back to the
	// loaded channels/bot-pool summary, then to the raw account id, so a missing
	// account NEVER white-screens (apps/web/src has no ErrorBoundary).
	const account = link.account ?? fallbackAccount ?? null;
	const provider = account?.provider ?? "";
	const isDiscord = provider === "discord";
	const isWhatsApp = provider === "whatsapp";
	const usesPairDialog = provider === "telegram" || isDiscord || isWhatsApp;
	const name = account?.name ?? "Unnamed channel";
	useEffect(() => {
		if (!code) return;
		setNowMs(Date.now());
		const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
		return () => window.clearInterval(interval);
	}, [code]);
	async function createPairCode() {
		if (pairInFlightRef.current) return;
		pairInFlightRef.current = true;
		setCreatingPairCode(true);
		try {
			const data = await pair.execute({ agent_link_id: link.id });
			setCode({
				code: data.code,
				expires_at: data.expires_at,
				pairing_command: data.pairing_command,
			});
		} catch {
			// useCreatePairCode already surfaces the API error.
		} finally {
			pairInFlightRef.current = false;
			setCreatingPairCode(false);
		}
	}
	const relationshipState = [
		pairedChatsControl,
		!isNormalChannelStatus(link.status) ? (
			<ChannelStatusBadge key="status" status={link.status} />
		) : null,
		!usesPairDialog && pair.error ? (
			<span key="pair-error" className="font-medium text-destructive">
				Pair failed · Try again
			</span>
		) : null,
		code && !usesPairDialog ? (
			<span key="pair-code" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				<CopyInline value={code.pairing_command} label="pairing command" />
				<span className="text-muted-foreground">{pairCodeExpiryLabel(code.expires_at, nowMs)}</span>
			</span>
		) : null,
	];
	return (
		<>
			<div data-agent-channel-link-id={link.id} className="h-full min-w-0">
				<AgentChannelCard
					provider={provider}
					title={name}
					state={relationshipState}
					actions={
						<div className={AGENT_CHANNEL_PAIR_ACTIONS_CLASS}>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="min-w-20"
								disabled={!usesPairDialog && creatingPairCode}
								onClick={() => {
									if (provider === "telegram") setTelegramPairOpen(true);
									else if (isDiscord) setDiscordPairOpen(true);
									else if (isWhatsApp) setWhatsappPairOpen(true);
									else void createPairCode();
								}}
							>
								{creatingPairCode ? (
									<Spinner className="size-3.5" />
								) : (
									<QrCode className="size-3.5" />
								)}
								{creatingPairCode ? "Generating…" : "Pair"}
							</Button>
							<ConfirmAction
								title={`Unlink ${name}?`}
								description={<p>{agentName} will stop answering through this bot.</p>}
								confirmLabel="Unlink"
								destructive
								onConfirm={onUnlink}
							>
								<Button
									variant="ghost"
									size="sm"
									className={cn(CHANNEL_DESTRUCTIVE_ACTION_CLASS, "min-w-20")}
									disabled={unlinking}
									aria-label={`${unlinking ? "Unlinking" : "Unlink"} ${name} from ${agentName}`}
								>
									{unlinking ? (
										<>
											<Spinner className="size-3.5" />
											Unlinking…
										</>
									) : (
										<>
											<Link2Off className="size-3.5" />
											<span>Unlink</span>
										</>
									)}
								</Button>
							</ConfirmAction>
						</div>
					}
				/>
			</div>
			{provider === "telegram" ? (
				<TelegramPairDialog
					open={telegramPairOpen}
					onOpenChange={setTelegramPairOpen}
					agentId={agentId}
					accountId={link.account_id}
					agentLinkId={link.id}
					channelName={name}
					bindingCount={link.binding_count}
				/>
			) : null}
			{isDiscord ? (
				<DiscordPairDialog
					open={discordPairOpen}
					onOpenChange={setDiscordPairOpen}
					agentId={agentId}
					accountId={link.account_id}
					agentLinkId={link.id}
					channelName={name}
					bindingCount={link.binding_count}
				/>
			) : null}
			{isWhatsApp ? (
				<WhatsAppPairDialog
					open={whatsappPairOpen}
					onOpenChange={setWhatsappPairOpen}
					agentId={agentId}
					accountId={link.account_id}
					agentLinkId={link.id}
					channelName={name}
					bindingCount={link.binding_count}
				/>
			) : null}
		</>
	);
}

// ── Settings / Compute ───────────────────────────────────────────────────────

function HostedAgentSettingsTab({
	environmentId,
	deployment,
	agent,
	routeSearch,
	onDeleteAccepted,
}: {
	environmentId: string;
	deployment: HostedDeployment;
	agent: components["schemas"]["AgentResponse"] | null;
	routeSearch: AgentRouteSearch;
	onDeleteAccepted: (deploymentId: string) => Promise<void> | void;
}) {
	return (
		<UnsavedNavigationBoundary description="Your agent settings will return to the last values saved on the server.">
			<div className="flex w-full flex-col gap-8">
				{agent ? (
					<AgentSettingsPanel environmentId={environmentId} />
				) : (
					<ProjectionDependentUnavailable label="Profile settings" />
				)}
				<LanguageTimezoneSettingsSection deployment={deployment} />
				<ComputeSettingsSections
					deployment={deployment}
					routeSearch={routeSearch}
					onDeleteAccepted={onDeleteAccepted}
				/>
			</div>
		</UnsavedNavigationBoundary>
	);
}

function LanguageTimezoneSettingsSection({ deployment }: { deployment: HostedDeployment }) {
	const runtimeConfiguration = deployment.resource.spec.runtime_configuration;
	const configLanguage = runtimeConfiguration.language ?? "";
	const configTimezone = runtimeConfiguration.timezone ?? "";
	const updateDeployment = useUpdateDeployment();
	const updateInProgress =
		deploymentStatusFromResource(deployment.resource.status).kind === "updating";
	const localeIdentity = `${configLanguage}\0${configTimezone}`;
	const [syncedLocaleIdentity, setSyncedLocaleIdentity] = useState(localeIdentity);
	const [language, setLanguage] = useState(configLanguage);
	const [timezone, setTimezone] = useState(configTimezone);
	const [runtimeTimezoneOptions, setRuntimeTimezoneOptions] = useState(() =>
		fallbackTimezones(configTimezone ? [configTimezone] : []),
	);
	if (syncedLocaleIdentity !== localeIdentity) {
		setSyncedLocaleIdentity(localeIdentity);
		setLanguage(configLanguage);
		setTimezone(configTimezone);
	}
	useEffect(() => {
		setRuntimeTimezoneOptions(supportedTimezones(configTimezone ? [configTimezone] : []));
	}, [configTimezone]);
	const timezoneOptions = useMemo(
		() => mergeTimezoneOptions(runtimeTimezoneOptions, [configTimezone, timezone].filter(Boolean)),
		[configTimezone, runtimeTimezoneOptions, timezone],
	);
	const dirty = language !== configLanguage || timezone !== configTimezone;
	useUnsavedNavigationState({ dirty, busy: updateDeployment.isPending });

	return (
		<SettingsSection
			title="Language & timezone"
			description="Language and time zone used by this agent."
		>
			<div className="flex w-full flex-col gap-4">
				<LiveNote>Changes apply to this agent.</LiveNote>
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
								<SelectItem value="default">Agent default</SelectItem>
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
	routeSearch,
	onDeleteAccepted,
}: {
	deployment: HostedDeployment;
	routeSearch: AgentRouteSearch;
	onDeleteAccepted: (deploymentId: string) => Promise<void> | void;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const billingClient = useBillingClient();
	const navigateCheckoutReturn = useCallback(
		async (target: CheckoutReturnNavigationTarget): Promise<boolean> => {
			if (target.kind !== "deployment") return false;
			const checkoutDeploymentId = target.deploymentId;
			if (checkoutDeploymentId === deployment.resource.id) return false;
			const hydrateAndNavigate = async (): Promise<boolean> => {
				try {
					await navigateToAcceptedDeployment({
						deploymentId: checkoutDeploymentId,
						getDeployment: billingClient.getDeployment,
						navigate: (options) => router.navigate(options),
						queryClient,
						replace: true,
					});
					toast.dismiss(`checkout-deployment-${checkoutDeploymentId}`);
					return true;
				} catch {
					toast.error("Agent deployed, but details couldn’t load", {
						id: `checkout-deployment-${checkoutDeploymentId}`,
						description: "Retrying loads the deployed Agent without repeating checkout.",
						duration: Number.POSITIVE_INFINITY,
						action: {
							label: "Retry",
							onClick: () => void hydrateAndNavigate(),
						},
					});
					return false;
				}
			};
			return hydrateAndNavigate();
		},
		[billingClient.getDeployment, deployment.resource.id, queryClient, router],
	);
	useCheckoutReturnHandler({
		onCancelCopy: "You were not charged. Your compute plan is unchanged.",
		onNavigate: navigateCheckoutReturn,
	});
	const hostedAccess = useProductAccess();
	const lifecycle = useDeploymentLifecycle();
	const plans = usePlans();
	const [subscriptionCreateOpen, setSubscriptionCreateOpen] = useState(false);
	const [planChangeOpen, setPlanChangeOpen] = useState(false);
	const [hasPendingPlanChange, setHasPendingPlanChange] = useState(false);
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
	const rawComputePlanSlug = deployment.current_plan_slug;
	const computePlanSlug =
		rawComputePlanSlug === COMPUTE_BASIC_SLUG || rawComputePlanSlug === COMPUTE_PERFORMANCE_SLUG
			? rawComputePlanSlug
			: undefined;
	const currentSubscription = deployment.commercial_display?.compute_subscription;
	const fundingSource = computeFundingSource(computePlanSlug, currentSubscription);
	const dunningState = computeDunningState(deployment);
	const terminalRecovery = dunningState?.recoveryTarget.kind === "start_new" ? dunningState : null;
	const hasWalletFallback = terminalRecovery?.fundingSource === "wallet";
	const pendingPlanSlug = pendingComputePlanSlug(currentSubscription);
	const tierLabel = computeTierLabel(computePlanSlug);
	const currentBillingTerm = planChangeBillingTerm(currentSubscription?.billing_term_months ?? 1);
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
	const subscriptionCancellationCopy = computeSubscriptionCancellationCopy({
		isTrial: currentSubscription?.actions?.cancel === "end_trial",
		periodEndLabel: subscriptionEndsAt ? subscriptionPeriodLabel : null,
		hasRetainedDeployment: true,
	});
	const subscriptionLifecycle = currentSubscription
		? computeSubscriptionLifecycle(currentSubscription)
		: null;
	const computeRecovery = computeSubscriptionRecoveryPresentation(
		currentSubscription,
		subscriptionLifecycle
			? { label: subscriptionLifecycle.badgeLabel, tone: subscriptionLifecycle.badgeTone }
			: { label: "Unavailable", tone: "neutral" },
	);
	const actionRecoveryTarget = terminalRecovery?.recoveryTarget ?? computeRecovery.recoveryTarget;
	const canOfferStartNew = actionRecoveryTarget?.kind === "start_new";
	const computeCardView = computeSubscriptionCardView({
		status: computeRecovery.status,
		planSlug: computePlanSlug ?? rawComputePlanSlug,
		fundingSource:
			fundingSource === "included_basic"
				? "included"
				: fundingSource === "stripe" || fundingSource === "wallet"
					? fundingSource
					: "unavailable",
		priceCents: currentPriceCents,
		currency: currentSubscription?.currency ?? "usd",
		billingTermMonths: currentBillingTerm,
		scheduleVerb: computeRecovery.schedule?.verb ?? subscriptionLifecycle?.dateVerb ?? null,
		scheduleAt: computeRecovery.schedule?.at ?? subscriptionLifecycle?.dateAt,
		scheduleFallback: computeRecovery.schedule?.fallback ?? undefined,
	});
	const pendingPlanCopy = pendingPlanSlug
		? pendingPlanScheduleCopy(
				pendingPlanSlug,
				currentSubscription?.current_period_end,
				subscriptionPeriodLabel,
			)
		: null;
	const computeManagement: ComputeSubscriptionManagementResult = currentSubscription
		? computeSubscriptionManagement({
				entitlement: {
					deploymentId: deployment.resource.id,
					planSlug: computePlanSlug,
					fundingSource: currentSubscription.funding_source,
					priceCents: currentSubscription.price_cents,
					billingTermMonths: currentSubscription.billing_term_months,
					status: currentSubscription.status,
					paymentState: currentSubscription.payment_state,
					cancelAtPeriodEnd: subscriptionCancelPending,
					recoveryAction: currentSubscription.recovery_action,
					pendingPlanSlug,
				},
				deployment,
				canCreateCloudAgents: hostedAccess.canCreateCloudAgents,
				plansLoading: plans.isLoading,
				performancePlanAvailable: Boolean(perfPlan),
			})
		: { action: "hidden", target: null, unavailableReason: null };
	const hasPendingComputeChange =
		hasPendingPlanChange ||
		(computeManagement.action === "enabled" &&
			computeManagement.target.projectedOperationName !== null);
	const computeManagementReason = computeManagement.unavailableReason;
	const subscriptionCreatePlanSlug = resolveSubscriptionCreatePlanSlug(
		terminalRecovery?.recoveryPlanSlug ?? pendingPlanSlug ?? computePlanSlug,
		{
			basicAvailable: !!basicPlan,
			performanceAvailable: !!perfPlan,
		},
	);
	const createUnavailableMessage = !canOfferStartNew
		? null
		: plans.isLoading
			? "Checking paid compute availability…"
			: !hostedAccess.canCreateCloudAgents
				? "New subscriptions are temporarily unavailable."
				: !(basicPlan || perfPlan)
					? "Paid compute plans are unavailable right now."
					: null;
	const computeActions = resolveComputeSubscriptionActions({
		entitlement: {
			deploymentId: deployment.resource.id,
			planSlug: computePlanSlug,
			fundingSource: currentSubscription?.funding_source,
			priceCents: currentSubscription?.price_cents,
			status: currentSubscription?.status ?? "unavailable",
			paymentState: currentSubscription?.payment_state ?? "ok",
			cancelAtPeriodEnd: subscriptionCancelPending,
			pendingPlanSlug,
			actions: currentSubscription?.actions,
		},
		management: computeManagement,
		recoveryTarget: actionRecoveryTarget,
		hasPendingOperation: hasPendingComputeChange,
		startNewUnavailableReason: createUnavailableMessage,
	});
	useEffect(() => {
		if (hostedAccess.isLoading || hostedAccess.canCreateCloudAgents) return;
		setSubscriptionCreateOpen(false);
		setPlanChangeOpen(false);
	}, [hostedAccess.canCreateCloudAgents, hostedAccess.isLoading]);
	useEffect(() => {
		if (routeSearch.subscription_action !== "start_new") return;
		if (hostedAccess.isLoading || plans.isLoading) return;
		if (
			canOfferStartNew &&
			!hasPendingComputeChange &&
			hostedAccess.canCreateCloudAgents &&
			(basicPlan || perfPlan)
		) {
			setSubscriptionCreateOpen(true);
		}
		void router.navigate({
			to: ".",
			search: (current) => {
				const next = { ...current };
				delete next.subscription_action;
				return next;
			},
			hash: true,
			replace: true,
			resetScroll: false,
		});
	}, [
		basicPlan,
		canOfferStartNew,
		hasPendingComputeChange,
		hostedAccess.canCreateCloudAgents,
		hostedAccess.isLoading,
		perfPlan,
		plans.isLoading,
		routeSearch.subscription_action,
		router,
	]);

	async function runLifecycleAction(action: "restart" | "stop" | "start") {
		await lifecycle.mutateAsync({ id: deployment.resource.id, action });
	}

	return (
		<div className="flex flex-col gap-8">
			{canOfferStartNew ? (
				<SubscriptionCreateDialog
					open={subscriptionCreateOpen}
					onOpenChange={setSubscriptionCreateOpen}
					plans={plans.data ?? []}
					deploymentId={deployment.resource.id}
					initialPlanSlug={subscriptionCreatePlanSlug}
					initialBillingTermMonths={currentBillingTerm}
				/>
			) : null}
			{computeManagement.target ? (
				<PlanChangeController
					open={planChangeOpen}
					onOpenChange={setPlanChangeOpen}
					onPendingChange={setHasPendingPlanChange}
					target={computeManagement.target}
					plans={plans.data ?? []}
				/>
			) : null}

			<SettingsSection title="Compute plan" description="Compute resources for this hosted agent.">
				<ComputeSubscriptionCard
					headingLevel={3}
					view={computeCardView}
					actionsId="compute-plan-controls"
					className="w-full"
					badges={
						hasWalletFallback ? (
							<Badge variant="outline" className="font-normal text-muted-foreground">
								Wallet fallback
							</Badge>
						) : null
					}
					notice={
						pendingPlanCopy || computeManagementReason || createUnavailableMessage ? (
							<div className="flex flex-col gap-1 text-xs text-muted-foreground">
								{pendingPlanCopy ? (
									<p className="font-medium text-warning-muted-foreground">{pendingPlanCopy}</p>
								) : null}
								{computeManagementReason ? <p>{computeManagementReason}</p> : null}
								{createUnavailableMessage ? <p>{createUnavailableMessage}</p> : null}
							</div>
						) : null
					}
					actions={
						<ComputeSubscriptionActionList
							actions={computeActions}
							target={{ kind: "deployment", deploymentId: deployment.resource.id }}
							onPlanChange={() => setPlanChangeOpen(true)}
							onStartNew={{
								kind: "button",
								onClick: () => setSubscriptionCreateOpen(true),
								label: "Choose a subscription",
							}}
							cancelCopy={{
								title: `Cancel ${tierLabel} subscription?`,
								description: <p>{subscriptionCancellationCopy.description}</p>,
								confirmLabel: subscriptionCancellationCopy.confirmLabel,
								successDescription: (result) =>
									computeSubscriptionCancellationSuccessCopy({
										isTrial: currentSubscription?.actions?.cancel === "end_trial",
										cancelAtPeriodEnd: result.cancel_at_period_end,
										periodEndLabel: result.current_period_end
											? formatShortDate(result.current_period_end)
											: null,
										hasRetainedDeployment: true,
									}),
							}}
						/>
					}
				/>
			</SettingsSection>

			<SettingsSection title="Agent controls" description="Restart, stop, or start this agent.">
				<div className="flex flex-wrap gap-2.5">
					<ConfirmAction
						title="Restart agent?"
						description={<p>This restarts the whole agent.</p>}
						confirmLabel="Restart agent"
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
							title="Stop agent?"
							description={
								<p>
									This pauses its browser tools, terminal, sessions, and channels until you start it
									again.
								</p>
							}
							confirmLabel="Stop agent"
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
						<StartComputeAction
							deployment={deployment}
							label="Start"
							variant="outline"
							disabled={
								lifecycle.isPending ||
								!canRunPrimaryLifecycleAction ||
								(computeSubscriptionRequiredToStart(deployment) &&
									(createUnavailableMessage !== null ||
										hasPendingComputeChange ||
										hostedAccess.isLoading))
							}
							onSubscribe={() => setSubscriptionCreateOpen(true)}
						/>
					)}
				</div>
			</SettingsSection>

			<SettingsSection
				title="Danger zone"
				description="Permanently delete this agent."
				variant="destructive"
			>
				<div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
					<div>
						<div className="text-sm font-medium">Delete this agent</div>
						<p className="text-xs text-muted-foreground">
							Deletes this agent and its saved data. This can’t be undone.
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
