import type { Project } from "@clawdi/shared/api";
import { agentOwnershipKindFromId } from "@clawdi/shared/client";
import { agentLabelClasses, projectDetailClasses } from "@clawdi/shared/ui";
import {
	agentIdentity,
	compareAgentEnvironments,
	projectAgentSyncLabel,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { Bot, Save } from "lucide-react-native";
import { Fragment, useEffect, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { AgentSourceBadge } from "@/components/dashboard/agent-section-source-badge";
import { useProject } from "@/components/projects/project-scope";
import { ResourceError } from "@/components/resource-error";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { Separator } from "@/components/ui/separator";
import { SheetPage } from "@/components/ui/sheet-page";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { AppPressable } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { type CloudAgent, useCloudAgents } from "@/hooks/cloud-inventory";
import { useAgentOwnership } from "@/hooks/use-agent-ownership";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useSheet } from "@/platform/navigation/use-sheet";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function ManageProjectAgentsScreen() {
	const t = useI18n();
	const params = useLocalSearchParams<{ id?: string }>();
	const id = routeParam(params.id);
	const query = useProject(id);
	const agents = useCloudAgents(id);
	if (!query.data || query.isError)
		return (
			<SheetPage title={t("libraryPort.manageAgents")} fallback="/projects">
				<ResourceError missing={!query.isError} onRetry={() => void query.refetch()} />
			</SheetPage>
		);
	return (
		<ManageProjectAgents
			key={query.data.id}
			project={query.data}
			linkedAgents={agents.data}
			linkedError={agents.error}
			onRetryLinked={() => void agents.refetch()}
		/>
	);
}
function ManageProjectAgents({
	project,
	linkedAgents,
	linkedError,
	onRetryLinked,
}: {
	project: Project;
	linkedAgents: CloudAgent[] | undefined;
	linkedError?: unknown;
	onRetryLinked: () => void;
}) {
	const t = useI18n();
	const allAgents = useCloudAgents();
	const ownership = useAgentOwnership();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { agentProjects } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const sheet = useSheet<boolean>({ fallback: "/projects", busy: action.busy });
	const [closeError, setCloseError] = useState<unknown>();
	const [selected, setSelected] = useState<Set<string>>(new Set());
	useEffect(() => {
		setSelected(new Set(linkedAgents?.map((agent) => agent.id)));
	}, [linkedAgents]);
	const ordered = (allAgents.data ?? [])
		.filter((agent) => {
			const kind = agentOwnershipKindFromId(agent.id, ownership.data ?? null);
			return kind === "cloud" || kind === "connected";
		})
		.sort(compareAgentEnvironments);
	const linked = new Set(linkedAgents?.map((agent) => agent.id));
	const add = ordered
		.filter((agent) => selected.has(agent.id) && !linked.has(agent.id))
		.map((agent) => agent.id);
	const remove = ordered
		.filter((agent) => linked.has(agent.id) && !selected.has(agent.id))
		.map((agent) => agent.id);
	const disabled =
		action.busy ||
		allAgents.isFetching ||
		ownership.isFetching ||
		ownership.isPending ||
		ownership.isError ||
		!linkedAgents ||
		Boolean(project.archived_at) ||
		allAgents.isError ||
		Boolean(linkedError);
	const save = () => {
		const foreground = capture();
		void action.run(async (current) => {
			if (disabled || (!add.length && !remove.length) || !foreground() || !scope.isCurrent())
				return;
			await read((signal) =>
				agentProjects.updateProjectAgents(
					project.id,
					{ add_agent_ids: add, remove_agent_ids: remove },
					signal,
				),
			);
			if (!current() || !foreground()) return;
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
			if (current() && foreground()) await sheet.close(true);
		});
	};
	return (
		<SheetPage
			title={t("libraryPort.manageAgents")}
			fallback="/projects"
			busy={action.busy}
			sheet={sheet}
			scroll={false}
		>
			<NativeList
				data={
					linkedError ||
					ownership.isError ||
					allAgents.isPending ||
					ownership.isPending ||
					!linkedAgents ||
					allAgents.isError
						? []
						: ordered
				}
				keyExtractor={(agent) => agent.id}
				refreshing={allAgents.isRefetching || ownership.isRefetching}
				onRefresh={() => {
					void allAgents.refetch();
					void ownership.refetch();
					onRetryLinked?.();
				}}
				header={
					<>
						<WebText recipe={projectDetailClasses.description}>
							{t("libraryPort.chooseAgents")}
						</WebText>
						{linkedError ? (
							<ApiErrorPanel error={linkedError} onRetry={onRetryLinked} />
						) : ownership.isError ? (
							<ApiErrorPanel error={ownership.error} onRetry={() => void ownership.refetch()} />
						) : allAgents.isPending || ownership.isPending || !linkedAgents ? (
							<Skeleton className={webView(projectDetailClasses.textarea)} />
						) : allAgents.error ? (
							<ApiErrorPanel
								error={allAgents.error}
								onRetry={() => void allAgents.refetch()}
								title={t("libraryPort.loadAgentsFailed")}
							/>
						) : !ordered.length ? (
							<Alert icon={Bot} title={t("libraryPort.noAgentsAvailable")}>
								{t("libraryPort.addAgentFirst")}
							</Alert>
						) : null}
					</>
				}
				renderItem={({ item: agent, index }) => {
					const identity = agentIdentity(agent);
					const toggle = (checked: boolean) =>
						setSelected((current) => {
							const next = new Set(current);
							if (checked) next.add(agent.id);
							else next.delete(agent.id);
							return next;
						});
					return (
						<Fragment key={agent.id}>
							<WebView recipe={projectDetailClasses.agentChoice}>
								<Checkbox
									checked={selected.has(agent.id)}
									disabled={disabled}
									accessibilityLabel={`${identity.primaryLabel} access`}
									onCheckedChange={toggle}
								/>
								{/* Web's <label>: the identity toggles the checkbox; its text stays readable. */}
								<AppPressable
									accessible={false}
									disabled={disabled}
									onPress={() => toggle(!selected.has(agent.id))}
									className={webView(
										`${agentLabelClasses.root} ${projectDetailClasses.agentIdentity}`,
									)}
								>
									<AgentIcon agent={agent.agent_type} avatarUrl={agent.avatar_url} size="sm" />
									<WebView recipe={agentLabelClasses.copy}>
										<WebView recipe={agentLabelClasses.heading}>
											<WebText
												recipe={`${agentLabelClasses.name} ${agentLabelClasses.nameBySize.sm}`}
												numberOfLines={1}
											>
												{identity.primaryLabel}
											</WebText>
											<WebView recipe={agentLabelClasses.adornment}>
												<AgentSourceBadge
													agentId={agent.id}
													ownership={ownership.isError ? null : (ownership.data ?? null)}
													showConnected={false}
												/>
											</WebView>
										</WebView>
										<WebView
											recipe={`${agentLabelClasses.subtitle} ${agentLabelClasses.subtitleGapBySize.sm}`}
										>
											{identity.secondaryLabel ? (
												<WebText recipe={agentLabelClasses.subtitleSegment}>
													{identity.secondaryLabel}
												</WebText>
											) : null}
											<WebText recipe={agentLabelClasses.subtitleSegment}>
												{projectAgentSyncLabel(agent.last_sync_at)}
											</WebText>
										</WebView>
									</WebView>
								</AppPressable>
							</WebView>
							{index < ordered.length - 1 ? <Separator /> : null}
						</Fragment>
					);
				}}
				footer={
					<WebView recipe={projectDetailClasses.form}>
						{closeError ? <ApiErrorPanel error={closeError} /> : null}
						{action.error ? (
							<Alert variant="destructive">{t("libraryPort.updateAgentsFailed")}</Alert>
						) : null}
						<WebView recipe={projectDetailClasses.form}>
							<Button
								variant="ghost"
								disabled={action.busy}
								onPress={() => void sheet.close().catch(setCloseError)}
							>
								<Text>{t("libraryPort.cancel")}</Text>
							</Button>
							<Button disabled={disabled || (!add.length && !remove.length)} onPress={save}>
								<Icon as={Save} />
								<Text>{t("libraryPort.save")}</Text>
							</Button>
						</WebView>
					</WebView>
				}
			/>
		</SheetPage>
	);
}
