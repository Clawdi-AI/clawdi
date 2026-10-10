import {
	type DeploymentRead,
	deploymentLifecycleAvailable,
	type HostedDeployOperation,
} from "@clawdi/shared/api";
import { agentsIndexClasses } from "@clawdi/shared/ui";
import {
	agentFilesPresentation,
	agentOverviewCopy,
	agentSurfaceCopy,
	agentToolSectionCopy,
	canRetryInitialDeployment,
	deploymentAwaitingRuntimeUi,
	deploymentFailurePresentation,
	deploymentFilesUrl,
	deploymentPollingState,
	deploymentProvisioningPath,
	deploymentRuntimeStatusPresentation,
	deploymentStatusFromResource,
	hostedDeploymentSetupInProgress,
	INITIAL_DEPLOYMENT_COMPLETE_PAUSE_MS,
	type InitialDeploymentSupportState,
	initialDeploymentCopy,
	initialDeploymentStartedAtMs,
	initialDeploymentSupportContext,
	initialDeploymentSupportMailto,
	RUNTIME_UI_WITHDRAWN_DESCRIPTION,
	runtimeConsoleCopy,
	runtimeConsolePresentation,
	type SettlingTracker,
	SUPPORT_EMAIL,
	shouldShowInitialDeploymentProgress,
	stoppedAgentDescription,
} from "@clawdi/shared/view";
import { focusManager, onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { Redirect, useRouter } from "expo-router";
import FolderOpen from "lucide-react-native/icons/folder-open";
import MonitorPlay from "lucide-react-native/icons/monitor-play";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Alert, Linking } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentOverview } from "@/components/dashboard/agent-overview-resource-bodies";
import { AgentSourceBadge } from "@/components/dashboard/agent-section-source-badge";
import { ActionButton } from "@/components/dashboard/controls";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { BackButton } from "@/components/detail/back-link";
import { LibraryPage } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { EntityCardSkeleton } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { ResourceError } from "@/components/resource-error";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { Text as AppText } from "@/components/ui/text";
import { AppScrollView } from "@/components/ui/view";
import { WebView, webView } from "@/components/ui/web-layout";
import { isNotFound, useCloudAgent } from "@/hooks/cloud-inventory";
import { hostedAgentTitle } from "@/hosted/agent-title";
import { ComputeStatusDetails } from "@/hosted/agents/compute-status-details";
import { CancelOperation } from "@/hosted/agents/deployment-cancel-action";
import { DeploymentControls } from "@/hosted/agents/deployment-controls";
import { FilesBrowser } from "@/hosted/agents/files-handoff";
import { InitialDeploymentPage } from "@/hosted/agents/initial-deployment-page";
import { RuntimeBrowser } from "@/hosted/agents/runtime-handoff";
import { StartComputeAction } from "@/hosted/agents/start-compute-action";
import { StoreUpgradeAction } from "@/hosted/billing/store/compute-store";
import {
	DEPLOYMENT_POLL_WINDOW_MS,
	deploymentNeedsPolling,
	operationIdFromName,
} from "@/hosted/deployment-status";
import { agentSectionHref } from "@/lib/agent-routes";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { NativeHeader } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

export function DeploymentDetailScreen({
	deploymentId,
	management,
	section,
}: {
	deploymentId: string | undefined;
	management?: boolean;
	section?: "console" | "files";
}) {
	const scope = useAccountScope();
	return (
		<DeploymentDetail
			key={`${scope.accountKey}:${scope.generation}:${deploymentId}`}
			deploymentId={deploymentId ?? ""}
			management={management}
			section={section}
		/>
	);
}

