import type { HostedDeployOperation } from "@clawdi/shared/api";
import { agentsIndexClasses } from "@clawdi/shared/ui";
import {
	agentOverviewCopy,
	agentSurfaceCopy,
	deploymentFailurePresentation,
	deploymentRuntimeStatusPresentation,
} from "@clawdi/shared/view";
import { focusManager, onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { TerminalSquare } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentOverview } from "@/components/dashboard/agent-overview-resource-bodies";
import { AgentSourceBadge } from "@/components/dashboard/agent-section-source-badge";
import { ActionButton } from "@/components/dashboard/controls";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { BackButton } from "@/components/detail/back-link";
import { EmptyState } from "@/components/empty-state";
import { EntityCardSkeleton } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { ResourceError } from "@/components/resource-error";
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
import {
	canPollDeployment,
	DEPLOYMENT_POLL_WINDOW_MS,
	deploymentNeedsPolling,
	operationIdFromName,
} from "@/hosted/deployment-status";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

export function DeploymentDetailScreen({
	deploymentId,
	management,
}: {
	deploymentId: string | undefined;
	management?: boolean;
}) {
	const scope = useAccountScope();
	return (
		<DeploymentDetail
			key={`${scope.accountKey}:${scope.generation}:${deploymentId}`}
			deploymentId={deploymentId ?? ""}
			management={management}
		/>
	);
}

function DeploymentDetail({
	deploymentId,
	management,
}: {
	deploymentId: string | undefined;
	management?: boolean;
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
	const [, setPollEpoch] = useState(0);
	useEffect(() => {
		const refresh = () => setPollEpoch((value) => value + 1);
		const unsubscribeFocus = focusManager.subscribe(refresh);
		const unsubscribeOnline = onlineManager.subscribe(refresh);
		const timer = setTimeout(
			refresh,
			Math.max(0, startedAt + DEPLOYMENT_POLL_WINDOW_MS - Date.now()),
		);
		return () => {
			unsubscribeFocus();
			unsubscribeOnline();
			clearTimeout(timer);
		};
	}, [startedAt]);
	const pollingAllowed = canPollDeployment(
		startedAt,
		Date.now(),
		focusManager.isFocused(),
		onlineManager.isOnline(),
	);
	const query = useQuery({
		queryKey: accountQueryKey(scope, "deployment", deploymentId ?? "missing"),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!hosted || !deploymentId) throw new Error("Deployment unavailable");
				return hosted.getDeployment(deploymentId, s);
			}, signal),
		enabled: scope.isReady && Boolean(hosted && deploymentId),
		retry: false,
		refetchInterval: (q) =>
			pollingAllowed &&
			!q.state.error &&
			deploymentNeedsPolling(q.state.data) &&
			canPollDeployment(startedAt, Date.now(), focusManager.isFocused(), onlineManager.isOnline())
				? 3000
				: false,
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
			pollingAllowed &&
			!q.state.error &&
			!q.state.data?.done &&
			canPollDeployment(startedAt, Date.now(), focusManager.isFocused(), onlineManager.isOnline())
				? 3000
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
						{deployment && agent.data ? (
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
						{deployment && !agent.data ? (
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
