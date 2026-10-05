import type { HostedDeployOperation } from "@clawdi/shared/api";
import {
	agentsIndexClasses,
	ENTITY_CARD_BASE,
	ENTITY_GRID_CLASS,
	RESOURCE_TINT_CLASSES,
} from "@clawdi/shared/ui";
import { agentSurfaceCopy, overviewComputeState } from "@clawdi/shared/view";
import { focusManager, onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Cpu, Laptop } from "lucide-react-native";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useMobileApi } from "../../providers/api-provider";
import { AgentCollection } from "../../ui/agents/collection";
import { ActionButton as NativeButton } from "../../ui/agents/controls";
import { AgentOverviewHeading, OverviewNavigationCard } from "../../ui/agents/overview";
import { OverviewComputeBody } from "../../ui/agents/overview-compute-body";
import { ApiErrorPanel } from "../../ui/api-error-panel";
import { EmptyState } from "../../ui/empty-state";
import { EntityCardSkeleton, EntityHeader } from "../../ui/entity-card";
import { EntityIcon } from "../../ui/entity-icon";
import { PageHeader } from "../../ui/page-header";
import { AppPressable, AppScrollView, AppText } from "../../ui/primitives";
import { ReadScreen } from "../../ui/read-screen";
import { WebView, webView } from "../../ui/web-layout";
import { BackButton, isNotFound } from "../cloud-inventory";
import { ResourceError } from "../resource-error";
import { RuntimeBrowser } from "./browser";
import { CancelOperation } from "./cancel";
import { DeploymentControls } from "./controls";
import {
	canPollDeployment,
	DEPLOYMENT_POLL_WINDOW_MS,
	deploymentNeedsPolling,
	deploymentSummaryKeys,
	operationIdFromName,
} from "./state";

export { deploymentsEn } from "./en";

export function DeploymentListScreen() {
	const { hosted } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const router = useRouter();
	const t = useI18n();
	const query = useQuery({
		queryKey: accountQueryKey(scope, "deployments"),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!hosted) throw new Error("Hosted API unavailable");
				return hosted.listDeployments(s);
			}, signal),
		enabled: scope.isReady && Boolean(hosted),
		retry: false,
	});
	if (!hosted)
		return (
			<AgentCollection
				title={agentSurfaceCopy.agents}
				description={agentSurfaceCopy.everyAgentInYourAccount}
			>
				<EmptyState
					title={agentSurfaceCopy.unavailable}
					description={t("deployments.unavailable")}
				/>
			</AgentCollection>
		);
	const refresh = () => {
		if (!query.isFetching) void query.refetch();
	};
	return (
		<AgentCollection
			title={agentSurfaceCopy.agents}
			description={agentSurfaceCopy.everyAgentInYourAccount}
		>
			{query.isError ? (
				<ApiErrorPanel
					error={query.error}
					title={agentSurfaceCopy.couldnTLoadAgents}
					onRetry={refresh}
				/>
			) : query.isPending ? (
				<WebView recipe={ENTITY_GRID_CLASS}>
					{[0, 1, 2].map((i) => (
						<EntityCardSkeleton key={i} />
					))}
				</WebView>
			) : !query.data?.length ? (
				<EmptyState
					title={agentSurfaceCopy.noAgentsYet}
					description={agentSurfaceCopy.connectAnAgentToSeeItHere}
				/>
			) : (
				<WebView recipe={ENTITY_GRID_CLASS}>
					{query.data.map((deployment) => (
						<AppPressable
							key={deployment.resource.id}
							accessibilityRole="link"
							className={webView(ENTITY_CARD_BASE)}
							onPress={() => {
								if (scope.isCurrent() && !scope.signal.aborted)
									router.push(`/deployments/${encodeURIComponent(deployment.resource.id)}`);
							}}
						>
							<EntityHeader
								title={deployment.resource.name}
								icon={
									<EntityIcon
										kind="framework"
										id={deployment.resource.spec.runtime}
										label={deployment.resource.spec.runtime}
									/>
								}
								meta={[
									deployment.resource.spec.runtime,
									t(
										deployment.resource.status
											? deploymentSummaryKeys[deployment.resource.status.summary_state]
											: "deployments.unknown",
									),
								]}
							/>
						</AppPressable>
					))}
				</WebView>
			)}
		</AgentCollection>
	);
}

export function DeploymentDetailScreen({ deploymentId }: { deploymentId: string | undefined }) {
	const scope = useAccountScope();
	return (
		<DeploymentDetail
			key={`${scope.accountKey}:${scope.generation}:${deploymentId}`}
			deploymentId={deploymentId}
		/>
	);
}

function DeploymentDetail({ deploymentId }: { deploymentId: string | undefined }) {
	const cache = useQueryClient();
	const [accepted, setAccepted] = useState<HostedDeployOperation | null>(null);
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
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName={webView(agentsIndexClasses.page)}>
				<BackButton />
				<PageHeader
					title={deployment?.resource.name ?? "Overview"}
					description="Status, resources, and recent activity for this agent."
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
						<NativeButton
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
								deployment={deployment}
								deploymentId={deploymentId}
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
								<AgentOverviewHeading>{agentSurfaceCopy.status}</AgentOverviewHeading>
								<OverviewNavigationCard
									title={agentSurfaceCopy.compute}
									description={t(
										deployment.resource.status
											? deploymentSummaryKeys[deployment.resource.status.summary_state]
											: "deployments.unknown",
									)}
									icon={Cpu}
									tint={RESOURCE_TINT_CLASSES.overview}
								>
									<OverviewComputeBody
										{...overviewComputeState(deployment).facts}
										resources={deployment.resource.spec.resources}
									/>
								</OverviewNavigationCard>
								<OverviewNavigationCard
									title="Chat on the web"
									description={
										deployment.resource.spec.runtime === "hermes"
											? "Hermes Dashboard"
											: "OpenClaw Control UI"
									}
									icon={Laptop}
									tint={RESOURCE_TINT_CLASSES.sessions}
								>
									<RuntimeBrowser deployment={deployment} />
								</OverviewNavigationCard>
								<NativeButton
									label={t("terminal.title")}
									onPress={() =>
										router.push({
											pathname: "/deployments/[deploymentId]/terminal",
											params: { deploymentId },
										})
									}
								/>
								<NativeButton
									label={t("workspaceSkills.title")}
									onPress={() =>
										router.push({
											pathname: "/deployments/[deploymentId]/skills",
											params: { deploymentId },
										})
									}
								/>
								<AppText className="text-xl font-semibold text-foreground">
									{deployment.resource.name}
								</AppText>
								<AppText>
									{deployment.resource.spec.runtime} · {deployment.current_plan_slug}
								</AppText>
								<AppText>
									{t(
										deployment.resource.status
											? deploymentSummaryKeys[deployment.resource.status.summary_state]
											: "deployments.unknown",
									)}
								</AppText>
								{deployment.resource.status?.conditions.map((condition) => (
									<AppText key={condition.type}>
										{condition.type}: {condition.status}
									</AppText>
								))}
								{deployment.resource.status?.failure ? (
									<AppText className="text-destructive">{t("deployments.failed")}</AppText>
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
								<AppText>{t("deployments.paused")}</AppText>
								<AppText>{t("deployments.noSessions")}</AppText>
								{deployment.agent_id ? (
									<NativeButton
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
					</>
				)}
			</AppScrollView>
		</ReadScreen>
	);
}
