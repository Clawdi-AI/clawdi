"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
	BookOpen,
	Copy,
	ExternalLink,
	FileText,
	FolderKanban,
	Laptop,
	Pencil,
	Save,
	Sparkles,
	Tag,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbSegmentTitle, useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { agentDisplayName, cleanMachineName } from "@/components/dashboard/agent-label";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { resolveAgentProjectScope } from "@/components/dashboard/agent-project-scope";
import {
	fetchAgentScopedSkillDetail,
	resolveAgentSkillProjectAccess,
} from "@/components/dashboard/agent-skill-detail-scope";
import {
	AGENT_PROJECT_SKILLS_REFRESH_POLICY,
	agentSkillForegroundRefetchInterval,
} from "@/components/dashboard/agent-skills-query";
import { DetailBackLink } from "@/components/detail/back-link";
import { DetailMeta, DetailNotFound, DetailPanel, DetailStats } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { IconChip } from "@/components/icon-chip";
import { Markdown } from "@/components/markdown";
import { Stat } from "@/components/meta/stat";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { displayProjectName, ProjectIdentity } from "@/components/projects/project-metadata";
import { SendSkillDialog } from "@/components/skills/send-skill-dialog";
import { SkillRemovalDescription } from "@/components/skills/skill-removal-description";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { UnsavedNavigationGuard } from "@/components/unsaved-navigation-guard";
import { agentDetailQueryOptions } from "@/lib/agent-queries";
import {
	type AgentRouteSearch,
	agentProjectDetailHref,
	agentProjectResourceHref,
	agentSectionHref,
} from "@/lib/agent-routes";
import { ApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import { isApiNotFoundError } from "@/lib/api-errors";
import { decodeResourceRouteParam, projectResourceHref } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import { RESOURCE_TINT_CLASSES } from "@/lib/resource-identity";
import { skillCapabilities } from "@/lib/skill-authority";
import { useCommittedLocation } from "@/lib/use-committed-location";
import { cn, errorMessage, relativeTime } from "@/lib/utils";
import {
	removeDeletedSkillQueries,
	skillDetailQueryKey,
	skillDetailQueryPrefix,
	skillDetailViewState,
} from "@/pages/dashboard/skills/skill-query-cache";

// Strip the leading `---\n...\n---` YAML frontmatter so the markdown
// renderer doesn't show "name:" / "description:" lines (already
// rendered above in PageHeader) and so the closing
// `---` doesn't render as a stray `<hr>` next to the Separator.
function stripFrontmatter(raw: string): string {
	const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
	return m ? (m[1] ?? "") : raw;
}

// nuqs used to require a Suspense boundary here; router-owned search does
// not suspend, so the page renders directly.
export default function SkillDetailPage({ routeKey }: { routeKey: string }) {
	return <SkillDetailPageInner routeKey={routeKey} />;
}

function SkillDetailPageInner({ routeKey }: { routeKey: string }) {
	const skillKey = useMemo(() => decodeResourceRouteParam(routeKey), [routeKey]);
	return <SkillDetailContent skillKey={skillKey} />;
}

export function SkillDetailContent({
	skillKey,
	agentId,
	routeSearch,
}: {
	skillKey: string;
	agentId?: string | null;
	routeSearch?: AgentRouteSearch;
}) {
	const router = useRouter();
	const api = useApi();
	const $api = useOpenApi();
	const queryClient = useQueryClient();

	// Library routes keep their legacy resolver fallback for backwards
	// compatibility. Agent routes must resolve one explicit binding first and
	// only call the endpoint for the Project selected on the Project hub.
	// Router-validated search (one ownership system — not nuqs), from the
	// committed match so the page agrees with the rendered route.
	const { search: committedSearch } = useCommittedLocation();
	const projectIdParam = typeof committedSearch.project === "string" ? committedSearch.project : "";
	const isAgentScope = Boolean(agentId);
	const selectedProjectId = (
		isAgentScope && typeof routeSearch?.project === "string" ? routeSearch.project : projectIdParam
	).trim();
	const skillListHref = agentId
		? selectedProjectId
			? agentProjectResourceHref(agentId, selectedProjectId, "skills")
			: agentSectionHref(agentId, "projects")
		: projectResourceHref("skills");
	const skillListLabel = agentId && !selectedProjectId ? "Projects" : "Skills";
	const scopedBindings = useAgentProjectBindings(agentId, { enabled: isAgentScope });
	const scopedProjectError = useMemo<unknown | null>(() => {
		if (!isAgentScope || !scopedBindings.data) return null;
		try {
			resolveAgentProjectScope(scopedBindings.data);
			return null;
		} catch (error) {
			return error;
		}
	}, [isAgentScope, scopedBindings.data]);
	const scopedProjectAccess = useMemo(
		() => resolveAgentSkillProjectAccess(scopedBindings.data ?? [], selectedProjectId),
		[scopedBindings.data, selectedProjectId],
	);
	const bindingsResolved = !isAgentScope || scopedBindings.data !== undefined;
	const scopedSkillQueryEnabled =
		!isAgentScope ||
		(bindingsResolved &&
			!scopedProjectError &&
			scopedProjectAccess.kind === "bound" &&
			scopedProjectAccess.projectIds.length > 0);
	const projectionScope = agentId
		? `agent:${JSON.stringify([agentId, selectedProjectId])}`
		: "cloud";

	const skillQuery = useQuery({
		queryKey: skillDetailQueryKey(skillKey, selectedProjectId, projectionScope),
		// An empty key would interpolate to `GET /v1/skills/`, which the
		// backend's `{skill_key:path}` catch-all rejects with a 422.
		// Nothing useful can load without a key, so don't fire at all.
		enabled: skillKey.length > 0 && scopedSkillQueryEnabled,
		queryFn: async () => {
			if (isAgentScope) {
				if (scopedProjectAccess.kind !== "bound") {
					throw new Error("This Project is not available to this Agent.");
				}
				return fetchAgentScopedSkillDetail(
					scopedProjectAccess.projectIds,
					async (projectId) =>
						unwrap(
							await api.GET("/v1/projects/{project_id}/skills/{skill_key}", {
								params: { path: { project_id: projectId, skill_key: skillKey } },
							}),
						),
					isApiNotFoundError,
				);
			}
			if (selectedProjectId) {
				return unwrap(
					await api.GET("/v1/projects/{project_id}/skills/{skill_key}", {
						params: { path: { project_id: selectedProjectId, skill_key: skillKey } },
					}),
				);
			}
			return unwrap(
				await api.GET("/v1/skills/{skill_key}", { params: { path: { skill_key: skillKey } } }),
			);
		},
		refetchInterval: (query) =>
			agentSkillForegroundRefetchInterval(
				Boolean(agentId) && !isApiNotFoundError(query.state.error),
			),
		refetchIntervalInBackground: AGENT_PROJECT_SKILLS_REFRESH_POLICY.refetchIntervalInBackground,
		refetchOnWindowFocus: AGENT_PROJECT_SKILLS_REFRESH_POLICY.refetchOnWindowFocus,
	});
	const skill = skillQuery.data;
	const blockingBindingsError = isAgentScope
		? shouldBlockQueryError(scopedBindings.error, scopedBindings.data)
			? scopedBindings.error
			: null
		: null;
	const agentAccessError = blockingBindingsError ?? scopedProjectError;
	const agentProjectUnavailable =
		isAgentScope && bindingsResolved && !scopedProjectError && scopedProjectAccess.kind !== "bound";
	const skillIsLoading =
		(isAgentScope && !bindingsResolved && !agentAccessError) ||
		(!agentAccessError && !agentProjectUnavailable && skillQuery.isLoading);

	const agentEnvironmentId = agentId ?? skill?.environment_id ?? null;
	const { data: skillAgent } = useQuery({
		...agentDetailQueryOptions($api, queryClient, agentEnvironmentId ?? ""),
		enabled: !!agentEnvironmentId,
	});
	const skillAgentLabel = skillAgent
		? agentDisplayName(skillAgent)
		: skill?.machine_name
			? cleanMachineName(skill.machine_name)
			: null;
	const breadcrumbTitle = skill?.name || (skill ? skillKey : null);
	useSetBreadcrumbTitle(breadcrumbTitle);

	// Browser writes require the exact Project selected by the URL. A released
	// key-only URL remains readable through the compatibility resolver, but its
	// inferred response must never become authority for a modern Web mutation.
	const targetProjectId =
		selectedProjectId && skill?.project_id === selectedProjectId ? selectedProjectId : null;
	const isProjectReady = !!targetProjectId;

	// Persisted authority and durable Project kind jointly control every
	// browser mutation. In particular, environment-kind Projects stay
	// read-only even after Agent deletion clears origin_environment_id.
	const { data: projects } = $api.useQuery("get", "/v1/projects", {});
	const skillProject = useMemo(
		() =>
			skill?.project_id
				? (projects?.find((project) => project.id === skill.project_id) ?? null)
				: null,
		[projects, skill?.project_id],
	);
	const selectedBinding = scopedBindings.data?.find(
		(binding) => binding.project_id === selectedProjectId,
	);
	const breadcrumbProjectTitle =
		selectedBinding?.binding_type === "primary"
			? "Workspace"
			: skillProject
				? displayProjectName(skillProject)
				: skill?.project_name?.trim() || null;
	useSetBreadcrumbSegmentTitle(
		agentId && selectedProjectId ? agentProjectDetailHref(agentId, selectedProjectId) : null,
		breadcrumbProjectTitle,
		selectedBinding?.binding_type === "primary" ? "workspace" : undefined,
	);
	const capabilities = skill
		? skillCapabilities(skill, projects === undefined ? undefined : skillProject)
		: null;
	const accessKnown =
		!skill?.project_id ||
		skill.authority === "agent_sync" ||
		skill.project_kind === "environment" ||
		projects !== undefined;
	const needsExplicitProject =
		!isAgentScope && !selectedProjectId && Boolean(skill?.project_id && capabilities?.canUpdate);
	const isReadOnly = capabilities ? !capabilities.canUpdate || !isProjectReady : true;
	const sourceProjectName = skillProject
		? displayProjectName(skillProject)
		: skill?.project_name?.trim() || null;

	const [isEditing, setIsEditing] = useState(false);
	const [draftName, setDraftName] = useState("");
	const [draftDescription, setDraftDescription] = useState("");
	const [draftInstructions, setDraftInstructions] = useState("");
	// Capture the content_hash at EDIT-START so the If-Match
	// precondition matches the version the user actually saw.
	// Storing it on save instead would let a background refetch
	// (window focus, query invalidation, daemon SSE event) update
	// `skill.content_hash` to the server's latest snapshot — the
	// 412 guard would then erroneously match and silently
	// overwrite a sibling edit. Cleared on cancel/save.
	const [editingHash, setEditingHash] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const startEdit = () => {
		if (!capabilities?.canUpdate) {
			toast.error("This Skill is read-only here");
			return;
		}
		if (!targetProjectId) {
			toast.error("Open this Skill from a Project before editing it");
			return;
		}
		if (!skill?.content) {
			toast.error("This Skill has no instructions to edit");
			return;
		}
		setDraftName(skill.name);
		setDraftDescription(skill.description ?? "");
		setDraftInstructions(stripFrontmatter(skill.content).trim());
		setEditingHash(skill.content_hash ?? null);
		setIsEditing(true);
	};
	const cancelEdit = () => {
		setIsEditing(false);
		setDraftName("");
		setDraftDescription("");
		setDraftInstructions("");
		setEditingHash(null);
	};

	// Auto-focus the textarea when editing opens. Without this the
	// user has to click into it, which feels broken on a "click Edit"
	// flow.
	useEffect(() => {
		if (isEditing) textareaRef.current?.focus();
	}, [isEditing]);

	const saveEdit = useMutation({
		mutationFn: async () => {
			if (!targetProjectId) throw new Error("No project available for this skill");
			if (!capabilities?.canUpdate) throw new Error("This Skill is read-only here");
			if (!editingHash) throw new Error("Reload this Skill before saving");
			// `content_hash` here is an If-Match PRECONDITION — the
			// hash the editor saw when this page loaded, NOT the
			// new content's hash. The backend route accepts it as
			// `expected_content_hash` and 412s if the row's current
			// hash differs (a sibling tab or Cloud upload landed in
			// the meantime). Without this, two
			// concurrent edits last-write-win and one user's
			// change gets silently overwritten. The new tar's
			// hash is still computed server-side from the bytes,
			// so passing the loaded hash here doesn't make the
			// upload short-circuit as "unchanged".
			return unwrap(
				await api.PUT("/v1/projects/{project_id}/skills/{skill_key}/content", {
					params: { path: { project_id: targetProjectId, skill_key: skillKey } },
					body: {
						name: draftName.trim(),
						description: draftDescription.trim() || null,
						instructions: draftInstructions.trim(),
						content_hash: editingHash,
					},
				}),
			);
		},
		onSuccess: () => {
			toast.success("Skill saved", {
				description: "The Project Skill was updated.",
			});
			setIsEditing(false);
			setDraftName("");
			setDraftDescription("");
			setDraftInstructions("");
			setEditingHash(null);
			queryClient.invalidateQueries({ queryKey: skillDetailQueryPrefix(skillKey) });
			queryClient.invalidateQueries({ queryKey: ["skills"] });
		},
		onError: (e) => {
			// 412 stale_content: someone else's edit landed while
			// this tab was open. Tell the user verbatim and
			// invalidate so the editor reloads fresh content
			// before a retry — without that hint the toast just
			// says "Failed to save" and the user keeps clicking
			// save against a hash the server keeps rejecting.
			if (e instanceof ApiError && e.status === 412) {
				toast.error("Skill changed elsewhere", {
					description:
						"Another edit landed while you were typing. Reload to see the latest, then re-apply your change.",
				});
				queryClient.invalidateQueries({ queryKey: skillDetailQueryPrefix(skillKey) });
				return;
			}
			toast.error("Couldn't save skill", { description: errorMessage(e) });
		},
	});

	const uninstall = useMutation({
		mutationFn: async () => {
			if (!targetProjectId) throw new Error("Project not loaded yet");
			if (!capabilities?.canDelete) throw new Error("This Skill is read-only here");
			return unwrap(
				await api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
					params: { path: { project_id: targetProjectId, skill_key: skillKey } },
				}),
			);
		},
		onSuccess: async () => {
			toast.success("Skill removed from Project", {
				description: sourceProjectName
					? `Removed from ${sourceProjectName}. Other Projects keep their copies.`
					: "Removed from this Project. Other Projects keep their copies.",
			});
			await removeDeletedSkillQueries(queryClient, skillKey);
			void router.navigate({ href: skillListHref });
		},
		onError: (e) =>
			toast.error("Couldn't remove Skill from Project", { description: errorMessage(e) }),
	});

	const onUninstall = () => {
		if (!isProjectReady || !accessKnown) {
			toast.error("Project access unavailable", { description: "Try again in a moment." });
			return;
		}
		if (!capabilities?.canDelete) {
			toast.error("This Skill is read-only here");
			return;
		}
		uninstall.mutate();
	};

	const isAgentSyncProjection = skill?.authority === "agent_sync";
	const agentCaption = isAgentSyncProjection
		? skillAgentLabel
			? `synced from ${skillAgentLabel}`
			: "synced from Agent"
		: sourceProjectName
			? `in ${sourceProjectName}`
			: null;
	const skillBody = useMemo(() => stripFrontmatter(skill?.content ?? "").trim(), [skill?.content]);
	const viewState = skillDetailViewState({
		skillKey,
		error: skillQuery.error,
		hasSkill: Boolean(skill),
		isLoading: skillIsLoading,
	});

	const editDirty =
		isEditing &&
		skill != null &&
		(draftName.trim() !== skill.name ||
			draftDescription.trim() !== (skill.description ?? "") ||
			draftInstructions.trim() !== stripFrontmatter(skill.content ?? "").trim());

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
			<UnsavedNavigationGuard dirty={editDirty} busy={saveEdit.isPending} />
			<DetailBackLink
				href={skillListHref}
				label={skillListLabel}
				mobileOnly={viewState === "detail"}
			/>
			{agentAccessError ? (
				<ApiErrorPanel
					error={agentAccessError}
					onRetry={() => {
						void scopedBindings.refetch();
					}}
					title="Couldn't load Agent Skill access"
				/>
			) : agentProjectUnavailable ? (
				<DetailNotFound
					title="Project not available to this Agent"
					message={
						scopedProjectAccess.kind === "unavailable"
							? "The Workspace is not available yet. Return to Projects and try again."
							: "The requested Project is not available through this Agent. Choose an available Project first."
					}
				/>
			) : viewState === "missing-key" ? (
				<DetailNotFound title="Skill not found" message="The URL is missing a skill key." />
			) : viewState === "not-found" ? (
				<DetailNotFound
					title="Skill not found"
					message={
						isAgentScope
							? "This Skill was not found in this Agent's Projects."
							: errorMessage(skillQuery.error)
					}
				/>
			) : viewState === "error" ? (
				<ApiErrorPanel
					error={skillQuery.error}
					onRetry={() => {
						void skillQuery.refetch();
					}}
					title="Couldn't load skill"
				/>
			) : viewState === "loading" ? (
				<div className="space-y-3 py-2" data-testid="agent-skill-detail-loading">
					<PageHeaderSkeleton icon actions />
				</div>
			) : viewState === "detail" && skill ? (
				<>
					{needsExplicitProject ? (
						<Alert>
							<AlertTitle>Choose a Project to make changes</AlertTitle>
							<AlertDescription>
								This older link is view-only. Open the Skill from a Project&apos;s Skills page to
								edit or remove that exact copy.
							</AlertDescription>
						</Alert>
					) : null}
					<PageHeader
						title={skill.name}
						icon={
							<IconChip tint={RESOURCE_TINT_CLASSES.skills}>
								<Sparkles />
							</IconChip>
						}
						description={skill.description ?? undefined}
						titleAdornment={
							accessKnown && isReadOnly ? (
								<Badge
									variant="secondary"
									title={
										needsExplicitProject
											? "Open this Skill from a Project to make changes."
											: "This Skill must be changed from its source."
									}
								>
									{needsExplicitProject
										? "Choose project"
										: (capabilities?.badgeLabel ?? "Read-only")}
								</Badge>
							) : undefined
						}
						actions={
							!accessKnown || isReadOnly ? undefined : !isEditing ? (
								<>
									<SendSkillDialog skill={skill}>
										<Button variant="outline" size="sm">
											<Copy />
											Copy or move
										</Button>
									</SendSkillDialog>
									<Button
										variant="outline"
										size="sm"
										onClick={startEdit}
										disabled={!skill.content || !isProjectReady}
										title={
											!skill.content
												? "No instructions are available for this Skill yet"
												: !isProjectReady
													? "Project unavailable"
													: undefined
										}
									>
										<Pencil />
										Edit
									</Button>
									<ConfirmAction
										title={`Remove ${skill.name} from Project?`}
										description={<SkillRemovalDescription projectName={sourceProjectName} />}
										confirmLabel="Remove from project"
										destructive
										onConfirm={onUninstall}
									>
										<Button
											variant="outline"
											size="sm"
											disabled={uninstall.isPending || !isProjectReady}
											title={!isProjectReady ? "Project unavailable" : undefined}
											className="text-destructive hover:text-destructive"
										>
											<Trash2 />
											Remove from project
										</Button>
									</ConfirmAction>
								</>
							) : (
								<>
									<Button
										variant="outline"
										size="sm"
										onClick={cancelEdit}
										disabled={saveEdit.isPending}
									>
										<X />
										Cancel
									</Button>
									<Button
										size="sm"
										onClick={() => saveEdit.mutate()}
										disabled={
											saveEdit.isPending ||
											!draftName.trim() ||
											!draftInstructions.trim() ||
											(draftName.trim() === skill.name &&
												draftDescription.trim() === (skill.description ?? "") &&
												draftInstructions.trim() === stripFrontmatter(skill.content ?? "").trim())
										}
									>
										<Save />
										{saveEdit.isPending ? "Saving…" : "Save"}
									</Button>
								</>
							)
						}
						status={
							<DetailMeta>
								<span>{isAgentSyncProjection ? "Workspace Skill" : "Project Skill"}</span>
								{skill.source_repo ? (
									<>
										<span>·</span>
										<a
											href={`https://github.com/${skill.source_repo}`}
											target="_blank"
											rel="noreferrer"
											className="inline-flex items-center gap-1 hover:text-foreground"
										>
											{skill.source_repo}
											<ExternalLink className="size-3" />
										</a>
									</>
								) : null}
								{agentCaption ? (
									<>
										<span>·</span>
										<span className="inline-flex items-center gap-1">
											<Laptop className="size-3" />
											{agentCaption}
										</span>
									</>
								) : null}
								{skill.created_at ? (
									<>
										<span>·</span>
										<span>
											{isAgentSyncProjection ? "synced" : "added"} {relativeTime(skill.created_at)}
										</span>
									</>
								) : null}
							</DetailMeta>
						}
					/>

					<DetailStats>
						<Stat icon={Tag} label={`v${skill.version}`} />
						<Stat
							icon={FileText}
							label={`${skill.file_count} file${skill.file_count === 1 ? "" : "s"}`}
						/>
					</DetailStats>

					<DetailPanel className="space-y-3">
						<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
							<div className="space-y-1">
								<div className="flex items-center gap-2">
									<FolderKanban className="size-4 text-muted-foreground" />
									<h2 className="text-sm font-semibold">Project</h2>
								</div>
								<p className="text-xs text-muted-foreground">
									{isAgentSyncProjection
										? "This Skill is synced from the Agent and is read-only here. Manage it on the Agent."
										: "This Skill belongs to this Project. Linked Agents use it automatically."}
								</p>
							</div>
							<Badge variant={isReadOnly ? "secondary" : "outline"}>
								{isReadOnly ? "Read-only" : "Editable"}
							</Badge>
						</div>
						{skillProject ? (
							<ProjectIdentity project={skillProject} showAccess titleClassName="text-sm" />
						) : sourceProjectName ? (
							<div className="rounded-md border bg-background/70 px-3 py-2.5">
								<div className="text-sm font-medium">{sourceProjectName}</div>
								<p className="mt-1 text-xs text-muted-foreground">
									Project details are still loading.
								</p>
							</div>
						) : (
							<EmptyState
								variant="inset"
								description="No Project information is available for this Skill."
							/>
						)}
					</DetailPanel>

					{isEditing ? (
						<DetailPanel className="space-y-4">
							<div>
								<h2 className="text-sm font-semibold">Edit skill</h2>
								<p className="mt-1 text-xs text-muted-foreground">
									Saving updates this Project Skill. Linked Agents receive the new version
									automatically, and imported support files stay attached.
								</p>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="edit-skill-name">Name</Label>
								<Input
									id="edit-skill-name"
									value={draftName}
									onChange={(event) => setDraftName(event.target.value)}
									maxLength={200}
									disabled={saveEdit.isPending}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="edit-skill-description">
									Description <span className="text-muted-foreground">(optional)</span>
								</Label>
								<Input
									id="edit-skill-description"
									value={draftDescription}
									onChange={(event) => setDraftDescription(event.target.value)}
									maxLength={2000}
									disabled={saveEdit.isPending}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="edit-skill-instructions">Instructions</Label>
								<Textarea
									ref={textareaRef}
									id="edit-skill-instructions"
									name="skill-instructions"
									value={draftInstructions}
									onChange={(event) => setDraftInstructions(event.target.value)}
									className="min-h-[420px] text-sm leading-relaxed"
									autoComplete="off"
									disabled={saveEdit.isPending}
								/>
							</div>
						</DetailPanel>
					) : skill.content ? (
						<DetailPanel className="space-y-4">
							<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
								<div className="space-y-1">
									<div className="flex items-center gap-2">
										<BookOpen className="size-4 text-muted-foreground" />
										<h2 className="text-sm font-semibold">Instruction file</h2>
									</div>
									<p className="text-xs text-muted-foreground">
										{isAgentSyncProjection
											? "This Skill belongs to the Agent's Workspace. Edit it on the Agent."
											: "This instruction file belongs to the Project. Linked Agents use updates automatically."}
									</p>
								</div>
								<Badge variant="secondary">
									{skill.file_count} file{skill.file_count === 1 ? "" : "s"}
								</Badge>
							</div>
							{skillBody ? (
								<div className="prose prose-sm max-w-none dark:prose-invert">
									<Markdown content={skillBody} />
								</div>
							) : (
								<EmptyState
									variant="inset"
									description="This Skill has no additional instructions."
								/>
							)}
						</DetailPanel>
					) : (
						<DetailPanel className="space-y-4">
							<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
								<div className="space-y-1">
									<div className="flex items-center gap-2">
										<BookOpen className="size-4 text-muted-foreground" />
										<h2 className="text-sm font-semibold">Instruction file</h2>
									</div>
									<p className="text-xs text-muted-foreground">
										{isAgentSyncProjection
											? "This Skill was synced from the Agent, but its instructions are not available yet."
											: "This Project Skill has no editable instruction body."}
									</p>
								</div>
								<Badge variant="secondary">
									{skill.file_count} file{skill.file_count === 1 ? "" : "s"}
								</Badge>
							</div>
							<EmptyState
								variant="inset"
								description={
									isAgentSyncProjection
										? "The preview will appear after the Agent syncs its Skill files."
										: "This Skill has no instructions."
								}
							/>
						</DetailPanel>
					)}
				</>
			) : null}
		</div>
	);
}
