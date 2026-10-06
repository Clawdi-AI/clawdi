import {
	type components,
	isWritableSkillProject,
	type Project,
	skillCapabilities,
} from "@clawdi/shared/api";
import { HERO_GRID_CLASS, skillsPageClasses } from "@clawdi/shared/ui";
import {
	displayProjectName,
	formatResourceCount,
	isCustomProject,
	skillsPageDescription,
} from "@clawdi/shared/view";
import { useInfiniteQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Plus } from "lucide-react-native";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { LibraryPage } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { HeroCardSkeleton } from "@/components/entity-card";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { ProjectCardActions } from "@/components/projects/project-actions";
import { ProjectResourceCard } from "@/components/projects/project-resource-card";
import { ProjectResourceBoundary, ProjectScopeHeader } from "@/components/projects/project-scope";
import { useCloudProjects } from "@/components/projects/projects-surface";
import { SkillCardActions } from "@/components/skills/skill-actions";
import { SkillCard } from "@/components/skills/skill-card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SearchInput } from "@/components/ui/search-input";
import { Text } from "@/components/ui/text";
import { WebText, WebView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

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
	return (
		<LibraryPage>
			<PageHeader
				title={t("skills.title")}
				description={skillsPageDescription(project)}
				actions={
					project && writable ? (
						<Button
							size="sm"
							onPress={() =>
								router.push({ pathname: "/native/skills/new", params: { projectId: project.id } })
							}
						>
							<Icon as={Plus} />
							<Text>{t("libraryPort.createSkill")}</Text>
						</Button>
					) : undefined
				}
			/>
			{!project ? (
				<WebView recipe={skillsPageClasses.projectChooser}>
					<WebText recipe={skillsPageClasses.projectChooserHeading}>
						{t("libraryPort.chooseProject")}
					</WebText>
					{projects.error ? (
						<ApiErrorPanel error={projects.error} onRetry={() => void projects.refetch()} />
					) : null}
					<WebView recipe={HERO_GRID_CLASS}>
						{projects.isPending
							? [0, 1, 2].map((i) => <HeroCardSkeleton key={i} />)
							: rows.map((p) => (
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
								))}
					</WebView>
				</WebView>
			) : (
				<>
					<ProjectScopeHeader project={project} />
					<ListToolbar
						search={
							<SearchInput
								value={search}
								onChange={setSearch}
								placeholder={t("libraryPort.searchSkills")}
							/>
						}
						actions={
							writable ? (
								<Button
									variant="outline"
									size="sm"
									onPress={() =>
										router.push({
											pathname: "/native/skills/archive",
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
					<WebView recipe={HERO_GRID_CLASS}>
						{skills.isPending ? (
							[0, 1, 2].map((i) => <HeroCardSkeleton compact key={i} />)
						) : items.length ? (
							items.map((skill) => (
								<SkillRow
									key={`${skill.project_id}:${skill.skill_key}`}
									skill={skill}
									project={project}
								/>
							))
						) : !skills.error ? (
							<EmptyState description={t("skills.empty")} />
						) : null}
					</WebView>
					{skills.hasNextPage ? (
						<Button
							variant="outline"
							disabled={skills.isFetching}
							onPress={() => void skills.fetchNextPage()}
						>
							<Text>{t("inventory.loadMore")}</Text>
						</Button>
					) : null}
				</>
			)}
		</LibraryPage>
	);
}
