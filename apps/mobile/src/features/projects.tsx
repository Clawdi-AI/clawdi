import type { Project } from "@clawdi/shared/api";
import {
	createProjectDialogClasses,
	HERO_GRID_CLASS,
	projectDetailClasses,
} from "@clawdi/shared/ui";
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
import { useRouter } from "expo-router";
import { MoreHorizontal, Pencil, Plus } from "lucide-react-native";
import { useState } from "react";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { ApiErrorPanel } from "../ui/api-error-panel";
import { Button } from "../ui/button";
import { LibraryPage } from "../ui/detail/layout";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { EmptyState } from "../ui/empty-state";
import { HeroCardSkeleton } from "../ui/entity-card";
import { HeaderActionGroup } from "../ui/header-action-group";
import { Icon } from "../ui/icon";
import { Input, Label } from "../ui/input";
import { ListToolbar } from "../ui/list-toolbar";
import { PageHeader } from "../ui/page-header";
import { ProjectResourceCard } from "../ui/projects/project-resource-card";
import { SearchInput } from "../ui/search-input";
import { Text } from "../ui/text";
import { useConfirmation } from "../ui/use-confirmation";
import { WebView, webView } from "../ui/web-layout";

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
	return (
		<ProjectResourceCard
			project={project}
			footer={[
				formatResourceCount(project.skill_count, "skill"),
				formatResourceCount(project.vault_count, "vault"),
			]}
		/>
	);
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
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const reset = () => {
		setName("");
		setDescription("");
		setEditing(null);
		setOpen(false);
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
						return action.run(async (isCurrent) => {
							await read((requestSignal) => cloud.archiveProject(project.id, requestSignal));
							if (!isCurrent()) return;
							if (editing === project.id) reset();
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
						return action.run(async (isCurrent) => {
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
	return (
		<LibraryPage>
			<PageHeader
				title={t("projects.title")}
				description={getProjectResourceDefinition("projects").managementDescription}
				actions={
					<HeaderActionGroup>
						<Button
							size="sm"
							disabled={action.busy}
							onPress={() => {
								reset();
								setOpen(true);
							}}
						>
							<Icon as={Plus} />
							<Text>{t("libraryPort.createProject")}</Text>
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button variant="ghost" size="icon-sm" accessibilityLabel={t("projects.title")}>
										<Icon as={MoreHorizontal} />
									</Button>
								}
							/>
							<DropdownMenuContent>
								<DropdownMenuItem
									label={t("sharing.joinLink")}
									onSelect={() => router.push("/projects/join")}
								/>
								<DropdownMenuItem
									label={t("sharing.received")}
									onSelect={() => router.push("/projects/invitations")}
								/>
							</DropdownMenuContent>
						</DropdownMenu>
					</HeaderActionGroup>
				}
			/>
			<ListToolbar
				search={
					<SearchInput
						value={search}
						onChange={setSearch}
						placeholder={t("libraryPort.searchProjects")}
					/>
				}
			/>
			{projects.error ? (
				<ApiErrorPanel error={projects.error} onRetry={() => void projects.refetch()} />
			) : null}
			<WebView recipe={HERO_GRID_CLASS}>
				{projects.isPending ? (
					[0, 1, 2].map((i) => <HeroCardSkeleton key={i} />)
				) : rows.length === 0 && !projects.error ? (
					<EmptyState
						title={t(search.trim() ? "libraryPort.noProjectMatches" : "libraryPort.noProjects")}
						description={t("libraryPort.emptyProjects")}
					/>
				) : (
					rows.map((project) => (
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
															pathname: "/projects/[projectId]/sharing",
															params: { projectId: project.id },
														})
													}
												/>
												<DropdownMenuItem
													label={t("libraryPort.edit")}
													onSelect={() => {
														setEditing(project.id);
														setName(project.name);
														setDescription(project.description ?? "");
														setOpen(true);
													}}
												/>
												<DropdownMenuItem
													label={t("projects.archive")}
													variant="destructive"
													onSelect={() => archive(project)}
												/>
											</>
										) : (
											<DropdownMenuItem
												label={t("projects.leave")}
												onSelect={() => leave(project)}
											/>
										)}
									</DropdownMenuContent>
								</DropdownMenu>
							}
						/>
					))
				)}
			</WebView>
			<Dialog
				open={open}
				onOpenChange={(v) => {
					if (!action.busy) setOpen(v);
				}}
			>
				<DialogContent
					className={webView(createProjectDialogClasses.dialog)}
					showCloseButton={!action.busy}
				>
					<DialogHeader>
						<DialogTitle>{editing ? formCopy.editTitle : formCopy.title}</DialogTitle>
						<DialogDescription>
							{editing ? formCopy.editDescription : formCopy.description}
						</DialogDescription>
					</DialogHeader>
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
					<DialogFooter>
						<Button variant="ghost" disabled={action.busy} onPress={reset}>
							<Text>{t("libraryPort.cancel")}</Text>
						</Button>
						<Button disabled={action.busy || !name.trim()} onPress={() => void save()}>
							<Icon as={editing ? Pencil : Plus} />
							<Text>{editing ? formCopy.saveChanges : formCopy.title}</Text>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{confirmationDialog.dialog}
		</LibraryPage>
	);
}
