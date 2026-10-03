import type { Project } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Alert, type FlatList } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton } from "../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../ui/primitives";
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
				{project.is_owner ? t("projects.owner") : (project.owner_display ?? t("projects.shared"))}
			</AppText>
		</AppView>
	);
}

export function ProjectsScreen() {
	const scope = useAccountScope();
	return <ProjectsView key={`${scope.accountKey}:${scope.generation}`} />;
}

function ProjectsView() {
	const t = useI18n();
	const projects = useCloudProjects();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { cloud } = useMobileApi();
	const action = useAuthAction(scope);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const listRef = useRef<FlatList<Project>>(null);
	const reset = () => {
		setName("");
		setDescription("");
		setEditing(null);
	};
	const save = () =>
		action.run(async (isCurrent) => {
			if (!name.trim()) return;
			const body = { name: name.trim(), description: description.trim() || null };
			await read((signal) =>
				editing ? cloud.updateProject(editing, body, signal) : cloud.createProject(body, signal),
			);
			if (!isCurrent()) return;
			reset();
			await projects.refetch();
		});
	const archive = (project: Project) => {
		const signal = scope.signal;
		Alert.alert(t("projects.archive"), t("projects.archiveWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("projects.archive"),
				style: "destructive",
				onPress: () => {
					if (signal.aborted || !scope.isCurrent()) return;
					void action.run(async (isCurrent) => {
						await read((requestSignal) => cloud.archiveProject(project.id, requestSignal));
						if (!isCurrent()) return;
						if (editing === project.id) reset();
						await projects.refetch();
					});
				},
			},
		]);
	};
	return (
		<InventoryList
			listRef={listRef}
			header={
				<AppView className="gap-3">
					<AppText>{t(editing ? "projects.edit" : "projects.create")}</AppText>
					<AppTextInput
						accessibilityLabel={t("projects.name")}
						placeholder={t("projects.name")}
						value={name}
						onChangeText={setName}
						maxLength={200}
						editable={!action.busy}
						className="rounded-xl bg-surface p-3 text-foreground"
					/>
					<AppTextInput
						accessibilityLabel={t("projects.summary")}
						placeholder={t("projects.summary")}
						multiline
						value={description}
						onChangeText={setDescription}
						maxLength={2000}
						editable={!action.busy}
						className="rounded-xl bg-surface p-3 text-foreground"
					/>
					<NativeButton
						label={t("projects.save")}
						disabled={action.busy || !name.trim()}
						onPress={() => void save()}
					/>
					{editing ? (
						<NativeButton label={t("account.cancel")} disabled={action.busy} onPress={reset} />
					) : null}
					{action.error ? (
						<AppText accessibilityRole="alert">{t("projects.mutationFailed")}</AppText>
					) : null}
				</AppView>
			}
			items={projects.data ?? []}
			title={t("projects.title")}
			description={t("projects.description")}
			empty={t(projects.isPending ? "loading.app" : "projects.empty")}
			renderItem={(project) => (
				<AppView className="gap-2">
					<ProjectRow project={project} />
					{project.is_owner && project.kind === "workspace" && !project.archived_at ? (
						<>
							<NativeButton
								label={t("projects.edit")}
								disabled={action.busy}
								onPress={() => {
									setEditing(project.id);
									setName(project.name);
									setDescription(project.description ?? "");
									listRef.current?.scrollToOffset({ offset: 0, animated: true });
								}}
							/>
							<NativeButton
								label={t("projects.archive")}
								disabled={action.busy}
								onPress={() => archive(project)}
							/>
						</>
					) : null}
				</AppView>
			)}
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
