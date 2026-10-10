import {
	type components,
	isWritableSkillProject,
	type Project,
	skillCapabilities,
} from "@clawdi/shared/api";
import { skillsPageClasses } from "@clawdi/shared/ui";
import {
	displayProjectName,
	formatResourceCount,
	isCustomProject,
	skillsPageDescription,
} from "@clawdi/shared/view";
import { useInfiniteQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import FolderKanban from "lucide-react-native/icons/folder-kanban";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { HeroCardSkeleton } from "@/components/entity-card";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { ProjectCardActions } from "@/components/projects/project-actions";
import { ProjectResourceCard } from "@/components/projects/project-resource-card";
import { ProjectResourceBoundary, ProjectScopeHeader } from "@/components/projects/project-scope";
import { CreateProjectButton, useCloudProjects } from "@/components/projects/projects-surface";
import { SkillCardActions } from "@/components/skills/skill-actions";
import { SkillCard } from "@/components/skills/skill-card";
import { Button } from "@/components/ui/button";
import { NativeList } from "@/components/ui/native-list";
import { Text } from "@/components/ui/text";
import { WebText } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useHeaderSearch } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

type Skill = components["schemas"]["SkillSummaryResponse"];

export function useCloudSkills(projectId?: string, search = "", enabled = true) {
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useInfiniteQuery({
		queryKey: accountQueryKey(scope, "cloud-skills", projectId ?? "all", search),
		initialPageParam: 1,
		queryFn: ({ signal, pageParam }) =>
			read(
				(readSignal) =>
					cloud.listSkills(
						{ page: pageParam, page_size: 25, project_id: projectId, q: search || undefined },
						readSignal,
					),
				signal,
			),
		getNextPageParam: (page) =>
			page.items.length && page.page * page.page_size < page.total ? page.page + 1 : undefined,
		enabled: scope.isReady && enabled,
		retry: false,
	});
}

export function SkillRow({ skill, project }: { skill: Skill; project?: Project }) {
	const capabilities = project ? skillCapabilities(skill, project) : undefined;
	return (
		<SkillCard
			skill={skill}
			readOnly={capabilities ? !capabilities.canUpdate : false}
			provenanceLabel={capabilities?.provenanceLabel ?? undefined}
			actions={project ? <SkillCardActions skill={skill} project={project} /> : undefined}
			link={{
				to: {
					pathname: "/skills/[key]",
					params: { key: skill.skill_key, project: skill.project_id ?? "" },
				},
			}}
		/>
	);
}
export function SkillsScreen() {
	return (
		<ProjectResourceBoundary>
			{(project) => <SkillsView project={project} />}
		</ProjectResourceBoundary>
	);
}

function SkillsView({ project }: { project?: Project }) {
	const t = useI18n();
	const [search, setSearch] = useState("");
	const projects = useCloudProjects();
	const skills = useCloudSkills(project?.id, search, Boolean(project));
	const rows = (projects.data ?? [])
		.filter(isCustomProject)
		.sort((a, b) => displayProjectName(a).localeCompare(displayProjectName(b)));
	const items = skills.data?.pages.flatMap((p) => p.items) ?? [];
	const writable = !project || (isWritableSkillProject(project) && !project.archived_at);

	const searchOptions = useHeaderSearch({
		value: search,
		onChange: setSearch,
		placeholder: t("libraryPort.searchSkills"),
	});
	const pageHeader = (
		<>
			<PageHeader
				title={t("skills.title")}
				description={skillsPageDescription(project)}
				headerMenu={
					project && writable
						? {
								label: t("sessionDetail.more"),
								items: [
									{
										id: "create",
										label: t("libraryPort.createSkill"),
										onPress: () =>
											router.push({ pathname: "/skills/new", params: { projectId: project.id } }),
									},
								],
							}
						: undefined
				}
			/>
		</>
	);
	return (
		<SafeAreaScreen>
			<Stack.Screen
				options={{
					headerSearchBarOptions: project ? searchOptions : undefined,
					headerLargeTitleEnabled: !project,
				}}
			/>
			{project ? (
				<NativeList
					data={items}
					keyExtractor={(skill) => `${skill.project_id}:${skill.skill_key}`}
					renderItem={({ item: skill }) => <SkillRow skill={skill} project={project} />}
					refreshing={skills.isRefetching && !skills.isFetchingNextPage}
					onRefresh={() => void skills.refetch()}
					hasMore={skills.hasNextPage}
					loadingMore={skills.isFetching}
					onLoadMore={() => void skills.fetchNextPage().catch(() => undefined)}
					header={
						<>
							{pageHeader}
							<ProjectScopeHeader project={project} />
							<ListToolbar
								actions={
									writable ? (
										<Button
											variant="outline"
											size="sm"
											onPress={() =>
												router.push({
													pathname: "/skills/archive",
													params: { projectId: project.id },
												})
											}
										>
											<Text>{t("skillArchive.title")}</Text>
										</Button>
									) : undefined
								}
							/>
							{skills.error ? (
								<ApiErrorPanel error={skills.error} onRetry={() => void skills.refetch()} />
							) : null}
						</>
					}
					empty={
						skills.isPending ? (
							<HeroCardSkeleton compact />
						) : !skills.error ? (
							<EmptyState description={t("skills.empty")} />
						) : null
					}
				/>
			) : (
				<NativeList
					data={rows}
					keyExtractor={(p) => p.id}
					renderItem={({ item: p }) => (
						<ProjectResourceCard
							key={p.id}
							project={p}
							actions={<ProjectCardActions project={p} />}
							footer={[
								formatResourceCount(p.skill_count, "skill"),
								formatResourceCount(p.vault_count, "vault"),
							]}
							link={{ to: "/skills", search: { projectId: p.id } }}
						/>
					)}
					refreshing={projects.isRefetching}
					onRefresh={() => void projects.refetch()}
					header={
						<>
							{pageHeader}
							{rows.length ? (
								<WebText
									recipe={skillsPageClasses.projectChooserHeading}
									accessibilityRole="header"
								>
									{t("libraryPort.chooseProject")}
								</WebText>
							) : null}
							{projects.error ? (
								<ApiErrorPanel error={projects.error} onRetry={() => void projects.refetch()} />
							) : null}
						</>
					}
					empty={
						projects.isPending ? (
							<HeroCardSkeleton />
						) : !projects.error ? (
							// Same empty state as Web's Skills project chooser.
							<EmptyState
								icon={FolderKanban}
								description={t("libraryPort.emptyProjects")}
								action={<CreateProjectButton />}
							/>
						) : null
					}
				/>
			)}
		</SafeAreaScreen>
	);
}
