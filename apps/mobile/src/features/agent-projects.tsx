import {
	type AgentProjectBinding,
	agentProjectBindingsQueryKey,
	buildContextBindingReorder,
	resolveAgentProjectScope,
} from "@clawdi/shared/api";
import {
	agentSurfaceCopy,
	compareProjectsForUse,
	displayProjectName,
	formatResourceCount,
	identityFor,
	isCustomProject,
	projectMatchesSearch,
	projectSearchRank,
	projectSupportingText,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { FolderKanban, Plus } from "lucide-react-native";
import { useState } from "react";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { AgentCollection } from "../ui/agents/collection";
import { useAgentConfirmation } from "../ui/agents/confirmation";
import { ActionButton } from "../ui/agents/controls";
import { AgentSectionNavigation } from "../ui/agents/navigation";
import { ApiErrorPanel } from "../ui/api-error-panel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { HERO_GRID_CLASS, HeroCard, HeroCardSkeleton } from "../ui/entity-card";
import { Icon } from "../ui/icon";
import { IconChip } from "../ui/icon-chip";
import { ListToolbar } from "../ui/list-toolbar";
import { SearchInput } from "../ui/search-input";
import { SectionLabel } from "../ui/section-label";
import { Text } from "../ui/text";
import { WebView } from "../ui/web-layout";
import { useCloudAgent } from "./cloud-inventory";
import { useCloudProjects } from "./projects";
import { routeParam } from "./read-helpers";

export function AgentProjectsScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ agentId?: string | string[] }>();
	const agentId = routeParam(params.agentId);
	return (
		<BindingsView key={`${scope.identity}:${scope.generation}:${agentId}`} agentId={agentId} />
	);
}

