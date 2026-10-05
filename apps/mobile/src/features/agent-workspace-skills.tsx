import { resolveAgentWorkspaceProjectId } from "@clawdi/shared/api";
import {
	HERO_GRID_CLASS,
	workspaceSkillsPanelClasses as panel,
	agentSkillCardClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentSurfaceCopy,
	fetchAgentProjectSkills,
	identityFor,
	relativeTime,
	workspaceSkillInstallCommand,
	workspaceSkillRemoveCommand,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { Plus, Sparkles } from "lucide-react-native";
import { useState } from "react";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { AgentCollection } from "../ui/agents/collection";
import { ActionButton } from "../ui/agents/controls";
import { AgentSectionNavigation } from "../ui/agents/navigation";
import { Alert } from "../ui/alert";
import { ApiErrorPanel } from "../ui/api-error-panel";
import { Badge } from "../ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { EmptyState } from "../ui/empty-state";
import { HeroCard, HeroCardSkeleton } from "../ui/entity-card";
import { Icon } from "../ui/icon";
import { IconChip } from "../ui/icon-chip";
import { Input, Label } from "../ui/input";
import { Text } from "../ui/text";
import { WebText, WebView, webView } from "../ui/web-layout";
import { HostedAgentLibrarySkillsScreen } from "./agent-library-skills";
import { useCloudAgent } from "./cloud-inventory";
import { routeParam } from "./read-helpers";
export function AgentLibrarySkillsScreen() {
	const params = useLocalSearchParams<{ agentId?: string | string[] }>(),
		id = routeParam(params.agentId);
	const scope = useAccountScope();
	return <WorkspaceSkills key={`${scope.accountKey}:${scope.generation}:${id}`} id={id} />;
}
function WorkspaceSkills({ id }: { id?: string }) {
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
	if (id && hosted.data?.some((deployment) => deployment.agent_id === id))
		return <HostedAgentLibrarySkillsScreen />;
	const failed = !id || agent.error || bindings.error || skills.error;
	return (
		<AgentCollection
			icon={Sparkles}
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
					{skills.data.map((skill) => {
						const identity = identityFor(skill.name || skill.skill_key);
						return (
							<HeroCard
								key={skill.id}
								className={webView(styles.card)}
								icon={
									<IconChip size="sm" tint={identity.colorClasses} className={webView(styles.icon)}>
										<Text>{identity.emoji}</Text>
									</IconChip>
								}
								title={skill.name}
								description={skill.description}
								badges={
									<>
										<Badge variant="outline">
											<Text>v{skill.version}</Text>
										</Badge>
										<Badge variant="secondary">
											<Text>{agentSurfaceCopy.readOnly}</Text>
										</Badge>
									</>
								}
								footer={[
									agentSurfaceCopy.syncedFromAgent,
									skill.source_repo,
									skill.updated_at ? relativeTime(skill.updated_at) : null,
								]}
								link={{
									to: {
										pathname: "/skills/detail",
										params: { projectId: skill.project_id ?? "", skillKey: skill.skill_key },
									},
								}}
								actions={
									<ActionButton
										label="Uninstall"
										variant="ghost"
										onPress={() =>
											setRemoveCommand(
												workspaceSkillRemoveCommand(skill.skill_key, agent.data?.agent_type ?? ""),
											)
										}
									/>
								}
							/>
						);
					})}
				</WebView>
			)}
			<Dialog open={installOpen} onOpenChange={setInstallOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{agentSurfaceCopy.installSkill}</DialogTitle>
						<DialogDescription>
							Run this command on the Agent machine. Skills appear here after the next sync.
						</DialogDescription>
					</DialogHeader>
					<Label>{agentSurfaceCopy.gitHubSkillRepository}</Label>
					<Input
						value={repo}
						onChangeText={setRepo}
						placeholder={agentSurfaceCopy.ownerRepoOrOwnerRepoPathTo}
						autoCapitalize="none"
					/>
					{repo.trim() ? (
						<WebText selectable recipe={panel.minWFlexOverflow}>
							{workspaceSkillInstallCommand(repo, agent.data?.agent_type ?? "")}
						</WebText>
					) : null}
					<ActionButton label="Done" onPress={() => setInstallOpen(false)} />
				</DialogContent>
			</Dialog>
			<Dialog
				open={Boolean(removeCommand)}
				onOpenChange={(open) => {
					if (!open) setRemoveCommand(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{agentSurfaceCopy.uninstallSkill}</DialogTitle>
						<DialogDescription>
							{agentSurfaceCopy.runThisCommandOnTheAgentMachineTheSkill}
						</DialogDescription>
					</DialogHeader>
					<WebText selectable recipe={panel.minWFlexOverflow}>
						{removeCommand}
					</WebText>
					<ActionButton label="Done" onPress={() => setRemoveCommand(null)} />
				</DialogContent>
			</Dialog>
		</AgentCollection>
	);
}
