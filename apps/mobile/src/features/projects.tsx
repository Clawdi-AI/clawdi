import type { Project } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { AppText, AppView } from "../ui/primitives";
import { InventoryList } from "./inventory-list";

export function useCloudProjects() {
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useQuery({
		queryKey: accountQueryKey(scope, "cloud-projects"),
		queryFn: ({ signal }) => read((readSignal) => cloud.listProjects(readSignal), signal),
		enabled: scope.isReady,
		retry: false,
	});
}

export function ProjectRow({ project }: { project: Project }) {
	const t = useI18n();
	return (
		<AppView className="gap-2 rounded-2xl bg-surface p-4">
			<AppText className="text-lg font-semibold text-foreground">
				{project.name || project.slug || t("projects.unknown")}
			</AppText>
			<AppText className="text-sm text-muted">{project.description ?? project.kind}</AppText>
			<AppText className="text-xs text-muted">
				{project.is_owner
					? t("projects.owner")
					: (project.owner_display ?? t("projects.shared"))}
			</AppText>
		</AppView>
	);
}

export function ProjectsScreen() {
	const t = useI18n();
	const projects = useCloudProjects();
	return (
		<InventoryList
			items={projects.data ?? []}
			title={t("projects.title")}
			description={t("projects.description")}
			empty={t("projects.empty")}
			renderItem={(project) => <ProjectRow project={project} />}
			refreshing={projects.isRefetching}
			onRefresh={() => {
				if (!projects.isFetching) void projects.refetch();
			}}
			error={projects.isError}
			onRetry={() => void projects.refetch()}
			busy={projects.isFetching}
		/>
	);
}
