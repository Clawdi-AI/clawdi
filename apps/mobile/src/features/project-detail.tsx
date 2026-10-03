import { router, useLocalSearchParams } from "expo-router";
import { useI18n } from "../i18n";
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton, isNotFound } from "./cloud-inventory";
import { useProject } from "./project-scope";
import { canManageSharing } from "./project-sharing-state";
import { ProjectRow } from "./projects";
import { projectRouteFilter } from "./read-helpers";
import { ResourceError } from "./resource-error";

export function ProjectDetailScreen() {
	const t = useI18n();
	const params = useLocalSearchParams<{ projectId?: string | string[] }>();
	const filter = projectRouteFilter(params.projectId);
	const id = filter.kind === "project" ? filter.id : undefined;
	const query = useProject(id);
	const mismatched = query.isSuccess && query.data.id !== id;
	const project = query.data?.id === id && !query.isError ? query.data : undefined;
	return (
		<ReadScreen>
			<AppScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
				<BackButton />
				<AppText accessibilityRole="header" className="text-3xl font-semibold text-foreground">
					{t("projects.title")}
				</AppText>
				{!id || query.isError || mismatched ? (
					<ResourceError
						missing={!id || isNotFound(query.error) || mismatched}
						onRetry={query.isFetching ? undefined : () => void query.refetch()}
					/>
				) : query.isPending ? (
					<AppText>{t("loading.app")}</AppText>
				) : null}
				{project ? (
					<>
						<ProjectRow project={project} />
						{project.archived_at ? <AppText>{t("projects.archived")}</AppText> : null}
						<NativeButton
							label={t("agents.title")}
							onPress={() =>
								router.push({ pathname: "/agents", params: { projectId: project.id } })
							}
						/>
						<NativeButton
							label={t("skills.title")}
							onPress={() =>
								router.push({ pathname: "/skills", params: { projectId: project.id } })
							}
						/>
						<NativeButton
							label={t("vault.title")}
							onPress={() => router.push({ pathname: "/vault", params: { projectId: project.id } })}
						/>
						{canManageSharing(project) ? (
							<NativeButton
								label={t("projects.sharing")}
								onPress={() =>
									router.push({
										pathname: "/projects/[projectId]/sharing",
										params: { projectId: project.id },
									})
								}
							/>
						) : null}
					</>
				) : null}
			</AppScrollView>
		</ReadScreen>
	);
}