function DeploymentDetail({
	deploymentId,
	management,
	section,
}: {
	deploymentId: string | undefined;
	management?: boolean;
	section?: "console" | "files";
}) {
	const cache = useQueryClient();
	const [accepted, setAccepted] = useState<HostedDeployOperation | null>(null);
	const [deletionReported, setDeletionReported] = useState(false);
	const { hosted } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const router = useRouter();
	const t = useI18n();
	const [startedAt, setStartedAt] = useState(Date.now);
	const trackers = useRef<ReadonlyMap<string, SettlingTracker>>(new Map());
	const [, setPollEpoch] = useState(0);
	useEffect(() => {
		const refresh = () => setPollEpoch((value) => value + 1);
		const unsubscribeFocus = focusManager.subscribe(refresh);
		const unsubscribeOnline = onlineManager.subscribe(refresh);
		const timer = setInterval(() => {
			if (focusManager.isFocused() && onlineManager.isOnline()) refresh();
		}, 10_000);
		return () => {
			unsubscribeFocus();
			unsubscribeOnline();
			clearInterval(timer);
		};
	}, [startedAt]);
	const query = useQuery({
		queryKey: accountQueryKey(scope, "deployment", deploymentId ?? "missing"),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!hosted || !deploymentId) throw new Error("Deployment unavailable");
				return hosted.getDeployment(deploymentId, s);
			}, signal),
		enabled: scope.isReady && Boolean(hosted && deploymentId),
		retry: false,
		refetchInterval: (q) => {
			if (!focusManager.isFocused() || !onlineManager.isOnline() || q.state.error) return false;
			const polling = deploymentPollingState(
				q.state.data ? [q.state.data] : undefined,
				trackers.current,
				Date.now(),
			);
			trackers.current = polling.trackers;
			return polling.refetchInterval;
		},
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const deployment = query.data;
	const agent = useCloudAgent(deployment?.agent_id ?? undefined);
	useEffect(() => {
		if (
			accepted &&
			deployment?.accepted_operation &&
			(deployment.accepted_operation.name === accepted.name ||
				deployment.accepted_operation.metadata.targetGeneration >
					accepted.metadata.targetGeneration)
		)
			setAccepted(null);
	}, [accepted, deployment?.accepted_operation]);
	const operationName = accepted?.name ?? deployment?.accepted_operation?.name;
	const operationId = operationIdFromName(operationName);
	const operation = useQuery({
		queryKey: accountQueryKey(scope, "deployment-operation", operationName ?? "missing"),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!hosted || !operationId) throw new Error("Operation unavailable");
				return hosted.getOperation(operationId, s);
			}, signal),
		enabled: scope.isReady && Boolean(hosted && operationId),
		retry: false,
		refetchInterval: (q) =>
			focusManager.isFocused() && onlineManager.isOnline() && !q.state.error && !q.state.data?.done
				? deploymentPollingState(
						deployment ? [deployment] : undefined,
						trackers.current,
						Date.now(),
					).refetchInterval
				: false,
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const refreshResources = async () => {
		await Promise.all([
			cache.invalidateQueries({
				queryKey: accountQueryKey(scope, "deployment", deploymentId ?? "missing"),
			}),
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "deployments") }),
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "cloud-agents") }),
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "cloud-agent") }),
		]);
	};
	const activeOperation = operation.data ?? accepted ?? deployment?.accepted_operation;
	const cancellableOperation =
		activeOperation?.name === operationName &&
		activeOperation?.metadata.deploymentId === deploymentId &&
		!operation.isError
			? activeOperation
			: null;
	const polling = deploymentPollingState(
		deployment ? [deployment] : undefined,
		trackers.current,
		Date.now(),
	);
	trackers.current = polling.trackers;
	const transition = deployment ? polling.transitions.get(deployment.resource.id)?.kind : undefined;
	const failure = deployment ? deploymentFailurePresentation(deployment) : null;
	const status = deploymentStatusFromResource(deployment?.resource.status ?? null);
	const setupInProgress = Boolean(deployment && hostedDeploymentSetupInProgress(deployment));
	// Setup is done only when the agent runs and its web chat surface is published.
	const settingUp = Boolean(
		deployment && (shouldShowInitialDeploymentProgress(status, failure) || setupInProgress),
	);
	// Keep the completed state readable for a moment before the overview replaces it.
	const [wasSettingUp, setWasSettingUp] = useState(settingUp);
	const [completing, setCompleting] = useState(false);
	if (wasSettingUp !== settingUp) {
		setWasSettingUp(settingUp);
		if (wasSettingUp && status.kind === "running") setCompleting(true);
	}
	useEffect(() => {
		if (!completing) return;
		// Announce once and refresh the inventory that gates agent navigation elsewhere.
		AccessibilityInfo.announceForAccessibility(initialDeploymentCopy.ready);
		void cache.invalidateQueries({ queryKey: accountQueryKey(scope, "deployments") });
		const timeout = setTimeout(() => setCompleting(false), INITIAL_DEPLOYMENT_COMPLETE_PAUSE_MS);
		return () => clearTimeout(timeout);
	}, [cache, completing, scope]);
	const initial = settingUp || (completing && status.kind === "running");
	const checkAgain = async () => {
		await Promise.all([query.refetch(), ...(operationId ? [operation.refetch()] : [])]);
	};

	// Web shows the start control when stopped, and otherwise only while start is available.
	const startAction = (deployment: DeploymentRead, stopped: boolean) =>
		stopped || deploymentLifecycleAvailable("start", status.kind) ? (
			<StartComputeAction
				deployment={deployment}
				startLabel={stopped ? "Start" : undefined}
				blocked={query.isError}
				transitioning={Boolean(activeOperation && !activeOperation.done)}
				onAccepted={async (result) => {
					setAccepted(result);
					await refreshResources();
				}}
				onAbsent={refreshResources}
				onFunded={() => void refreshResources()}
			/>
		) : null;

	if (section === "files" && !deployment && query.isPending)
		return (
			<LibraryPage>
				<RouteLoadingSkeleton />
			</LibraryPage>
		);
	// Web hides Files without an authoritative endpoint and falls back to the overview.
	if (section === "files" && deployment?.agent_id && !deploymentFilesUrl(deployment))
		return <Redirect href={agentSectionHref(deployment.agent_id)} />;
	if (section === "files" && deployment) {
		const view = agentFilesPresentation(deployment);
		return (
			<SafeAreaScreen>
				<AgentSectionNavigation agentId={deployment.agent_id ?? ""} section="files" />
				{query.isError ? (
					<ApiErrorPanel error={query.error} onRetry={() => void query.refetch()} />
				) : null}
				<EmptyState
					// Web's StoppedAgentState keeps the default empty-state icon.
					icon={view.state === "stopped" ? undefined : FolderOpen}
					className="flex-1"
					title={view.state === "running" ? agentToolSectionCopy.files.label : view.title}
					description={
						view.state === "running" ? agentToolSectionCopy.files.description : view.description
					}
					action={
						view.state === "running" ? (
							<FilesBrowser
								deployment={deployment}
								onTerminal={() =>
									router.push(agentSectionHref(deployment.agent_id ?? "", "terminal"))
								}
							/>
						) : (
							startAction(deployment, view.state === "stopped")
						)
					}
				/>
			</SafeAreaScreen>
		);
	}

	if (section === "console" && deployment) {
		const view = runtimeConsolePresentation(
			deployment,
			transition === "timed_out" || transition === "escalated",
			transition === "escalated",
		);
		return (
			<SafeAreaScreen>
				<NativeHeader title={view.browserLabel} />
				<AgentSectionNavigation agentId={deployment.agent_id ?? ""} section="console" />
				{query.isError ? (
					<ApiErrorPanel error={query.error} onRetry={() => void query.refetch()} />
				) : null}
				<EmptyState
					icon={MonitorPlay}
					className="flex-1"
					title={
						view.state === "ready"
							? view.browserLabel
							: view.state === "stopped"
								? t("runtime.stoppedLabel")
								: view.state === "withdrawn"
									? view.withdrawnTitle
									: view.state === "pending"
										? view.pendingTitle
										: view.notRunningTitle
					}
					description={
						view.state === "stopped"
							? stoppedAgentDescription(deployment)
							: view.state === "withdrawn"
								? RUNTIME_UI_WITHDRAWN_DESCRIPTION
								: view.state === "pending"
									? view.pendingDescription
									: view.state === "not_running"
										? view.notRunningDescription
										: undefined
					}
					action={
						view.state === "ready" ? (
							<RuntimeBrowser deployment={deployment} />
						) : (
							<WebView recipe="flex flex-wrap justify-center gap-2" className="flex-row">
								{view.state === "pending" ||
								transition === "timed_out" ||
								transition === "escalated" ? (
									<ActionButton
										label={runtimeConsoleCopy.check}
										disabled={query.isFetching || operation.isFetching}
										onPress={() => void checkAgain()}
									/>
								) : null}
								{view.state === "withdrawn" ? (
									<ActionButton
										label={runtimeConsoleCopy.channels}
										onPress={() => router.push(`/agents/${deployment.agent_id}/channel-links`)}
									/>
								) : null}
								{view.state === "pending" || view.state === "withdrawn" ? (
									<ActionButton
										label={
											view.state === "pending"
												? runtimeConsoleCopy.terminalNow
												: runtimeConsoleCopy.terminal
										}
										onPress={() => router.push(`/agents/${deployment.agent_id}/terminal`)}
									/>
								) : null}
								{view.state === "stopped" || view.state === "not_running"
									? startAction(deployment, view.state === "stopped")
									: null}
								{transition === "escalated" && cancellableOperation ? (
									<CancelOperation operation={cancellableOperation} onRequested={checkAgain} />
								) : null}
							</WebView>
						)
					}
				/>
			</SafeAreaScreen>
		);
	}

	// Web's Settings tab: runtime controls sit under the agent's profile settings.
	if (management)
		return deletionReported ? (
			<AppText accessibilityRole="alert">{t("runtime.deleteReported")}</AppText>
		) : (
			<DeploymentControls
				deployment={deployment}
				deploymentId={deploymentId ?? ""}
				blocked={
					query.isError || (activeOperation?.metadata?.verb === "delete" && !activeOperation.done)
				}
				transitioning={Boolean(activeOperation && !activeOperation.done)}
				onAccepted={async (result) => {
					setAccepted(result);
					setStartedAt(Date.now());
					await refreshResources();
				}}
				onAbsent={async () => {
					setDeletionReported(true);
					await refreshResources();
				}}
				statusDetails={
					<>
						{deployment ? <ComputeStatusDetails deployment={deployment} /> : null}
						{deployment ? <StoreUpgradeAction deployment={deployment} /> : null}
						<ActionButton
							label={t("deployments.refresh")}
							disabled={query.isFetching || operation.isFetching}
							onPress={() => {
								setStartedAt(Date.now());
								void query.refetch();
								if (operationId) void operation.refetch();
							}}
						/>
						{query.isError ? <ResourceError missing={isNotFound(query.error)} /> : null}
						{query.isPending ? <AppText>{t("loading.app")}</AppText> : null}
						{operation.data ? (
							<AppText>
								{t("deployments.operation")}:{" "}
								{operation.data.done ? t("deployments.complete") : t("deployments.progress")}
							</AppText>
						) : null}
						{operation.data?.error ? (
							<AppText className="text-destructive">
								{t(
									operation.data.error.code === 1
										? "deployments.operationCancelled"
										: "deployments.failed",
								)}
							</AppText>
						) : null}
						{operation.isError ? <ResourceError missing={false} /> : null}
						{operation.data &&
						!operation.isError &&
						operation.data.name === operationName &&
						operation.data.metadata?.deploymentId === deploymentId ? (
							<CancelOperation
								key={operation.data.name}
								operation={operation.data}
								onRequested={async () => {
									setStartedAt(Date.now());
									await operation.refetch();
									await query.refetch();
								}}
							/>
						) : null}
						{deployment &&
						deploymentNeedsPolling(deployment) &&
						Date.now() - startedAt >= DEPLOYMENT_POLL_WINDOW_MS ? (
							<AppText>{t("deployments.timeout")}</AppText>
						) : null}
					</>
				}
			/>
		);
	return (
		<SafeAreaScreen>
			<AppScrollView contentContainerClassName={`${webView(agentsIndexClasses.page)} pt-5 pb-6`}>
				{deployment?.agent_id ? (
					<AgentSectionNavigation agentId={deployment.agent_id} />
				) : (
					<BackButton />
				)}
				{deployment && initial ? null : (
					<PageHeader
						title={hostedAgentTitle(agent.data, deployment) ?? t("navigation.home")}
						description={agentOverviewCopy.description}
						titleAdornment={
							deployment?.agent_id ? (
								<AgentSourceBadge
									agentId={deployment.agent_id}
									ownership={{
										cloudAgentIds: new Set([deployment.agent_id.toLowerCase()]),
										legacyAgentIds: new Set(),
										isResolved: true,
									}}
								/>
							) : undefined
						}
					/>
				)}
				{!hosted ? (
					<EmptyState
						title={agentSurfaceCopy.unavailable}
						description={t("deployments.unavailable")}
					/>
				) : !deploymentId ? (
					<ResourceError missing />
				) : (
					<>
						{query.isError ? (
							<ApiErrorPanel error={query.error} onRetry={() => void query.refetch()} />
						) : null}
						{query.isPending ? <EntityCardSkeleton /> : null}
						{deployment && initial ? (
							<InitialDeploymentPage
								runtime={deployment.resource.spec.runtime}
								avatarUrl={agent.data?.avatar_url}
								status={status}
								provisioningPath={deploymentProvisioningPath(deployment)}
								awaitingChat={deploymentAwaitingRuntimeUi(deployment)}
								startedAtMs={initialDeploymentStartedAtMs(deployment.accepted_operation)}
								failure={failure}
								timedOut={transition === "timed_out" || transition === "escalated"}
								escalated={transition === "escalated"}
								actions={
									failure?.failedVerb === "create" ? (
										<>
											{canRetryInitialDeployment(failure) ? (
												<DeploymentControls
													section="startup"
													deployment={deployment}
													deploymentId={deploymentId}
													blocked={query.isError}
													transitioning={Boolean(activeOperation && !activeOperation.done)}
													onAccepted={async (result) => {
														setAccepted(result);
														await refreshResources();
													}}
													onAbsent={refreshResources}
												/>
											) : null}
											<ContactSupportAction deployment={deployment} state="failed" />
										</>
									) : transition === "timed_out" || transition === "escalated" ? (
										<ContactSupportAction
											deployment={deployment}
											state={transition === "escalated" ? "stuck" : "delayed"}
										/>
									) : undefined
								}
							/>
						) : null}
						{deployment && !initial && agent.data ? (
							<AgentOverview
								agent={agent.data}
								deployment={deployment}
								onManage={() => {
									// Like Web, the Compute card opens the agent's Settings.
									if (deployment.agent_id)
										router.push(agentSectionHref(deployment.agent_id, "settings"));
								}}
							/>
						) : null}
						{deployment && !initial && !agent.data ? (
							<EmptyState
								title={deploymentRuntimeStatusPresentation(deployment.resource.status).label}
								description={
									agent.isError ? agentSurfaceCopy.unavailable : agentOverviewCopy.description
								}
							/>
						) : null}
					</>
				)}
			</AppScrollView>
		</SafeAreaScreen>
	);
}

/**
 * The app has no live chat, so support opens as an email to the address Web uses,
 * prefilled with the same setup context. Polling continues in the background.
 */
function ContactSupportAction({
	deployment,
	state,
}: {
	deployment: DeploymentRead;
	state: InitialDeploymentSupportState;
}) {
	return (
		<ActionButton
			label={initialDeploymentCopy.contactSupport}
			onPress={() => {
				const href = initialDeploymentSupportMailto(
					initialDeploymentSupportContext(deployment, state, Date.now()),
				);
				Linking.openURL(href).catch(() =>
					Alert.alert(initialDeploymentCopy.contactSupport, SUPPORT_EMAIL),
				);
			}}
		/>
	);
}
