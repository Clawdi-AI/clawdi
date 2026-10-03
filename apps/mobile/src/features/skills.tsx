import { type components, isWritableSkillProject, type Project } from "@clawdi/shared/api";
import { useInfiniteQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton } from "../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../ui/primitives";
import { InventoryList } from "./inventory-list";
import { ProjectResourceBoundary, ProjectScopeHeader } from "./project-scope";

type Skill = components["schemas"]["SkillSummaryResponse"];

export function useCloudSkills(projectId?: string, search = "") {
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
		enabled: scope.isReady,
		retry: false,
	});
}

export function SkillRow({ skill }: { skill: Skill }) {
	const t = useI18n();
	return (
		<AppView className="gap-2 rounded-2xl bg-surface p-4">
			<AppText className="text-lg font-semibold text-foreground">
				{skill.name || skill.skill_key || t("skills.unknown")}
			</AppText>
			<AppText className="text-sm text-muted">{skill.description ?? skill.skill_key}</AppText>
			<AppText className="text-xs text-muted">
				{skill.source} · v{skill.version}
			</AppText>
			{skill.project_id ? (
				<NativeButton
					label={t("skills.open")}
					onPress={() =>
						router.push({
							pathname: "/skills/detail",
							params: { projectId: skill.project_id ?? "", skillKey: skill.skill_key },
						})
					}
				/>
			) : null}
		</AppView>
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
	const [query, setQuery] = useState("");
	const skills = useCloudSkills(project?.id, query);
	const items = skills.data?.pages.flatMap((page) => page.items) ?? [];
	return (
		<InventoryList
			items={items}
			header={
				<AppView className="gap-3">
					<ProjectScopeHeader project={project} />
					<AppTextInput
						accessibilityLabel={t("skills.search")}
						placeholder={t("skills.search")}
						value={search}
						onChangeText={setSearch}
						maxLength={200}
						className="rounded-xl bg-surface p-3 text-foreground"
					/>
					<NativeButton label={t("vault.searchAction")} onPress={() => setQuery(search.trim())} />
					{!project || (isWritableSkillProject(project) && !project.archived_at) ? (
						<NativeButton
							label={t("skills.create")}
							onPress={() =>
								router.push({
									pathname: "/skills/new",
									params: project ? { projectId: project.id } : {},
								})
							}
						/>
					) : null}
				</AppView>
			}
			title={t("skills.title")}
			description={t("skills.summary")}
			empty={t("skills.empty")}
			renderItem={(skill) => <SkillRow skill={skill} />}
			refreshing={skills.isRefetching}
			onRefresh={() => {
				if (!skills.isFetching) void skills.refetch();
			}}
			error={skills.isError}
			onRetry={() => void skills.refetch()}
			busy={skills.isFetching}
			more={skills.hasNextPage}
			onMore={() => {
				if (!skills.isFetching) void skills.fetchNextPage();
			}}
		/>
	);
}
