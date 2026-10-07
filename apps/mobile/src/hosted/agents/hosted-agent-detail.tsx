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
	canRetryInitialDeployment,
	deploymentFailurePresentation,
	deploymentFilesUrl,
	deploymentPollingState,
	deploymentRuntimeStatusPresentation,
	deploymentStatusFromResource,
	initialDeploymentCopy,
	RUNTIME_UI_WITHDRAWN_DESCRIPTION,
	runtimeConsoleCopy,
	runtimeConsolePresentation,
	runtimeDisplayName,
	type SettlingTracker,
	shouldShowInitialDeploymentProgress,
	stoppedAgentDescription,
} from "@clawdi/shared/view";
import { focusManager, onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { Redirect, useRouter } from "expo-router";
import { FolderOpen, MonitorPlay, TerminalSquare } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text as AppText, Text } from "@/components/ui/text";
import { AppScrollView } from "@/components/ui/view";
import { WebView, webView } from "@/components/ui/web-layout";
import { isNotFound, useCloudAgent } from "@/hooks/cloud-inventory";
import { ComputeStatusDetails } from "@/hosted/agents/compute-status-details";
import { CancelOperation } from "@/hosted/agents/deployment-cancel-action";
import { DeploymentControls } from "@/hosted/agents/deployment-controls";
import { InitialDeploymentPage } from "@/hosted/agents/initial-deployment-page";
import { RuntimeBrowser } from "@/hosted/agents/runtime-handoff";
import { StartComputeAction } from "@/hosted/agents/start-compute-action";
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
	const [managementBusy, setManagementBusy] = useState(false);
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
	const initial = Boolean(deployment && shouldShowInitialDeploymentProgress(status, failure));
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
					title={view.state === "running" ? t("files.webOnlyTitle") : view.title}
					description={view.state === "running" ? t("files.webOnlyDescription") : view.description}
					action={
						view.state === "running" ? (
							<ActionButton
								label={runtimeConsoleCopy.terminal}
								onPress={() => router.push(agentSectionHref(deployment.agent_id ?? "", "terminal"))}
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
								? "Stopped"
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

	if (management)
		return (
			<SheetPage
				title="Agent settings"
				busy={managementBusy}
				fallback={deployment?.agent_id ? `/agents/${deployment.agent_id}` : "/agents"}
			>
				{deployment ? <ComputeStatusDetails deployment={deployment} /> : null}
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
				{deletionReported ? (
					<AppText accessibilityRole="alert">{t("runtime.deleteReported")}</AppText>
				) : (
					<DeploymentControls
						onBusyChange={setManagementBusy}
						deployment={deployment}
						deploymentId={deploymentId ?? ""}
						blocked={
							query.isError ||
							(activeOperation?.metadata?.verb === "delete" && !activeOperation.done)
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
					/>
				)}
				{deployment ? (
					<WebView recipe={agentsIndexClasses.page}>
						<Button
							variant="outline"
							size="sm"
							onPress={() => {
								router.push({
									pathname: "/terminal/[id]",
									params: { id: deployment.agent_id ?? "" },
								});
							}}
						>
							<Icon as={TerminalSquare} />
							<Text>{t("terminal.title")}</Text>
						</Button>
						<ActionButton
							label={t("workspaceSkills.title")}
							onPress={() => {
								router.push({
									pathname: "/agents/[id]/skills",
									params: { id: deployment.agent_id ?? "", tab: "workspace" },
								});
							}}
						/>
						{deploymentFailurePresentation(deployment) ? (
							<Text accessibilityRole="alert">
								{deploymentFailurePresentation(deployment)?.reason}
							</Text>
						) : null}

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
						{!deletionReported &&
						operation.data &&
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
						{deploymentNeedsPolling(deployment) &&
						Date.now() - startedAt >= DEPLOYMENT_POLL_WINDOW_MS ? (
							<AppText>{t("deployments.timeout")}</AppText>
						) : null}

						{deployment.agent_id ? (
							<ActionButton
								label={t("deployments.agent")}
								onPress={() => {
									if (deployment.agent_id && scope.isCurrent() && !scope.signal.aborted)
										router.push(`/agents/${encodeURIComponent(deployment.agent_id)}`);
								}}
							/>
						) : (
							<AppText>{t("deployments.agentUnavailable")}</AppText>
						)}
					</WebView>
				) : null}
			</SheetPage>
		);
	return (
		<SafeAreaScreen>
			<AppScrollView contentContainerClassName={`${webView(agentsIndexClasses.page)} pt-5 pb-6`}>
				{deployment?.agent_id ? (
					<AgentSectionNavigation agentId={deployment.agent_id} />
				) : (
					<BackButton />
				)}
				<PageHeader
					title={deployment?.resource.name ?? "Overview"}
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
								status={status}
								runtimeLabel={runtimeDisplayName(deployment.resource.spec.runtime)}
								failure={failure}
								timedOut={transition === "timed_out" || transition === "escalated"}
								escalated={transition === "escalated"}
								actions={
									failure?.failedVerb === "create" && canRetryInitialDeployment(failure) ? (
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
									) : transition === "timed_out" || transition === "escalated" ? (
										<WebView recipe="flex flex-wrap gap-2">
											<ActionButton
												label={initialDeploymentCopy.check}
												disabled={query.isFetching || operation.isFetching}
												onPress={() => void checkAgain()}
											/>
											{transition === "escalated" && cancellableOperation ? (
												<CancelOperation
													operation={cancellableOperation}
													onRequested={checkAgain}
												/>
											) : null}
										</WebView>
									) : undefined
								}
							/>
						) : null}
						{deployment && !initial && agent.data ? (
							<AgentOverview
								agent={agent.data}
								deployment={deployment}
								onManage={() => {
									if (deployment.agent_id)
										router.push({
											pathname: "/agents/[id]/compute",
											params: { id: deployment.agent_id },
										});
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
