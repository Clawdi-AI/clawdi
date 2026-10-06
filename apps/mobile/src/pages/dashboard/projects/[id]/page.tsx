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
import { ArrowRight, Plus, Share2 } from "lucide-react-native";
import { type ReactElement, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { DetailPanel } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { HeroCardSkeleton } from "@/components/entity-card";
import { HeaderActionGroup } from "@/components/header-action-group";
import { IconChip } from "@/components/icon-chip";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { useProject } from "@/components/projects/project-scope";
import { ResourceError } from "@/components/resource-error";
import { canManageSharing } from "@/components/sharing/project-sharing-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { Text } from "@/components/ui/text";
import { AppPressable } from "@/components/ui/view";
import { WebText, WebView, webBoth, webView } from "@/components/ui/web-layout";
import { ProjectVaultCatalog } from "@/components/vault/project-vault-catalog";
import { agentDisplayName, isNotFound, useCloudAgents } from "@/hooks/cloud-inventory";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { projectRouteFilter, routeParam } from "@/lib/route-params";
import { SkillRow, useCloudSkills } from "@/pages/dashboard/skills/page";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { NativeSegments } from "@/platform/navigation/segmented-control";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

export function ProjectDetailScreen({ initialTab: requestedTab }: { initialTab?: string } = {}) {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{
		id?: string | string[];
		projectId?: string | string[];
		tab?: string | string[];
	}>();
	const filter = projectRouteFilter(params.projectId ?? params.id);
	const initialTab =
		PROJECT_LOCAL_TABS.find((item) => item.id === (requestedTab ?? routeParam(params.tab)))?.id ??
		"overview";
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

	const cells: ReactElement[] = project
		? tab === "skills"
			? (skills.data?.pages
					.flatMap((page) => page.items)
					.map((skill) => <SkillRow key={skill.skill_key} skill={skill} project={project} />) ?? [])
			: tab === "access"
				? (members.data?.map((member) => (
						<WebView key={member.id} recipe={projectDetailClasses.row}>
							<WebText recipe={projectDetailClasses.rowName}>
								{member.user_email ?? member.user_display ?? member.user_id}
							</WebText>
							<Badge variant="secondary">
								<Text>{member.role}</Text>
							</Badge>
						</WebView>
					)) ?? [])
				: tab === "agents"
					? (agents.data?.map((agent) => (
							<AppPressable
								key={agent.id}
								className={webView(projectDetailClasses.agentRow)}
								onPress={() =>
									router.push({
										pathname: "/agents/[id]/[section]",
										params: { section: "project-access", id: agent.id },
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
						)) ?? [])
					: []
		: [];
	const header = (
		<>
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
						headerMenu={{
							label: displayProjectName(project),
							items: [
								{
									id: "agents",
									label: t("libraryPort.manageAgents"),
									onPress: () =>
										router.push({ pathname: "/projects/[id]/agents", params: { id: project.id } }),
								},
								...(canManageSharing(project)
									? [
											{
												id: "sharing",
												label: t("projects.sharing"),
												onPress: () =>
													router.push({
														pathname: "/projects/[id]/sharing",
														params: { id: project.id },
													}),
											},
										]
									: []),
							],
						}}
					/>
					<NativeSegments
						value={tab}
						onChange={navigate}
						options={PROJECT_LOCAL_TABS.map((item) => ({ value: item.id, label: item.label }))}
					/>
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
								<HeaderActionGroup>
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
												router.push({
													pathname: "/skills/new",
													params: { projectId: project.id },
												})
											}
										>
											<Icon as={Plus} />
											<Text>{t("libraryPort.addSkill")}</Text>
										</Button>
									) : null}
								</HeaderActionGroup>
							</WebView>
							{skills.error ? (
								<ApiErrorPanel error={skills.error} onRetry={() => void skills.refetch()} />
							) : (
								<WebView recipe={HERO_GRID_CLASS}>
									{skills.isPending ? <HeroCardSkeleton compact /> : null}
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
											pathname: "/projects/[id]/sharing",
											params: { id: project.id },
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
							<WebView recipe={projectDetailClasses.rowList}></WebView>
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
							<WebView recipe={projectDetailClasses.rowList}></WebView>
							{agents.isSuccess && !agents.data.length ? (
								<EmptyState variant="inset" description={t("libraryPort.emptyProjectAgents")} />
							) : null}
						</WebView>
					) : null}
				</>
			) : null}
		</>
	);
	return (
		<SafeAreaScreen>
			{project && tab === "vaults" ? (
				<ProjectVaultCatalog project={project} header={header} />
			) : (
				<NativeList
					data={cells}
					keyExtractor={(cell, index) => String(cell.key ?? index)}
					renderItem={({ item }) => item}
					header={header}
					refreshing={
						query.isRefetching ||
						(tab === "skills"
							? skills.isRefetching
							: tab === "agents"
								? agents.isRefetching
								: tab === "access"
									? members.isRefetching
									: false)
					}
					onRefresh={() => {
						void query.refetch();
						if (tab === "skills") void skills.refetch();
						if (tab === "agents") void agents.refetch();
						if (tab === "access") void members.refetch();
					}}
					hasMore={tab === "skills" && skills.hasNextPage}
					loadingMore={skills.isFetching}
					onLoadMore={() => void skills.fetchNextPage().catch(() => undefined)}
				/>
			)}
		</SafeAreaScreen>
	);
}
