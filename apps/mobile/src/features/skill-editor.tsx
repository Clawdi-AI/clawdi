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
import { detailLayoutClasses, skillDetailClasses } from "@clawdi/shared/ui";
import { identityFor, RESOURCE_TINT_CLASSES, relativeTime } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import {
	BookOpen,
	Copy,
	FileText,
	FolderKanban,
	Pencil,
	Sparkles,
	Tag,
	Trash2,
} from "lucide-react-native";
import { useRef, useState } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ChoiceSelect } from "../ui/detail/choice-select";
import { DetailBackLink, DetailMeta, DetailPanel } from "../ui/detail/layout";
import { EntityHeader } from "../ui/entity-card";
import { ErrorState } from "../ui/feedback";
import { Icon } from "../ui/icon";
import { IconChip } from "../ui/icon-chip";
import { Input } from "../ui/input";
import { Markdown } from "../ui/markdown";
import { PageHeader, PageHeaderSkeleton } from "../ui/page-header";
import { AppScrollView, AppText, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { Text } from "../ui/text";
import { WebText, WebView, webText, webView } from "../ui/web-layout";

import { ProjectResourceBoundary } from "./project-scope";
import { useCloudProjects } from "./projects";
import { routeParam } from "./read-helpers";

type EditDraft = SkillTextDraft & { revision: string };
export function SkillEditorScreen({ create = false }: { create?: boolean }) {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{
		projectId?: string | string[];
		skillKey?: string | string[];
	}>();
	const projectId = routeParam(params.projectId);
	const skillKey = routeParam(params.skillKey);
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
		Alert.alert(t("profile.unsavedTitle"), t("skills.discardWarning"), [
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
		Alert.alert(t("skills.remove"), t("skills.removeWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("skills.remove"),
				style: "destructive",
				onPress: () => {
					if (signal.aborted || !scope.isCurrent() || !visible()) return;
					void action.run(async (isCurrent) => {
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
		]);
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
	return (
		<ReadScreen>
			<AppScrollView
				keyboardShouldPersistTaps="handled"
				contentContainerClassName={webView(detailLayoutClasses.detailPage)}
			>
				<DetailBackLink href="/skills" label={t("skills.title")} />
				{completed ? <AppText className="text-foreground">{t("skills.saved")}</AppText> : null}
				{create ? <PageHeader title={t("libraryPort.createSkill")} /> : null}
				{create ? (
					<ChoiceSelect
						disabled={action.busy}
						value={selectedId ?? ""}
						options={[
							{ value: "", label: t("projects.choose") },
							...writable.map((p) => ({ value: p.id, label: p.name })),
						]}
						onValueChange={setSelection}
					/>
				) : null}
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
				{draft ? (
					<AppView className="gap-3">
						{(["name", "description", "instructions"] as const).map((field) => (
							<AppView key={field} className="gap-2">
								<AppText className="text-foreground">{t(`skills.${field}`)}</AppText>
								<Input
									accessibilityLabel={t(`skills.${field}`)}
									value={draft[field]}
									editable={!disabled}
									multiline={field !== "name"}
									maxLength={field === "name" ? 64 : field === "description" ? 1024 : 204800}
									onChangeText={(value) => setDraft({ ...draft, [field]: value })}
								/>
							</AppView>
						))}
						<Button
							variant="default"
							size="sm"
							disabled={
								disabled ||
								conflict ||
								!draft.name.trim() ||
								!draft.description.trim() ||
								!draft.instructions.trim()
							}
							onPress={() => {
								void save();
							}}
						>
							<Text>{t("skills.save")}</Text>
						</Button>
						{!create ? (
							<Button
								variant="outline"
								size="sm"
								disabled={action.busy}
								onPress={() => {
									const visible = capture();
									const ticket = ++confirmation.current;
									Alert.alert(t("skills.discard"), t("skills.discardWarning"), [
										{ text: t("account.cancel"), style: "cancel" },
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
								<Text>{t("skills.discard")}</Text>
							</Button>
						) : null}
					</AppView>
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
								<EntityHeader
									icon={
										<IconChip size="xs" tint={identityFor(project.name).colorClasses}>
											{identityFor(project.name).emoji}
										</IconChip>
									}
									title={project.name}
									meta={project.description ?? ""}
								/>
							) : null}
						</DetailPanel>
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

				{create ? (
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
		</ReadScreen>
	);
}
