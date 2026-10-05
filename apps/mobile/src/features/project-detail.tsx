import { HERO_GRID_CLASS, PROJECT_STAT_TILE_TINTS, projectDetailClasses } from "@clawdi/shared/ui";
import {
	displayProjectName,
	identityFor,
	OVERVIEW_COPY,
	PROJECT_LOCAL_TABS,
	projectDetailDescription,
	SHARING_COPY,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { ArrowRight, Bot, MoreHorizontal, Plus, Share2 } from "lucide-react-native";
import { useState } from "react";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { AgentIcon } from "../ui/agents/agent-icon";
import { ApiErrorPanel } from "../ui/api-error-panel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DetailBackLink, DetailPanel, LibraryPage } from "../ui/detail/layout";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { EmptyState } from "../ui/empty-state";
import { HeroCardSkeleton } from "../ui/entity-card";
import { Icon } from "../ui/icon";
import { IconChip } from "../ui/icon-chip";
import { PageHeader, PageHeaderSkeleton } from "../ui/page-header";
import { ManageProjectAgentsDialog } from "../ui/projects/manage-project-agents-dialog";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { Text } from "../ui/text";
import { AppPressable } from "../ui/view";
import { WebText, WebView, webBoth, webView } from "../ui/web-layout";
import { agentDisplayName, isNotFound, useCloudAgents } from "./cloud-inventory";
import { useProject } from "./project-scope";
import { canManageSharing } from "./project-sharing-state";
import { projectRouteFilter, routeParam } from "./read-helpers";
import { ResourceError } from "./resource-error";
import { SkillRow, useCloudSkills } from "./skills";
import { ProjectVaultCatalog } from "./vault/project-catalog";

export function ProjectDetailScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ projectId?: string | string[]; tab?: string | string[] }>();
	const filter = projectRouteFilter(params.projectId);
	const initialTab =
		PROJECT_LOCAL_TABS.find((item) => item.id === routeParam(params.tab))?.id ?? "overview";
	return (
		<ProjectHub
			key={`${scope.identity}:${scope.generation}:${filter.kind === "project" ? filter.id : ""}:${initialTab}`}
			initialTab={initialTab}
			id={filter.kind === "project" ? filter.id : undefined}
		/>
	);
}
function ProjectHub({ id, initialTab }: { id?: string; initialTab: string }) {
	const t = useI18n();
	const [tab, setTab] = useState(initialTab);
	const [agentsOpen, setAgentsOpen] = useState(false);
	const scope = useAccountScope();
	const read = useAccountRead();
	const { sharing } = useMobileApi();
	const query = useProject(id);
	const project = query.data?.id === id && !query.isError ? query.data : undefined;
	const skills = useCloudSkills(id, "", Boolean(id && tab === "skills"));
	const agents = useCloudAgents(id);
	const members = useQuery({
		queryKey: accountQueryKey(scope, "project-members", id),
		queryFn: ({ signal }) => read((s) => sharing.listMembers(id ?? "", s), signal),
		enabled: scope.isReady && Boolean(project?.is_owner && tab === "access"),
		retry: false,
	});
	const navigate = (next: string) => {
		if (PROJECT_LOCAL_TABS.some((item) => item.id === next)) setTab(next);
	};
	const stats = project
		? [
				{ label: "Skills", value: project.skill_count, tab: "skills" },
				{ label: "Vaults", value: project.vault_count, tab: "vaults" },
				{ label: "People", value: project.member_count + 1, tab: "access" },
				{ label: "Agents", value: project.agent_count, tab: "agents" },
			]
		: [];
	const identity = identityFor(project ? displayProjectName(project) : "");
	return (
		<LibraryPage>
			<DetailBackLink href="/projects" label={t("projects.title")} />
			{!id || query.isError || (query.isSuccess && !project) ? (
				<ResourceError
					missing={!id || isNotFound(query.error) || (!query.isError && !project)}
					onRetry={() => void query.refetch()}
				/>
			) : query.isPending ? (
				<PageHeaderSkeleton icon actions />
			) : null}
			{project ? (
				<>
					<PageHeader
						title={displayProjectName(project)}
						description={projectDetailDescription(project, project.is_owner)}
						icon={
							<IconChip
								tint={identity.colorClasses}
								className={webBoth(projectDetailClasses.emoji)}
							>
								{identity.emoji}
							</IconChip>
						}
						actions={
							<>
								<Button size="sm" onPress={() => setAgentsOpen(true)}>
									<Icon as={Bot} />
									<Text>{t("libraryPort.manageAgents")}</Text>
								</Button>
								{canManageSharing(project) ? (
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button variant="ghost" size="icon-sm" accessibilityLabel={project.name}>
													<Icon as={MoreHorizontal} />
												</Button>
											}
										/>
										<DropdownMenuContent>
											<DropdownMenuItem
												label={t("projects.sharing")}
												onSelect={() =>
													router.push({
														pathname: "/projects/[projectId]/sharing",
														params: { projectId: project.id },
													})
												}
											/>
										</DropdownMenuContent>
									</DropdownMenu>
								) : null}
							</>
						}
					/>
					<Tabs value={tab} onValueChange={navigate}>
						<TabsList variant="default" className={webView(projectDetailClasses.tabs)}>
							{PROJECT_LOCAL_TABS.map((item) => (
								<TabsTrigger
									key={item.id}
									value={item.id}
									className={webBoth(projectDetailClasses.tab)}
								>
									{item.label}
								</TabsTrigger>
							))}
						</TabsList>
					</Tabs>
					{tab === "overview" ? (
						<DetailPanel className={webView(projectDetailClasses.panel)}>
							<WebView recipe={projectDetailClasses.headingStack}>
								<WebText recipe={projectDetailClasses.heading}>
									{t("libraryPort.projectBundle")}
								</WebText>
								<WebText recipe={projectDetailClasses.description}>
									{project.description || t("libraryPort.projectBundleDescription")}
								</WebText>
							</WebView>
							<WebView recipe={projectDetailClasses.statGrid}>
								{[stats.slice(0, 2), stats.slice(2)].map((row, i) => (
									<WebView key={i} recipe={projectDetailClasses.statGrid} className="flex-row">
										{row.map((stat) => (
											<AppPressable
												key={stat.label}
												className={`${webView(projectDetailClasses.statTile)} ${webView(PROJECT_STAT_TILE_TINTS[stat.label] ?? "")} flex-1`}
												onPress={() => navigate(stat.tab)}
											>
												<WebText recipe={projectDetailClasses.statValue}>{stat.value}</WebText>
												<WebText recipe={projectDetailClasses.statLabel}>{stat.label}</WebText>
											</AppPressable>
										))}
									</WebView>
								))}
							</WebView>
						</DetailPanel>
					) : null}
					{tab === "skills" ? (
						<WebView recipe={projectDetailClasses.section}>
							<WebView recipe={projectDetailClasses.sectionHeader}>
								<WebView recipe={projectDetailClasses.sectionHeading}>
									<WebView recipe={projectDetailClasses.paginationActions}>
										<WebText recipe={projectDetailClasses.heading}>{t("skills.title")}</WebText>
										<Badge
											variant="secondary"
											className={webBoth(projectDetailClasses.resourceCount)}
										>
											<Text>{project.skill_count}</Text>
										</Badge>
									</WebView>
									<WebText recipe={projectDetailClasses.subtitle}>
										{t("libraryPort.projectSkillsDescription")}
									</WebText>
								</WebView>
								<WebView recipe={projectDetailClasses.paginationActions}>
									<Button
										variant="ghost"
										size="sm"
										textClassName={webBoth(projectDetailClasses.emptyCount)}
										onPress={() =>
											router.push({ pathname: "/skills", params: { projectId: project.id } })
										}
									>
										<Text>{OVERVIEW_COPY.viewAll}</Text>
										<Icon as={ArrowRight} />
									</Button>
									{project.is_owner && !project.archived_at ? (
										<Button
											variant="outline"
											size="sm"
											onPress={() =>
												router.push({ pathname: "/skills/new", params: { projectId: project.id } })
											}
										>
											<Icon as={Plus} />
											<Text>{t("libraryPort.addSkill")}</Text>
										</Button>
									) : null}
								</WebView>
							</WebView>
							{skills.error ? (
								<ApiErrorPanel error={skills.error} onRetry={() => void skills.refetch()} />
							) : (
								<WebView recipe={HERO_GRID_CLASS}>
									{skills.isPending ? (
										<HeroCardSkeleton compact />
									) : (
										skills.data?.pages
											.flatMap((page) => page.items)
											.map((skill) => (
												<SkillRow key={skill.skill_key} skill={skill} project={project} />
											))
									)}
								</WebView>
							)}
							{skills.isSuccess && !skills.data.pages.some((page) => page.items.length) ? (
								<EmptyState variant="inset" description={t("libraryPort.emptyProjectSkills")} />
							) : null}
							{skills.hasNextPage ? (
								<Button
									variant="outline"
									disabled={skills.isFetching}
									onPress={() => void skills.fetchNextPage()}
								>
									<Text>{t("inventory.loadMore")}</Text>
								</Button>
							) : null}
						</WebView>
					) : null}
					{tab === "vaults" ? <ProjectVaultCatalog project={project} /> : null}
					{tab === "access" ? (
						<WebView recipe={projectDetailClasses.section}>
							<WebText recipe={projectDetailClasses.heading}>
								{t("libraryPort.people")}{" "}
								<WebText recipe={projectDetailClasses.resourceCount}>
									{project.member_count + 1}
								</WebText>
							</WebText>
							<WebText recipe={projectDetailClasses.subtitle}>
								{t("libraryPort.peopleDescription")}
							</WebText>
							{canManageSharing(project) ? (
								<Button
									variant="outline"
									size="sm"
									className="self-start"
									onPress={() =>
										router.push({
											pathname: "/projects/[projectId]/sharing",
											params: { projectId: project.id },
										})
									}
								>
									<Icon as={Share2} />
									<Text>{SHARING_COPY.manage}</Text>
								</Button>
							) : null}
							{members.error ? (
								<ApiErrorPanel error={members.error} onRetry={() => void members.refetch()} />
							) : null}
							<WebView recipe={projectDetailClasses.rowList}>
								{members.data?.map((member) => (
									<WebView key={member.id} recipe={projectDetailClasses.row}>
										<WebText recipe={projectDetailClasses.rowName}>
											{member.user_email ?? member.user_display ?? member.user_id}
										</WebText>
										<Badge variant="secondary">
											<Text>{member.role}</Text>
										</Badge>
									</WebView>
								))}
							</WebView>
						</WebView>
					) : null}
					{tab === "agents" ? (
						<WebView recipe={projectDetailClasses.section}>
							<WebText recipe={projectDetailClasses.heading}>
								{t("libraryPort.yourAgents")}{" "}
								<WebText recipe={projectDetailClasses.resourceCount}>{project.agent_count}</WebText>
							</WebText>
							<WebText recipe={projectDetailClasses.subtitle}>
								{t("libraryPort.projectAgentsDescription")}
							</WebText>
							{agents.error ? (
								<ApiErrorPanel error={agents.error} onRetry={() => void agents.refetch()} />
							) : null}
							<WebView recipe={projectDetailClasses.rowList}>
								{agents.data?.map((agent) => (
									<AppPressable
										key={agent.id}
										className={webView(projectDetailClasses.agentRow)}
										onPress={() =>
											router.push({
												pathname: "/agents/[agentId]/projects",
												params: { agentId: agent.id },
											})
										}
									>
										<AgentIcon agent={agent.agent_type} avatarUrl={agent.avatar_url} size="sm" />
										<WebText
											recipe={`${projectDetailClasses.rowName} ${projectDetailClasses.agentIdentity}`}
										>
											{agentDisplayName(agent)}
										</WebText>
										{agent.default_project_id === project.id ? (
											<Badge variant="secondary">
												<Text>Workspace</Text>
											</Badge>
										) : null}
									</AppPressable>
								))}
							</WebView>
							{agents.isSuccess && !agents.data.length ? (
								<EmptyState variant="inset" description={t("libraryPort.emptyProjectAgents")} />
							) : null}
						</WebView>
					) : null}
				</>
			) : null}
			{project && agentsOpen ? (
				<ManageProjectAgentsDialog
					project={project}
					linkedAgents={agents.data}
					linkedError={agents.error}
					onRetryLinked={() => void agents.refetch()}
					open={agentsOpen}
					onOpenChange={setAgentsOpen}
				/>
			) : null}
		</LibraryPage>
	);
}
