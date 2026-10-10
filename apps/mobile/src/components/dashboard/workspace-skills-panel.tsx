import { resolveAgentWorkspaceProjectId } from "@clawdi/shared/api";
import { HERO_GRID_CLASS, workspaceSkillsPanelClasses as panel } from "@clawdi/shared/ui";
import {
	agentSurfaceCopy,
	fetchAgentProjectSkills,
	RESOURCE_TINT_CLASSES,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import Sparkles from "lucide-react-native/icons/sparkles";
import Trash2 from "lucide-react-native/icons/trash";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentCollection } from "@/components/dashboard/collection";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { EmptyState } from "@/components/empty-state";
import { HeroCardSkeleton } from "@/components/entity-card";
import { SkillCard } from "@/components/skills/skill-card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { WebView, webView } from "@/components/ui/web-layout";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { HostedAgentLibrarySkillsScreen } from "@/hosted/agents/library-skill-picker";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
export function AgentLibrarySkillsScreen() {
	const params = useLocalSearchParams<{ id?: string | string[] }>(),
		id = routeParam(params.id);
	const scope = useAccountScope();
	return <WorkspaceSkills key={`${scope.accountKey}:${scope.generation}:${id}`} id={id} />;
}
function WorkspaceSkills({ id }: { id?: string }) {
	const t = useI18n();
	const scope = useAccountScope(),
		read = useAccountRead(),
		api = useMobileApi(),
		agent = useCloudAgent(id);
	const bindings = useQuery({
		queryKey: accountQueryKey(scope, "agent-overview-bindings", id),
		enabled: scope.isReady && Boolean(id),
		retry: false,
		queryFn: ({ signal }) => read((s) => api.agentProjects.listBindings(id ?? "", s), signal),
	});
	const workspace = resolveAgentWorkspaceProjectId(
		bindings.data ?? [],
		agent.data?.default_project_id,
	);
	const skills = useQuery({
		queryKey: accountQueryKey(scope, "agent-overview-skills", workspace),
		enabled: scope.isReady && Boolean(workspace),
		retry: false,
		queryFn: ({ signal }) =>
			read(
				(s) =>
					fetchAgentProjectSkills(workspace ? [workspace] : [], (project_id, page, page_size) =>
						api.cloud.listSkills({ project_id, page, page_size }, s),
					),
				signal,
			),
	});
	// A hosted runtime retains its existing desired-state mutation surface.
	const hosted = useQuery({
		queryKey: accountQueryKey(scope, "deployments"),
		enabled: scope.isReady && Boolean(api.hosted),
		retry: false,
		queryFn: ({ signal }) =>
			read((s) => {
				if (!api.hosted) throw new Error("Hosted API unavailable");
				return api.hosted.listDeployments(s);
			}, signal),
	});
	const deployment = hosted.data?.find((item) => item.agent_id === id);
	if (id && deployment)
		return <HostedAgentLibrarySkillsScreen deploymentId={deployment.resource.id} />;
	const failed = !id || agent.error || bindings.error || skills.error;
	return (
		<AgentCollection
			data={
				failed || agent.isPending || bindings.isPending || skills.isLoading
					? []
					: (skills.data ?? [])
			}
			keyExtractor={(skill) => skill.id}
			refreshing={skills.isRefetching}
			onRefresh={() => {
				void agent.refetch();
				void bindings.refetch();
				void skills.refetch();
			}}
			renderItem={({ item: skill }) => (
				<SkillCard
					skill={skill}
					readOnly
					provenanceLabel={agentSurfaceCopy.syncedFromAgent}
					link={{
						to: {
							pathname: "/agents/[id]/skills/[...key]",
							params: {
								id: id ?? "",
								project: skill.project_id ?? "",
								key: skill.skill_key.split("/"),
							},
						},
					}}
					actions={
						<Button
							variant="ghost"
							size="icon-sm"
							className={webView(panel.removeAction)}
							accessibilityLabel={t("labels.uninstallSkill", { name: skill.name })}
							onPress={() =>
								router.push({
									pathname: "/agents/[id]/skills/uninstall",
									params: { id: id ?? "", key: skill.skill_key },
								})
							}
						>
							<Icon as={Trash2} className={webView(panel.actionIcon)} />
						</Button>
					}
				/>
			)}
			icon={Sparkles}
			iconTint={RESOURCE_TINT_CLASSES.skills}
			title={t("skills.title")}
			description={t("workspaceSkills.syncedDescription")}
			navigation={id ? <AgentSectionNavigation agentId={id} section="skills" /> : null}
		>
			<Alert title={agentSurfaceCopy.installOnTheAgent}>
				{agentSurfaceCopy.thisAgentManagesItsFilesLocallyRunTheCommand}
			</Alert>
			{failed ? (
				<ApiErrorPanel
					error={failed}
					title={agentSurfaceCopy.couldnTLoadSyncedSkills}
					onRetry={() => {
						void agent.refetch();
						void bindings.refetch();
						void skills.refetch();
					}}
				/>
			) : agent.isPending || bindings.isPending || skills.isLoading ? (
				<WebView recipe={HERO_GRID_CLASS}>
					{[0, 1, 2].map((i) => (
						<HeroCardSkeleton compact key={i} />
					))}
				</WebView>
			) : !skills.data?.length ? (
				<EmptyState
					variant="inset"
					description={agentSurfaceCopy.noSkillsHaveSyncedFromThisAgent}
				/>
			) : null}
		</AgentCollection>
	);
}
