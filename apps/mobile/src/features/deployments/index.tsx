import type { HostedDeployOperation } from "@clawdi/shared/api";
import { focusManager, onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useMobileApi } from "../../providers/api-provider";
import { NativeButton } from "../../ui/native-controls";
import { AppPressable, AppScrollView, AppText, AppView } from "../../ui/primitives";
import { ReadScreen } from "../../ui/read-screen";
import { BackButton, isNotFound } from "../cloud-inventory";
import { InventoryList } from "../inventory-list";
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
			<ReadScreen>
				<AppView className="gap-4 p-5">
					<BackButton />
					<AppText>{t("deployments.unavailable")}</AppText>
				</AppView>
			</ReadScreen>
		);
	const refresh = () => {
		if (!query.isFetching) void query.refetch();
	};
	return (
		<InventoryList
			items={(query.data ?? []).map((deployment) => ({ id: deployment.resource.id, deployment }))}
			title={t("deployments.title")}
			description={t("deployments.description")}
			empty={query.isPending ? t("loading.app") : t("deployments.empty")}
			refreshing={query.isRefetching}
			onRefresh={refresh}
			error={query.isError}
			onRetry={refresh}
			busy={query.isFetching}
			renderItem={({ deployment }) => (
				<AppPressable
					accessibilityRole="button"
					className="gap-2 rounded-2xl bg-surface p-4"
					onPress={() => {
						if (scope.isCurrent() && !scope.signal.aborted)
							router.push(`/deployments/${encodeURIComponent(deployment.resource.id)}`);
					}}
				>
					<AppText className="text-lg font-semibold text-foreground">
						{deployment.resource.name}
					</AppText>
					<AppText>
						{deployment.resource.spec.runtime} ·{" "}
						{t(
							deployment.resource.status
								? deploymentSummaryKeys[deployment.resource.status.summary_state]
								: "deployments.unknown",
						)}
					</AppText>
				</AppPressable>
			)}
		/>
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
			<AppScrollView contentContainerClassName="gap-4 p-5">
				<BackButton />
				<AppText className="text-2xl font-semibold text-foreground">
					{t("deployments.detail")}
				</AppText>
				{!hosted ? (
					<AppText>{t("deployments.unavailable")}</AppText>
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
							<AppView className="gap-3 rounded-2xl bg-surface p-4">
								<RuntimeBrowser deployment={deployment} />
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
									<AppText className="text-danger">{t("deployments.failed")}</AppText>
								) : null}
								{operation.data ? (
									<AppText>
										{t("deployments.operation")}:{" "}
										{operation.data.done ? t("deployments.complete") : t("deployments.progress")}
									</AppText>
								) : null}
								{operation.data?.error ? (
									<AppText className="text-danger">
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
							</AppView>
						) : null}
					</>
				)}
			</AppScrollView>
		</ReadScreen>
	);
}
