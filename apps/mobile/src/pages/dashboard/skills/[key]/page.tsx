import {
	ApiClientError,
	buildSkillCreateRequest,
	buildSkillUpdateRequest,
	isWritableSkillProject,
	parseProjectSkillGitHubInput,
	type SkillTextDraft,
	skillCapabilities,
	stripFrontmatter,
} from "@clawdi/shared/api";
import {
	createSkillDialogClasses,
	detailLayoutClasses,
	projectIdentityClasses,
	skillDetailClasses,
} from "@clawdi/shared/ui";
import {
	skillFormCopy as copy,
	createSkillDescription,
	identityFor,
	isProjectOwner,
	ownedProjectKindText,
	projectPickerAccessText,
	projectSupportingText,
	RESOURCE_TINT_CLASSES,
	relativeTime,
	skillDraftUnchanged,
	skillRemovalDescription,
	skillRemovalTitle,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import {
	BookOpen,
	Bot,
	Copy,
	FileText,
	FolderKanban,
	Pencil,
	Plus,
	Save,
	Sparkles,
	Tag,
	Trash2,
	X,
} from "lucide-react-native";
import { useRef, useState } from "react";
import { useMobileApi } from "@/components/api-provider";
import { ChoiceSelect } from "@/components/detail/choice-select";
import { DetailBackLink, DetailMeta, DetailPanel } from "@/components/detail/layout";
import { IconChip } from "@/components/icon-chip";
import { Markdown } from "@/components/markdown";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { ProjectResourceBoundary } from "@/components/projects/project-scope";
import { useCloudProjects } from "@/components/projects/projects-surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { AppScrollView, AppText, AppView } from "@/components/ui/primitives";
import { Text } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { WebText, WebView, webBoth, webText, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { ReadScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

type EditDraft = SkillTextDraft & { revision: string };
export function SkillEditorScreen({
	create = false,
	projectId: scopedProject,
}: {
	create?: boolean;
	projectId?: string;
} = {}) {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{
		projectId?: string | string[];
		project?: string | string[];
		key?: string | string[];
		skillKey?: string | string[];
	}>();
	const projectId = scopedProject ?? routeParam(params.project ?? params.projectId);
	const skillKey = routeParam(
		Array.isArray(params.key) ? params.key.join("/") : (params.key ?? params.skillKey),
	);
	if (create)
		return (
			<ProjectResourceBoundary>
				{(project) => (
					<SkillEditor
						key={`${scope.identity}:${scope.generation}:${project?.id ?? "all"}:create`}
						create
						projectId={project?.id}
					/>
				)}
			</ProjectResourceBoundary>
		);
	return (
		<SkillEditor
			key={`${scope.identity}:${scope.generation}:${projectId}:${skillKey}:${create}`}
			create={create}
			projectId={projectId}
			skillKey={skillKey}
		/>
	);
}
function SkillEditor({
	create,
	projectId,
	skillKey,
}: {
	create: boolean;
	projectId?: string;
	skillKey?: string;
}) {
	const t = useI18n();
	const confirmationDialog = useConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { skills } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const navigation = useNavigation();
	const capture = useForegroundLease();
	const confirmation = useRef(0);
	const acknowledged = useRef(false);
	const [completed, setCompleted] = useState(false);
	const [baseline, setBaseline] = useState<SkillTextDraft | null>(null);
	const projects = useCloudProjects();
	const [selection, setSelection] = useState(projectId ?? "");
	const writable = (projects.data ?? []).filter((p) => isWritableSkillProject(p) && !p.archived_at);
	const selectedId = create ? writable.find((p) => p.id === selection)?.id : projectId;
	const project = projects.data?.find((p) => p.id === selectedId);
	const detail = useQuery({
		queryKey: accountQueryKey(scope, "skill-detail", projectId, skillKey),
		queryFn: ({ signal }) =>
			read(
				(s) =>
					projectId
						? skills.get(projectId, skillKey ?? "", s)
						: skills.getLibrary(skillKey ?? "", s),
				signal,
			),
		enabled: !create && scope.isReady && Boolean(skillKey),
		retry: false,
	});
	const [draft, setDraft] = useState<EditDraft | null>(
		create ? { name: "", description: "", instructions: "", revision: "" } : null,
	);
	const [source, setSource] = useState("");
	const [importOpen, setImportOpen] = useState(false);
	const [conflict, setConflict] = useState(false);
	const dirty = Boolean(
		source ||
			(draft &&
				(draft.name !== (baseline?.name ?? "") ||
					draft.description !== (baseline?.description ?? "") ||
					draft.instructions !== (baseline?.instructions ?? ""))),
	);
	usePreventRemove(scope.isReady && !completed && (dirty || action.busy), ({ data }) => {
		// Redispatch the original action only after a confirmed mutation or explicit discard.
		if (acknowledged.current) {
			navigation.dispatch(data.action);
			return;
		}
		if (action.busy) return;
		const visible = capture();
		const ticket = ++confirmation.current;
		confirmationDialog.show(t("profile.unsavedTitle"), t("skills.discardWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("profile.discard"),
				style: "destructive",
				onPress: () => {
					if (ticket !== confirmation.current || !visible() || !scope.isCurrent()) return;
					confirmation.current++;
					navigation.dispatch(data.action);
				},
			},
		]);
	});
	const matches =
		detail.data?.skill_key === skillKey && (!projectId || detail.data?.project_id === projectId);
	const canWrite = create
		? Boolean(project && isWritableSkillProject(project))
		: Boolean(
				projectId &&
					matches &&
					detail.data &&
					!project?.archived_at &&
					skillCapabilities(detail.data, project).canUpdate,
			);
	const disabled =
		completed ||
		action.busy ||
		projects.isPending ||
		projects.isError ||
		!scope.isReady ||
		!canWrite ||
		(!create && (detail.isPending || detail.isError || detail.isFetching));
	const invalidate = () => cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
	const save = (install = false) =>
		action.run(async (isCurrent) => {
			if (disabled || !selectedId || (!install && !draft)) return;
			confirmation.current++;
			const visible = capture();
			if (!visible()) return;
			try {
				if (install)
					await read((s) => skills.install(selectedId, parseProjectSkillGitHubInput(source), s));
				else if (draft) {
					if (create)
						await read((s) => skills.create(selectedId, buildSkillCreateRequest(draft), s));
					else
						await read((s) =>
							skills.update(
								selectedId,
								skillKey ?? "",
								buildSkillUpdateRequest(draft, draft.revision),
								s,
							),
						);
				}
				if (!isCurrent()) return;
				setConflict(false);
				await invalidate();
				if (!isCurrent()) return;
				if (create) {
					acknowledged.current = true;
					setCompleted(true);
					if (visible()) router.replace("/skills");
				} else setDraft(null);
			} catch (error) {
				if (isCurrent() && error instanceof ApiClientError && error.status === 412)
					setConflict(true);
				throw error;
			}
		});
	const remove = () => {
		const current = detail.data;
		if (disabled || !current || !projectId || !skillKey) return;
		const signal = scope.signal;
		const visible = capture();
		confirmationDialog.show(
			skillRemovalTitle(detail.data?.name ?? "this Skill"),
			skillRemovalDescription(project?.name),
			[
				{ text: t("account.cancel"), style: "cancel" },
				{
					text: t("libraryPort.removeFromProject"),
					style: "destructive",
					onPress: () => {
						if (signal.aborted || !scope.isCurrent() || !visible()) return;
						return action.run(async (isCurrent) => {
							await read((s) => skills.remove(projectId, skillKey, current.content_hash, s));
							if (!isCurrent()) return;
							await invalidate();
							if (isCurrent() && visible()) {
								acknowledged.current = true;
								router.replace("/skills");
							}
						});
					},
				},
			],
		);
	};
	const startEdit = () => {
		if (disabled || !detail.data || detail.data.content === null) return;
		setBaseline({
			name: detail.data.name,
			description: detail.data.description ?? "",
			instructions: stripFrontmatter(detail.data.content),
		});
		setDraft({
			name: detail.data.name,
			description: detail.data.description ?? "",
			instructions: stripFrontmatter(detail.data.content),
			revision: detail.data.content_hash,
		});
		setConflict(false);
		action.clearError();
	};
	const fields = draft ? (
		<WebView recipe={create ? createSkillDialogClasses.form : skillDetailClasses.instructionPanel}>
			{(["name", "description", "instructions"] as const).map((field) => (
				<WebView
					key={field}
					recipe={create ? createSkillDialogClasses.field : skillDetailClasses.field}
				>
					<Label>{copy[field]}</Label>
					<Input
						accessibilityLabel={copy[field]}
						placeholder={create ? copy[`${field}Placeholder`] : undefined}
						value={draft[field]}
						editable={!disabled}
						multiline={field === "instructions"}
						className={
							field === "instructions"
								? webView(create ? createSkillDialogClasses.textarea : skillDetailClasses.textarea)
								: undefined
						}
						maxLength={field === "name" ? 64 : field === "description" ? 1024 : 204800}
						autoCapitalize={field === "name" ? "none" : "sentences"}
						onChangeText={(value) => setDraft({ ...draft, [field]: value })}
					/>
					{create && field === "name" ? (
						<WebText recipe={createSkillDialogClasses.help}>{copy.nameHelp}</WebText>
					) : null}
				</WebView>
			))}
		</WebView>
	) : null;
	const saveButton = draft ? (
		<Button
			disabled={
				disabled ||
				conflict ||
				(!create && Boolean(baseline && skillDraftUnchanged(draft, baseline))) ||
				!draft.name.trim() ||
				!draft.description.trim() ||
				!draft.instructions.trim()
			}
			onPress={() => void save()}
		>
			<Icon as={create ? Plus : Save} />
			<Text>
				{action.busy ? (create ? copy.adding : copy.saving) : create ? copy.title : copy.save}
			</Text>
		</Button>
	) : null;
	const projectPanel = (
		<DetailPanel className={webView(skillDetailClasses.panel)}>
			<WebView recipe={skillDetailClasses.headingStack}>
				<WebView recipe={skillDetailClasses.headingRow}>
					<Icon as={FolderKanban} />
					<WebText recipe={skillDetailClasses.heading}>{t("skills.project")}</WebText>
				</WebView>
				<WebText recipe={skillDetailClasses.subtitle}>
					{t("libraryPort.projectSkillDescription")}
				</WebText>
			</WebView>
			<Badge variant="outline">
				<Text>{canWrite ? "Editable" : "Read-only"}</Text>
			</Badge>
			{project ? (
				<WebView recipe={projectIdentityClasses.root}>
					<WebView
						recipe={projectIdentityClasses.icon}
						className={webView(identityFor(project.name).colorClasses)}
					>
						<Text>{identityFor(project.name).emoji}</Text>
					</WebView>
					<WebView recipe={projectIdentityClasses.body}>
						<WebView recipe={projectIdentityClasses.titleRow}>
							<WebText recipe={projectIdentityClasses.title} numberOfLines={1}>
								{project.name}
							</WebText>
							<Badge
								variant="outline"
								className={webBoth(
									`${projectIdentityClasses.kind} ${["workspace", "environment", "personal"].includes(project.kind ?? "") ? projectIdentityClasses.kindSurface : projectIdentityClasses.kindFallback}`,
								)}
							>
								<Icon
									as={project.kind === "environment" ? Bot : FolderKanban}
									className={webBoth(projectIdentityClasses.kindIcon)}
								/>
								<Text>{ownedProjectKindText(project, "badge")}</Text>
							</Badge>
							<Badge
								variant="outline"
								className={webBoth(
									`${projectIdentityClasses.access} ${isProjectOwner(project) ? "" : projectIdentityClasses.viewer}`,
								)}
							>
								<Text>{projectPickerAccessText(project)}</Text>
							</Badge>
						</WebView>
						<WebText recipe={projectIdentityClasses.supporting} numberOfLines={1}>
							{projectSupportingText(project)}
						</WebText>
					</WebView>
				</WebView>
			) : null}
		</DetailPanel>
	);
	return (
		<ReadScreen>
			<AppScrollView
				keyboardShouldPersistTaps="handled"
				contentContainerClassName={webView(detailLayoutClasses.detailPage)}
			>
				<DetailBackLink href="/skills" label={t("skills.title")} />
				{completed ? <AppText className="text-foreground">{t("skills.saved")}</AppText> : null}
				{projects.isError ||
				(!create && (detail.isError || !skillKey || (detail.data && !matches))) ? (
					<ErrorState
						onRetry={() => {
							void projects.refetch();
							if (skillKey) void detail.refetch();
						}}
					/>
				) : null}
				{!create && skillKey && detail.isPending ? <PageHeaderSkeleton icon actions /> : null}
				{!canWrite && !projects.isPending && (create || detail.data) ? (
					<AppText className="text-muted-foreground">
						{t(!create && !projectId ? "skills.chooseProject" : "skills.readOnly")}
					</AppText>
				) : null}
				{draft && create ? (
					<Dialog
						open
						onOpenChange={(next) => {
							if (!next && !action.busy) router.back();
						}}
					>
						<DialogContent
							className={webView(createSkillDialogClasses.dialog)}
							showCloseButton={!action.busy}
						>
							<DialogHeader>
								<DialogTitle>{copy.title}</DialogTitle>
								<DialogDescription>
									{project ? createSkillDescription(project) : t("skills.chooseProject")}
								</DialogDescription>
							</DialogHeader>
							{!projectId ? (
								<ChoiceSelect
									disabled={action.busy}
									value={selectedId ?? ""}
									options={[
										{ value: "", label: copy.chooseProject },
										...writable.map((p) => ({ value: p.id, label: p.name })),
									]}
									onValueChange={setSelection}
								/>
							) : null}
							{fields}
							<DialogFooter>
								<Button variant="outline" disabled={action.busy} onPress={() => router.back()}>
									<Text>{copy.cancel}</Text>
								</Button>
								{saveButton}
							</DialogFooter>
							{create && importOpen ? (
								<AppView className="gap-3">
									<AppText className="text-foreground">{t("skills.import")}</AppText>
									<Input
										accessibilityLabel={t("skills.github")}
										placeholder={t("skills.github")}
										autoCapitalize="none"
										autoCorrect={false}
										editable={!disabled}
										value={source}
										onChangeText={setSource}
									/>
									<Button
										variant="default"
										size="sm"
										disabled={disabled || !source.trim()}
										onPress={() => {
											void save(true);
										}}
									>
										<Text>{t("skills.import")}</Text>
									</Button>
								</AppView>
							) : null}
							<Button variant="ghost" onPress={() => setImportOpen(!importOpen)}>
								<Text>{t("skills.import")}</Text>
							</Button>
							{action.error ? <ErrorState /> : null}
						</DialogContent>
					</Dialog>
				) : draft ? (
					<>
						<PageHeader
							title={detail.data?.name ?? draft.name}
							description={detail.data?.description}
							icon={
								<IconChip tint={RESOURCE_TINT_CLASSES.skills}>
									<Icon as={Sparkles} />
								</IconChip>
							}
							status={
								<DetailMeta>
									<Text>{`Project Skill · in ${project?.name ?? detail.data?.project_name} · added ${detail.data ? relativeTime(detail.data.created_at) : ""}`}</Text>
								</DetailMeta>
							}
							actions={
								<>
									<Button
										variant="outline"
										disabled={action.busy}
										onPress={() => {
											const visible = capture();
											const ticket = ++confirmation.current;
											confirmationDialog.show(t("skills.discard"), t("skills.discardWarning"), [
												{ text: copy.cancel, style: "cancel" },
												{
													text: t("skills.discard"),
													style: "destructive",
													onPress: () => {
														if (ticket !== confirmation.current || !visible() || !scope.isCurrent())
															return;
														confirmation.current++;
														setDraft(null);
														setConflict(false);
														action.clearError();
														void detail.refetch();
													},
												},
											]);
										}}
									>
										<Icon as={X} />
										<Text>{copy.cancel}</Text>
									</Button>
									{saveButton}
								</>
							}
						/>
						<DetailMeta>
							<Icon as={Tag} />
							<Text>v{detail.data?.version}</Text>
							<Icon as={FileText} />
							<Text>{detail.data?.file_count} files</Text>
						</DetailMeta>
						{projectPanel}
						<DetailPanel className={webView(skillDetailClasses.instructionPanel)}>
							<WebView recipe={skillDetailClasses.headingStack}>
								<WebText recipe={skillDetailClasses.heading}>{copy.editTitle}</WebText>
								<WebText recipe={skillDetailClasses.projectDescription}>
									{copy.editDescription}
								</WebText>
							</WebView>
							{fields}
						</DetailPanel>
					</>
				) : detail.data && matches ? (
					<>
						<PageHeader
							title={detail.data.name}
							description={detail.data.description}
							icon={
								<IconChip tint={RESOURCE_TINT_CLASSES.skills}>
									<Icon as={Sparkles} />
								</IconChip>
							}
							status={
								<DetailMeta>
									<Text>
										Project Skill · in {project?.name ?? detail.data.project_name} · added{" "}
										{relativeTime(detail.data.created_at)}
									</Text>
								</DetailMeta>
							}
							actions={
								canWrite ? (
									<>
										{projectId ? (
											<Button
												variant="outline"
												size="sm"
												disabled={action.busy || detail.isError}
												onPress={() =>
													router.push({
														pathname: "/skills/archive",
														params: { projectId, skillKey: skillKey ?? "" },
													})
												}
											>
												<Icon as={Copy} />
												<Text>{t("libraryPort.copyOrMove")}</Text>
											</Button>
										) : null}
										<Button
											variant="outline"
											size="sm"
											disabled={disabled || detail.data.content === null}
											onPress={startEdit}
										>
											<Icon as={Pencil} />
											<Text>{t("libraryPort.edit")}</Text>
										</Button>
										<Button
											variant="outline"
											size="sm"
											disabled={disabled}
											textClassName={webText(skillDetailClasses.removeAction)}
											onPress={remove}
										>
											<Icon as={Trash2} />
											<Text>{t("libraryPort.removeFromProject")}</Text>
										</Button>
									</>
								) : undefined
							}
						/>
						<DetailMeta>
							<Icon as={Tag} />
							<Text>v{detail.data.version}</Text>
							<Icon as={FileText} />
							<Text>{detail.data.file_count} files</Text>
						</DetailMeta>
						{projectPanel}
						<DetailPanel className={webView(skillDetailClasses.instructionPanel)}>
							<WebView recipe={skillDetailClasses.headingStack}>
								<WebView recipe={skillDetailClasses.headingRow}>
									<Icon as={BookOpen} />
									<WebText recipe={skillDetailClasses.heading}>
										{t("libraryPort.instructionFile")}
									</WebText>
								</WebView>
								<WebText recipe={skillDetailClasses.subtitle}>
									{t("libraryPort.instructionDescription")}
								</WebText>
							</WebView>
							<Badge variant="secondary">
								<Text>{detail.data.file_count} files</Text>
							</Badge>
							{detail.data.content !== null ? (
								<Markdown content={stripFrontmatter(detail.data.content)} />
							) : (
								<Text>{t("skills.noContent")}</Text>
							)}
						</DetailPanel>
					</>
				) : null}

				{conflict ? (
					<AppText accessibilityRole="alert" className="text-destructive">
						{t("skills.conflict")}
					</AppText>
				) : null}
				{action.error ? (
					<AppText accessibilityRole="alert" className="text-destructive">
						{t("skills.failed")}
					</AppText>
				) : null}
			</AppScrollView>
			{confirmationDialog.dialog}
		</ReadScreen>
	);
}

export function NewSkillPage() {
	return <SkillEditorScreen create />;
}
