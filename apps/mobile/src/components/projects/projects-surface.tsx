import type { Project } from "@clawdi/shared/api";
import { createProjectDialogClasses, projectDetailClasses } from "@clawdi/shared/ui";
import {
	archiveProjectTitle,
	canManageCustomProject,
	compareProjectsForUse,
	formatResourceCount,
	createProjectDialogCopy as formCopy,
	getProjectResourceDefinition,
	isCustomProject,
	leaveProjectTitle,
	projectMatchesSearch,
	projectSearchRank,
	projectSharingFormCopy,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { MoreHorizontal, Pencil, Plus } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { HeroCardSkeleton } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { ProjectResourceCard } from "@/components/projects/project-resource-card";
import { ResourceError } from "@/components/resource-error";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { NativeList } from "@/components/ui/native-list";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { WebView, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useHeaderSearch } from "@/platform/navigation/native-header";
import { useSheet } from "@/platform/navigation/use-sheet";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

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

export function ProjectsScreen() {
	const scope = useAccountScope();
	return <ProjectsView key={`${scope.accountKey}:${scope.generation}`} />;
}

function ProjectsView() {
	const t = useI18n();
	const confirmationDialog = useConfirmation();
	const cache = useQueryClient();
	const router = useRouter();
	const projects = useCloudProjects();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { cloud, sharing } = useMobileApi();
	const action = useAuthAction(scope);
	const [search, setSearch] = useState("");
	const archive = (project: Project) => {
		const signal = scope.signal;
		confirmationDialog.show(
			archiveProjectTitle(project.name),
			projectSharingFormCopy.archiveDescription,
			[
				{ text: t("account.cancel"), style: "cancel" },
				{
					text: projectSharingFormCopy.archive,
					style: "destructive",
					onPress: () => {
						if (signal.aborted || !scope.isCurrent()) return;
						return action.runOrThrow(async (isCurrent) => {
							await read((requestSignal) => cloud.archiveProject(project.id, requestSignal));
							if (!isCurrent()) return;

							await projects.refetch();
						});
					},
				},
			],
		);
	};
	const leave = (project: Project) => {
		const signal = scope.signal;
		confirmationDialog.show(
			leaveProjectTitle(project.name),
			projectSharingFormCopy.leaveDescription,
			[
				{ text: t("account.cancel"), style: "cancel" },
				{
					text: projectSharingFormCopy.leave,
					style: "destructive",
					className: projectDetailClasses.destructiveButton,
					onPress: () => {
						if (signal.aborted || !scope.isCurrent()) return;
						return action.runOrThrow(async (isCurrent) => {
							await read(
								(requestSignal) => sharing.leaveProject(project.id, requestSignal),
								signal,
							);
							if (isCurrent()) await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
						});
					},
				},
			],
		);
	};
	const rows = (projects.data ?? [])
		.filter(isCustomProject)
		.filter((p) => projectMatchesSearch(p, search))
		.sort(
			(a, b) =>
				(projectSearchRank(a, search) ?? 0) - (projectSearchRank(b, search) ?? 0) ||
				compareProjectsForUse(a, b),
		);
	const searchOptions = useHeaderSearch({
		value: search,
		onChange: setSearch,
		placeholder: t("libraryPort.searchProjects"),
	});
	return (
		<SafeAreaScreen>
			<Stack.Screen
				options={{ headerSearchBarOptions: searchOptions, headerLargeTitleEnabled: true }}
			/>
			<NativeList
				data={rows}
				keyExtractor={(project) => project.id}
				refreshing={projects.isRefetching}
				onRefresh={() => void projects.refetch()}
				header={
					<>
						<PageHeader
							title={t("projects.title")}
							description={getProjectResourceDefinition("projects").managementDescription}
							headerMenu={{
								label: t("projects.title"),
								items: [
									{
										id: "create",
										label: t("libraryPort.createProject"),
										disabled: action.busy,
										onPress: () => router.push("/projects/new"),
									},
									{
										id: "join",
										label: t("sharing.joinLink"),
										onPress: () => router.push("/projects/join"),
									},
									{
										id: "invitations",
										label: t("sharing.received"),
										onPress: () => router.push("/projects/invitations"),
									},
								],
							}}
						/>
						{projects.error ? (
							<ApiErrorPanel error={projects.error} onRetry={() => void projects.refetch()} />
						) : null}
					</>
				}
				renderItem={({ item: project }) => (
					<ProjectResourceCard
						key={project.id}
						project={project}
						searchQuery={search}
						footer={[
							formatResourceCount(project.skill_count, "skill"),
							formatResourceCount(project.vault_count, "vault"),
							project.is_owner === false && (project.owner_display || project.owner_handle)
								? `by ${project.owner_display || project.owner_handle}`
								: null,
						]}
						actions={
							<DropdownMenu>
								<DropdownMenuTrigger
									disabled={action.busy}
									render={
										<Button variant="ghost" size="icon-sm" accessibilityLabel={project.name}>
											<Icon as={MoreHorizontal} />
										</Button>
									}
								/>
								<DropdownMenuContent>
									{canManageCustomProject(project) ? (
										<>
											<DropdownMenuItem
												label={t("projects.sharing")}
												onSelect={() =>
													router.push({
														pathname: "/projects/[id]/sharing",
														params: { id: project.id },
													})
												}
											/>
											<DropdownMenuItem
												label={t("libraryPort.edit")}
												onSelect={() => {
													router.push({
														pathname: "/projects/[id]/edit",
														params: { id: project.id },
													});
												}}
											/>
											<DropdownMenuItem
												label={t("projects.archive")}
												variant="destructive"
												onSelect={() => archive(project)}
											/>
										</>
									) : (
										<DropdownMenuItem label={t("projects.leave")} onSelect={() => leave(project)} />
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						}
					/>
				)}
				empty={
					projects.isPending ? (
						<HeroCardSkeleton />
					) : !projects.error ? (
						<EmptyState
							title={t(search.trim() ? "libraryPort.noProjectMatches" : "libraryPort.noProjects")}
							description={t("libraryPort.emptyProjects")}
						/>
					) : null
				}
			/>
			{confirmationDialog.dialog}
		</SafeAreaScreen>
	);
}

export function ProjectEditorScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ id?: string }>();
	return (
		<ProjectEditor
			key={`${scope.identity}:${scope.generation}:${params.id ?? "new"}`}
			id={routeParam(params.id)}
		/>
	);
}
function ProjectEditor({ id: editing }: { id?: string }) {
	const t = useI18n(),
		scope = useAccountScope(),
		read = useAccountRead(),
		capture = useForegroundLease();
	const { cloud } = useMobileApi();
	const projects = useCloudProjects();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [closeError, setCloseError] = useState<unknown>();
	const project = projects.data?.find((p) => p.id === editing);
	const initialized = useRef(false);
	useEffect(() => {
		if (project && !initialized.current) {
			initialized.current = true;
			setName(project.name);
			setDescription(project.description ?? "");
		}
	}, [project]);
	const sheet = useSheet<boolean>({ fallback: "/projects", busy: action.busy });
	const save = () =>
		action.run(async (current) => {
			const visible = capture();
			if (!name.trim() || !visible()) return;
			if (editing) {
				const fresh = (await read((signal) => cloud.listProjects(signal))).find(
					(p) => p.id === editing,
				);
				if (!fresh || !canManageCustomProject(fresh)) throw new Error("Project unavailable");
			}
			if (!current() || !visible()) return;
			await read((signal) =>
				editing
					? cloud.updateProject(
							editing,
							{ name: name.trim(), description: description.trim() || null },
							signal,
						)
					: cloud.createProject(
							{ name: name.trim(), description: description.trim() || null },
							signal,
						),
			);
			if (!current()) return;
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
			if (current() && visible()) await sheet.close(true);
		});
	return (
		<SheetPage
			title={editing ? formCopy.editTitle : formCopy.title}
			description={editing ? formCopy.editDescription : formCopy.description}
			fallback="/projects"
			busy={action.busy}
			sheet={sheet}
		>
			{projects.isPending && editing ? (
				<HeroCardSkeleton />
			) : editing && (!project || !canManageCustomProject(project)) ? (
				<ResourceError missing={!projects.isError} onRetry={() => void projects.refetch()} />
			) : (
				<>
					<WebView recipe={createProjectDialogClasses.form}>
						<WebView recipe={createProjectDialogClasses.field}>
							<Label>{formCopy.name}</Label>
							<Input
								value={name}
								onChangeText={setName}
								maxLength={200}
								editable={!action.busy}
								placeholder={editing ? undefined : formCopy.namePlaceholder}
								accessibilityLabel={formCopy.name}
							/>
						</WebView>
						<WebView recipe={createProjectDialogClasses.field}>
							<Label>{formCopy.descriptionLabel}</Label>
							<Input
								multiline
								value={description}
								placeholder={editing ? undefined : formCopy.descriptionPlaceholder}
								className={webView(createProjectDialogClasses.description)}
								onChangeText={setDescription}
								maxLength={2000}
								editable={!action.busy}
							/>
						</WebView>
					</WebView>
					{action.error ? <ApiErrorPanel error={action.error} /> : null}
					<WebView recipe={createProjectDialogClasses.form}>
						<Button
							variant="ghost"
							disabled={action.busy}
							onPress={() => void sheet.close().catch(setCloseError)}
						>
							<Text>{t("libraryPort.cancel")}</Text>
						</Button>
						<Button disabled={action.busy || !name.trim()} onPress={() => void save()}>
							<Icon as={editing ? Pencil : Plus} />
							<Text>{editing ? formCopy.saveChanges : formCopy.title}</Text>
						</Button>
					</WebView>
				</>
			)}
			{closeError ? <ApiErrorPanel error={closeError} /> : null}
		</SheetPage>
	);
}
