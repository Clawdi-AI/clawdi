import type { Project } from "@clawdi/shared/api";
import { projectDetailClasses } from "@clawdi/shared/ui";
import { agentIdentity, compareAgentEnvironments } from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Save } from "lucide-react-native";
import { useEffect, useState } from "react";
import { useAuthAction } from "../../auth/use-auth-action";
import { type CloudAgent, useCloudAgents } from "../../features/cloud-inventory";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { Alert } from "../alert";
import { ApiErrorPanel } from "../api-error-panel";
import { Button } from "../button";
import { Checkbox } from "../checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../dialog";
import { EntityHeader } from "../entity-card";
import { Icon } from "../icon";
import { IconChip } from "../icon-chip";
import { Skeleton } from "../skeleton";
import { Text } from "../text";
import { AppScrollView } from "../view";
import { WebView, webView } from "../web-layout";

export function ManageProjectAgentsDialog({
	project,
	linkedAgents,
	linkedError,
	onRetryLinked,
	open,
	onOpenChange,
}: {
	project: Project;
	linkedAgents: CloudAgent[] | undefined;
	linkedError?: unknown;
	onRetryLinked: () => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useI18n();
	const allAgents = useCloudAgents();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { agentProjects } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	useEffect(() => {
		setSelected(new Set(open ? linkedAgents?.map((agent) => agent.id) : []));
	}, [open, linkedAgents]);
	const ordered = [...(allAgents.data ?? [])].sort(compareAgentEnvironments);
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
			if (current() && foreground()) onOpenChange(false);
		});
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!action.busy) {
					action.clearError();
					onOpenChange(value);
				}
			}}
		>
			<DialogContent className={webView(projectDetailClasses.agentsDialog)}>
				<DialogHeader>
					<DialogTitle>{t("libraryPort.manageAgents")}</DialogTitle>
					<DialogDescription>{t("libraryPort.chooseAgents")}</DialogDescription>
				</DialogHeader>
				{linkedError ? (
					<ApiErrorPanel error={linkedError} onRetry={onRetryLinked} />
				) : allAgents.isPending || !linkedAgents ? (
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
				) : (
					<WebView recipe={projectDetailClasses.form}>
						<AppScrollView className={webView(projectDetailClasses.agentChoices)}>
							{ordered.map((agent) => {
								const identity = agentIdentity(agent);
								return (
									<WebView key={agent.id} recipe={projectDetailClasses.agentChoice}>
										<Checkbox
											checked={selected.has(agent.id)}
											disabled={disabled}
											accessibilityLabel={`${identity.primaryLabel} access`}
											onCheckedChange={(checked) =>
												setSelected((current) => {
													const next = new Set(current);
													if (checked) next.add(agent.id);
													else next.delete(agent.id);
													return next;
												})
											}
										/>
										<EntityHeader
											icon={
												<IconChip>
													<Icon as={Bot} />
												</IconChip>
											}
											title={identity.primaryLabel}
											meta={identity.secondaryLabel}
											className={webView(projectDetailClasses.agentIdentity)}
										/>
									</WebView>
								);
							})}
						</AppScrollView>
						{action.error ? (
							<Alert variant="destructive">{t("libraryPort.updateAgentsFailed")}</Alert>
						) : null}
						<DialogFooter>
							<Button variant="ghost" disabled={action.busy} onPress={() => onOpenChange(false)}>
								<Text>{t("libraryPort.cancel")}</Text>
							</Button>
							<Button disabled={disabled || (!add.length && !remove.length)} onPress={save}>
								<Icon as={Save} />
								<Text>{t("libraryPort.save")}</Text>
							</Button>
						</DialogFooter>
					</WebView>
				)}
			</DialogContent>
		</Dialog>
	);
}