function BindingsView({ agentId }: { agentId?: string }) {
	const t = useI18n();
	const confirmationDialog = useAgentConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { agentProjects } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const projects = useCloudProjects();
	const agent = useCloudAgent(agentId);
	const [search, setSearch] = useState("");
	const bindings = useQuery({
		queryKey: accountQueryKey(scope, ...agentProjectBindingsQueryKey(agentId)),
		queryFn: ({ signal }) =>
			read((requestSignal) => agentProjects.listBindings(agentId ?? "", requestSignal), signal),
		enabled: scope.isReady && Boolean(agentId),
		retry: false,
	});
	let ordered: AgentProjectBinding[] = [];
	let invalidScope = false;
	if (bindings.data && agent.data) {
		try {
			ordered = resolveAgentProjectScope(bindings.data, agent.data.default_project_id).bindings;
		} catch {
			invalidScope = true;
		}
	}
	const failed = !agentId || bindings.isError || agent.isError || projects.isError || invalidScope;
	const loading = Boolean(agentId) && (bindings.isPending || projects.isPending || agent.isPending);
	const busy = bindings.isFetching || projects.isFetching || agent.isFetching;
	const disabled = failed || loading || action.busy || busy;
	const context = ordered.filter((binding) => binding.binding_type === "context");
	const refresh = async () => {
		await Promise.all([bindings.refetch(), projects.refetch(), agent.refetch()]);
	};
	const mutate = (operation: (id: string, signal: AbortSignal) => Promise<unknown>) =>
		action.run(async (isCurrent) => {
			if (!agentId || disabled) return;
			await read((signal) => operation(agentId, signal));
			if (isCurrent()) await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
		});
	const unlink = (binding: AgentProjectBinding) => {
		const signal = scope.signal;
		confirmationDialog.request({
			title: t("bindings.unlink"),
			description: t("bindings.unlinkWarning"),
			confirmLabel: t("bindings.unlink"),
			onConfirm: () => {
				if (signal.aborted || !scope.isCurrent() || binding.binding_type !== "context") return;
				void mutate((id, requestSignal) => agentProjects.unlink(id, binding.id, requestSignal));
			},
		});
	};
	const rows = (projects.data ?? [])
		.filter(isCustomProject)
		.filter(
			(project) =>
				!project.archived_at || context.some((binding) => binding.project_id === project.id),
		)
		.filter((project) => projectMatchesSearch(project, search))
		.sort(
			(a, b) =>
				(projectSearchRank(a, search) ?? 0) - (projectSearchRank(b, search) ?? 0) ||
				compareProjectsForUse(a, b),
		);
	return (
		<AgentCollection
			icon={FolderKanban}
			navigation={agentId ? <AgentSectionNavigation agentId={agentId} section="projects" /> : null}
			title="Projects"
			description="Choose the Projects this Agent can use."
			actions={
				<ActionButton
					label="Create project"
					variant="default"
					icon={<Icon as={Plus} />}
					onPress={() => router.push("/projects")}
				/>
			}
		>
			<ListToolbar
				search={<SearchInput value={search} onChange={setSearch} placeholder="Search projects…" />}
			/>
			{failed ? (
				<ApiErrorPanel
					error={bindings.error ?? agent.error ?? projects.error}
					title="Couldn't load Projects"
					onRetry={() => void refresh()}
				/>
			) : loading ? (
				<WebView recipe={HERO_GRID_CLASS}>
					{[0, 1, 2].map((i) => (
						<HeroCardSkeleton key={i} />
					))}
				</WebView>
			) : (
				[true, false].map((linked) => {
					const group = rows.filter(
						(project) => context.some((binding) => binding.project_id === project.id) === linked,
					);
					if (!group.length) return null;
					return (
						<WebView key={String(linked)} recipe={HERO_GRID_CLASS}>
							<SectionLabel count={group.length}>
								{linked ? "Linked" : agentSurfaceCopy.available}
							</SectionLabel>
							{group.map((project) => {
								const name = displayProjectName(project),
									identity = identityFor(name),
									binding = context.find((item) => item.project_id === project.id);
								return (
									<HeroCard
										key={project.id}
										icon={
											<IconChip tint={identity.colorClasses}>
												<Text>{identity.emoji}</Text>
											</IconChip>
										}
										title={name}
										link={{
											to: { pathname: "/projects/[projectId]", params: { projectId: project.id } },
										}}
										description={projectSupportingText(project)}
										badges={
											!project.is_owner ? (
												<Badge variant="outline">
													<Text>Viewer</Text>
												</Badge>
											) : undefined
										}
										footer={[
											formatResourceCount(project.skill_count, "skill"),
											formatResourceCount(project.vault_count, "vault"),
										]}
										actionsVisibility="always"
										actions={
											<>
												<ActionButton
													label={linked ? "Unlink" : "Link"}
													variant={linked ? "ghost" : "default"}
													disabled={disabled || (!linked && project.kind !== "workspace")}
													onPress={() => {
														if (binding) unlink(binding);
														else
															void mutate((id, signal) =>
																agentProjects.link(id, project.id, signal),
															);
													}}
												/>
												{binding ? (
													<DropdownMenu>
														<DropdownMenuTrigger>
															<Button
																variant="ghost"
																size="icon-sm"
																accessibilityLabel="Project actions"
															>
																<Text>⋯</Text>
															</Button>
														</DropdownMenuTrigger>
														<DropdownMenuContent>
															<DropdownMenuItem
																label="Move up"
																disabled={disabled || context[0]?.id === binding.id}
																onSelect={() =>
																	void mutate((id, signal) =>
																		agentProjects.reorder(
																			id,
																			buildContextBindingReorder(ordered, binding.id, -1),
																			signal,
																		),
																	)
																}
															/>
															<DropdownMenuItem
																label="Move down"
																disabled={
																	disabled || context[context.length - 1]?.id === binding.id
																}
																onSelect={() =>
																	void mutate((id, signal) =>
																		agentProjects.reorder(
																			id,
																			buildContextBindingReorder(ordered, binding.id, 1),
																			signal,
																		),
																	)
																}
															/>
														</DropdownMenuContent>
													</DropdownMenu>
												) : null}
											</>
										}
									/>
								);
							})}
						</WebView>
					);
				})
			)}
			{action.error ? (
				<ApiErrorPanel error={action.error} title="Couldn't update Project link" />
			) : null}
			{confirmationDialog.dialog}
		</AgentCollection>
	);
}
