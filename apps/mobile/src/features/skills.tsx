import type { components } from "@clawdi/shared/api";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { AppText, AppView } from "../ui/primitives";
import { InventoryList } from "./inventory-list";

type Skill = components["schemas"]["SkillSummaryResponse"];

export function useCloudSkills() {
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useInfiniteQuery({
		queryKey: accountQueryKey(scope, "cloud-skills"),
		initialPageParam: 1,
		queryFn: ({ signal, pageParam }) =>
			read((readSignal) => cloud.listSkills({ page: pageParam, page_size: 25 }, readSignal), signal),
		getNextPageParam: (page) =>
			page.page * page.page_size < page.total ? page.page + 1 : undefined,
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
		</AppView>
	);
}

export function SkillsScreen() {
	const t = useI18n();
	const skills = useCloudSkills();
	const items = skills.data?.pages.flatMap((page) => page.items) ?? [];
	return (
		<InventoryList
			items={items}
			title={t("skills.title")}
			description={t("skills.description")}
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
