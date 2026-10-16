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
	isProjectOwner,
	LIBRARY_COPY,
	SHARING_COPY,
	SKILLS_LIST_COPY,
	skillsEmptyMessage,
	skillsPageDescription,
} from "@clawdi/shared/view";
import { useInfiniteQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import FolderKanban from "lucide-react-native/icons/folder-kanban";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { HeroCardSkeleton } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { ProjectCardActions } from "@/components/projects/project-actions";
import { ProjectResourceCard } from "@/components/projects/project-resource-card";
import { ProjectResourceBoundary, ProjectScopeHeader } from "@/components/projects/project-scope";
import { CreateProjectButton, useCloudProjects } from "@/components/projects/projects-surface";
import { SkillCardActions } from "@/components/skills/skill-actions";
import { SkillCard } from "@/components/skills/skill-card";
import { Alert } from "@/components/ui/alert";
import { NativeList } from "@/components/ui/native-list";
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
		<ProjectResourceBoundary
			missingNotice={
				<Alert title={SKILLS_LIST_COPY.projectUnavailableTitle}>
					{SKILLS_LIST_COPY.projectUnavailableDescription}
				</Alert>
			}
		>
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
	const owner = Boolean(project && isProjectOwner(project));
	const writable = Boolean(
		project && owner && isWritableSkillProject(project) && !project.archived_at,
	);

	const searchOptions = useHeaderSearch({
		value: search,
		onChange: setSearch,
		placeholder: SKILLS_LIST_COPY.searchProject,
	});
	const pageHeader = (
		<PageHeader
			title={SKILLS_LIST_COPY.title}
			description={skillsPageDescription(project)}
			headerMenu={
				project && (owner || writable)
					? {
							label: t("sessionDetail.more"),
							items: [
								...(owner
									? [
											{
												id: "share",
												label: SHARING_COPY.shareProject,
												onPress: () =>
													router.push({
														pathname: "/projects/[id]/sharing",
														params: { id: project.id },
													}),
											},
										]
									: []),
								...(writable
									? [
											{
												id: "import",
												label: LIBRARY_COPY.importSkill,
												onPress: () =>
													router.push({
														pathname: "/skills/import",
														params: { projectId: project.id },
													}),
											},
											{
												id: "create",
												label: LIBRARY_COPY.addSkill,
												onPress: () =>
													router.push({
														pathname: "/skills/new",
														params: { projectId: project.id },
													}),
											},
										]
									: []),
							],
						}
					: undefined
			}
		/>
	);
	return (
		<SafeAreaScreen>
			<Stack.Screen options={{ headerLargeTitleEnabled: !project }} />
			{project ? <Stack.SearchBar {...searchOptions} /> : null}
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
							{!writable ? (
								<Alert title={SKILLS_LIST_COPY.readOnlyTitle}>
									{SKILLS_LIST_COPY.readOnlyDescription}
								</Alert>
							) : null}
							{skills.error ? (
								<ApiErrorPanel
									error={skills.error}
									onRetry={() => void skills.refetch()}
									title={SKILLS_LIST_COPY.loadFailed}
								/>
							) : null}
						</>
					}
					empty={
						skills.isPending ? (
							<HeroCardSkeleton compact />
						) : !skills.error ? (
							<EmptyState description={skillsEmptyMessage({ search: search.trim(), writable })} />
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
									{LIBRARY_COPY.chooseProject}
								</WebText>
							) : null}
							{projects.error ? (
								<ApiErrorPanel
									error={projects.error}
									onRetry={() => void projects.refetch()}
									title={LIBRARY_COPY.loadProjectsFailed}
								/>
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
								description={SKILLS_LIST_COPY.emptyProjects}
								action={<CreateProjectButton />}
							/>
						) : null
					}
				/>
			)}
		</SafeAreaScreen>
	);
}
