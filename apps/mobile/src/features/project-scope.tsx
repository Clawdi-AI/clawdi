import type { Project } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { Fragment, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton, NativePicker } from "../ui/native-controls";
import { AppText, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton, isNotFound } from "./cloud-inventory";
import { useCloudProjects } from "./projects";
import { projectRouteFilter } from "./read-helpers";
import { ResourceError } from "./resource-error";

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
	const params = useLocalSearchParams<{ projectId?: string | string[] }>();
	const filter = projectRouteFilter(params.projectId);
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
						<AppText>{t("loading.app")}</AppText>
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
					<NativeButton
						label={t("projects.all")}
						onPress={() => router.setParams({ projectId: undefined })}
					/>
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
			<NativePicker
				value={project?.id ?? ""}
				disabled={projects.isFetching || projects.isError}
				options={[
					{ value: "", label: t("projects.all") },
					...options.map((p) => ({ value: p.id, label: p.name })),
				]}
				onValueChange={(id) => router.setParams({ projectId: id || undefined })}
			/>
			{project ? (
				<NativeButton
					label={`${t("projects.open")}: ${project.name}`}
					onPress={() =>
						router.push({ pathname: "/projects/[projectId]", params: { projectId: project.id } })
					}
				/>
			) : null}
			{projects.isError ? (
				<ResourceError missing={false} onRetry={() => void projects.refetch()} />
			) : null}
		</AppView>
	);
}
