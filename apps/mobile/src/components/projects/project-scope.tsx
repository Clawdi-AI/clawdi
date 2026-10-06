import type { Project } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { Fragment, type ReactNode } from "react";
import { useMobileApi } from "@/components/api-provider";
import { ChoiceSelect } from "@/components/detail/choice-select";
import { PageHeaderSkeleton } from "@/components/page-header";
import { useCloudProjects } from "@/components/projects/projects-surface";
import { ResourceError } from "@/components/resource-error";
import { Button } from "@/components/ui/button";
import { AppText, AppView } from "@/components/ui/primitives";
import { Text } from "@/components/ui/text";
import { BackButton, isNotFound } from "@/hooks/cloud-inventory";
import { useI18n } from "@/lib/i18n";
import { projectRouteFilter } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { ReadScreen } from "@/platform/safe-area-screen";

export function useProject(id?: string) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const { sharing } = useMobileApi();
	return useQuery({
		queryKey: accountQueryKey(scope, "project-detail", id),
		queryFn: ({ signal }) => read((s) => sharing.getProject(id ?? "", s), signal),
		enabled: scope.isReady && !!id,
		retry: false,
	});
}

export function ProjectResourceBoundary({
	children,
}: {
	children: (project?: Project) => ReactNode;
}) {
	const scope = useAccountScope();
	const t = useI18n();
	const params = useLocalSearchParams<{
		project?: string | string[];
		projectId?: string | string[];
	}>();
	const filter = projectRouteFilter(params.project ?? params.projectId);
	const id = filter.kind === "project" ? filter.id : undefined;
	const project = useProject(id);
	if (
		filter.kind === "invalid" ||
		(id && (!project.data || project.isError || project.data.id !== id))
	) {
		return (
			<ReadScreen>
				<AppView className="gap-4 p-6">
					<BackButton />
					{id && project.isPending ? (
						<PageHeaderSkeleton />
					) : (
						<ResourceError
							missing={
								filter.kind === "invalid" ||
								isNotFound(project.error) ||
								(!project.isError && project.data?.id !== id)
							}
							onRetry={project.isFetching ? undefined : () => void project.refetch()}
						/>
					)}
					<Button
						variant="outline"
						size="sm"
						onPress={() => router.setParams({ projectId: undefined })}
					>
						<Text>{t("projects.all")}</Text>
					</Button>
				</AppView>
			</ReadScreen>
		);
	}
	return (
		<Fragment key={`${scope.identity}:${scope.generation}:${id ?? "all"}`}>
			{children(id ? project.data : undefined)}
		</Fragment>
	);
}

export function ProjectScopeHeader({ project }: { project?: Project }) {
	const t = useI18n();
	const projects = useCloudProjects();
	const options = [
		...new Map(
			[...(projects.data ?? []), ...(project ? [project] : [])].map((p) => [p.id, p]),
		).values(),
	];
	return (
		<AppView className="gap-2">
			<AppText>{t("projects.filter")}</AppText>
			<ChoiceSelect
				value={project?.id ?? ""}
				disabled={projects.isFetching || projects.isError}
				options={[
					{ value: "", label: t("projects.all") },
					...options.map((p) => ({ value: p.id, label: p.name })),
				]}
				onValueChange={(id) => router.setParams({ projectId: id || undefined })}
			/>
			{project ? (
				<Button
					variant="outline"
					size="sm"
					onPress={() => router.push({ pathname: "/projects/[id]", params: { id: project.id } })}
				>
					<Text>{`${t("projects.open")}: ${project.name}`}</Text>
				</Button>
			) : null}
			{projects.isError ? (
				<ResourceError missing={false} onRetry={() => void projects.refetch()} />
			) : null}
		</AppView>
	);
}
