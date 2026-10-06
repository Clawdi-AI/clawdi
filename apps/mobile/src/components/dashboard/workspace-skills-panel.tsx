import { resolveAgentWorkspaceProjectId } from "@clawdi/shared/api";
import { HERO_GRID_CLASS, workspaceSkillsPanelClasses as panel } from "@clawdi/shared/ui";
import {
	agentSurfaceCopy,
	fetchAgentProjectSkills,
	RESOURCE_TINT_CLASSES,
	workspaceSkillInstallCommand,
	workspaceSkillRemoveCommand,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { Plus, Sparkles, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentCollection } from "@/components/dashboard/collection";
import { ActionButton } from "@/components/dashboard/controls";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { EmptyState } from "@/components/empty-state";
import { HeroCardSkeleton } from "@/components/entity-card";
import { SkillCard } from "@/components/skills/skill-card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { WorkspaceSkillsScreen } from "@/hosted/agents/hosted-workspace-skills-panel";
import { HostedAgentLibrarySkillsScreen } from "@/hosted/agents/library-skill-picker";
import { useMobileApi } from "@/lib/api-provider";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
export function AgentLibrarySkillsScreen() {
	const params = useLocalSearchParams<{ id?: string | string[]; tab?: string }>(),
		id = routeParam(params.id);
	const scope = useAccountScope();
	return (
		<WorkspaceSkills
			key={`${scope.accountKey}:${scope.generation}:${id}`}
			id={id}
			workspaceTab={params.tab === "workspace"}
		/>
	);
}
function WorkspaceSkills({ id, workspaceTab }: { id?: string; workspaceTab?: boolean }) {
	const scope = useAccountScope(),
		read = useAccountRead(),
		api = useMobileApi(),
		agent = useCloudAgent(id);
	const [installOpen, setInstallOpen] = useState(false),
		[repo, setRepo] = useState(""),
		[removeCommand, setRemoveCommand] = useState<string | null>(null);
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
		return workspaceTab ? (
			<WorkspaceSkillsScreen deploymentId={deployment.resource.id} />
		) : (
			<HostedAgentLibrarySkillsScreen />
		);
	const failed = !id || agent.error || bindings.error || skills.error;
	return (
		<AgentCollection
			icon={Sparkles}
			iconTint={RESOURCE_TINT_CLASSES.skills}
			title="Skills"
			description="Skills available in this Agent's Workspace. Skills synced from the Agent are read-only."
			navigation={id ? <AgentSectionNavigation agentId={id} section="skills" /> : null}
			actions={
				<ActionButton
					label={agentSurfaceCopy.installSkill}
					icon={<Icon as={Plus} />}
					variant="default"
					onPress={() => setInstallOpen(true)}
				/>
			}
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
			) : (
				<WebView recipe={HERO_GRID_CLASS}>
					{skills.data.map((skill) => (
						<SkillCard
							key={skill.id}
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
									accessibilityLabel={`Uninstall ${skill.name} from Agent`}
									onPress={() =>
										setRemoveCommand(
											workspaceSkillRemoveCommand(skill.skill_key, agent.data?.agent_type ?? ""),
										)
									}
								>
									<Icon as={Trash2} className={webView(panel.actionIcon)} />
								</Button>
							}
						/>
					))}
				</WebView>
			)}
			<Dialog
				open={installOpen}
				onOpenChange={(open) => {
					setInstallOpen(open);
					if (!open) setRepo("");
				}}
			>
				<DialogContent className={webView(panel.dialog)}>
					<DialogHeader>
						<DialogTitle>{agentSurfaceCopy.installSkill}</DialogTitle>
						<DialogDescription>
							Enter a GitHub Skill path, then run the generated command on the Agent machine.
						</DialogDescription>
					</DialogHeader>
					<WebView recipe={panel.form}>
						<WebView recipe={panel.field}>
							<Label>{agentSurfaceCopy.gitHubSkillRepository}</Label>
							<Input
								value={repo}
								onChangeText={setRepo}
								placeholder={agentSurfaceCopy.ownerRepoOrOwnerRepoPathTo}
								autoCapitalize="none"
								autoCorrect={false}
							/>
						</WebView>
						{repo.trim() ? (
							<WebView recipe={panel.commandRow} className="flex-row">
								<WebText selectable recipe={panel.command}>
									{workspaceSkillInstallCommand(repo, agent.data?.agent_type ?? "")}
								</WebText>
							</WebView>
						) : null}
					</WebView>
					<DialogFooter>
						<ActionButton variant="ghost" label="Done" onPress={() => setInstallOpen(false)} />
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<Dialog
				open={Boolean(removeCommand)}
				onOpenChange={(open) => {
					if (!open) setRemoveCommand(null);
				}}
			>
				<DialogContent className={webView(panel.dialog)}>
					<DialogHeader>
						<DialogTitle>{agentSurfaceCopy.uninstallSkill}</DialogTitle>
						<DialogDescription>
							{agentSurfaceCopy.runThisCommandOnTheAgentMachineTheSkill}
						</DialogDescription>
					</DialogHeader>
					<WebView recipe={panel.commandRow} className="flex-row">
						<WebText selectable recipe={panel.command}>
							{removeCommand}
						</WebText>
					</WebView>
					<DialogFooter>
						<ActionButton variant="ghost" label="Done" onPress={() => setRemoveCommand(null)} />
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</AgentCollection>
	);
}
