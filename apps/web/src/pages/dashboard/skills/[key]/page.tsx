"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
	ArrowLeft,
	BookOpen,
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
import { parseAsString, useQueryState } from "nuqs";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
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
import {
	DetailMeta,
	DetailNotFound,
	DetailPanel,
	DetailStats,
	DetailTitle,
} from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { Markdown } from "@/components/markdown";
import { Stat } from "@/components/meta/stat";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { ProjectIdentity } from "@/components/projects/project-metadata";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
	type AgentRouteSearch,
	agentDeploymentRouteQuery,
	agentProjectResourceHref,
	agentSectionHref,
} from "@/lib/agent-routes";
import { ApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import { isApiNotFoundError } from "@/lib/api-errors";
import { decodeResourceRouteParam, projectResourceHref } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import { skillCapabilities } from "@/lib/skill-authority";
import { cn, errorMessage, relativeTime } from "@/lib/utils";
import {
	removeDeletedSkillQueries,
	skillDetailQueryKey,
	skillDetailQueryPrefix,
	skillDetailViewState,
} from "@/pages/dashboard/skills/skill-query-cache";

// Strip the leading `---\n...\n---` YAML frontmatter so the markdown
// renderer doesn't show "name:" / "description:" lines (already
// rendered above as DetailTitle + description) and so the closing
// `---` doesn't render as a stray `<hr>` next to the Separator.
function stripFrontmatter(raw: string): string {
	const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
	return m ? (m[1] ?? "") : raw;
}

// Wrap the inner URL-state tree in Suspense. Mirrors the same pattern in
// /skills/page.tsx and /cli-authorize.
export default function SkillDetailPage({ routeKey }: { routeKey: string }) {
	return (
		<Suspense fallback={null}>
			<SkillDetailPageInner routeKey={routeKey} />
		</Suspense>
	);
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
	const [projectIdParam] = useQueryState("project", parseAsString.withDefault(""));
	const isAgentScope = Boolean(agentId);
	const selectedProjectId = (
		isAgentScope && typeof routeSearch?.project === "string" ? routeSearch.project : projectIdParam
	).trim();
	const skillListHref = agentId
		? selectedProjectId
			? agentProjectResourceHref(
					agentId,
					selectedProjectId,
					"skills",
					agentDeploymentRouteQuery(routeSearch),
				)
			: agentSectionHref(agentId, "projects", agentDeploymentRouteQuery(routeSearch))
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
	const { data: skillAgent } = $api.useQuery(
		"get",
		"/v1/agents/{agent_id}",
		{
			params: { path: { agent_id: agentEnvironmentId ?? "" } },
		},
		{
			enabled: !!agentEnvironmentId,
		},
	);
	const skillAgentLabel = skillAgent
		? agentDisplayName(skillAgent)
		: skill?.machine_name
			? cleanMachineName(skill.machine_name)
			: null;
	const breadcrumbTitle = skill?.name || (skill ? skillKey : null);
	useSetBreadcrumbSegmentTitle(agentId ? agentSectionHref(agentId) : null, skillAgentLabel);
	useSetBreadcrumbTitle(breadcrumbTitle);

	const { data: defaultProject, error: projectError } = $api.useQuery(
		"get",
		"/v1/projects/default",
		{},
		{ enabled: !isAgentScope },
	);
	// Edits land in the skill's own project when the detail response
	// carries one (multi-machine accounts), falling back to the
	// caller's default project (single-machine accounts and legacy
	// rows). Falling back to defaultProject is also what the delete
	// path does, so the editor stays consistent with uninstall.
	const targetProjectId = skill?.project_id ?? defaultProject?.project_id ?? null;
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
	const capabilities = skill
		? skillCapabilities(skill, projects === undefined ? undefined : skillProject)
		: null;
	const accessKnown =
		!skill?.project_id ||
		skill.authority === "agent_sync" ||
		skill.project_kind === "environment" ||
		projects !== undefined;
	const isReadOnly = capabilities ? !capabilities.canUpdate : true;

	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState("");
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
			toast.error("This Skill is read-only in Cloud");
			return;
		}
		if (!skill?.content) {
			toast.error("No Skill Content Yet");
			return;
		}
		setDraft(skill.content);
		setEditingHash(skill.content_hash ?? null);
		setIsEditing(true);
	};
	const cancelEdit = () => {
		setIsEditing(false);
		setDraft("");
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
			if (!capabilities?.canUpdate) throw new Error("This Skill is read-only in Cloud");
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
					body: { content: draft, content_hash: editingHash ?? undefined },
				}),
			);
		},
		onSuccess: () => {
			toast.success("Skill Saved", {
				description: "The Cloud-owned Skill content was updated.",
			});
			setIsEditing(false);
			setDraft("");
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
				toast.error("Skill Changed Elsewhere", {
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
			if (!capabilities?.canDelete) throw new Error("This Skill is read-only in Cloud");
			return unwrap(
				await api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
					params: { path: { project_id: targetProjectId, skill_key: skillKey } },
				}),
			);
		},
		onSuccess: async () => {
			toast.success("Skill removed from Project", {
				description: skill?.project_name
					? `Removed from ${skill.project_name}. Other Projects keep their copies.`
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
			toast.error("Project Access Unavailable", { description: "Try again in a moment." });
			return;
		}
		if (!capabilities?.canDelete) {
			toast.error("This Skill is read-only in Cloud");
			return;
		}
		uninstall.mutate();
	};

	const sourceProjectName = skill?.project_name ?? null;
	const uninstallLocation = sourceProjectName ? `from ${sourceProjectName}` : "from this Project";
	const isAgentSyncProjection = skill?.authority === "agent_sync";
	const agentCaption = isAgentSyncProjection
		? skillAgentLabel
			? `synced from ${skillAgentLabel}`
			: "synced from Agent runtime"
		: sourceProjectName
			? `stored in ${sourceProjectName}`
			: null;
	const skillBody = useMemo(() => stripFrontmatter(skill?.content ?? "").trim(), [skill?.content]);
	const viewState = skillDetailViewState({
		skillKey,
		error: skillQuery.error,
		hasSkill: Boolean(skill),
		isLoading: skillIsLoading,
	});

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
			<Button
				render={<Link to={skillListHref} />}
				nativeButton={false}
				variant="ghost"
				size="sm"
				className="w-fit"
			>
				<ArrowLeft className="size-4" />
				Back to {skillListLabel}
			</Button>
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
					<Skeleton className="h-6 w-48" />
					<Skeleton className="h-4 w-64" />
				</div>
			) : viewState === "detail" && skill ? (
				<>
					<div className="space-y-2">
						<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
							<div className="min-w-0 space-y-2">
								<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
									<Sparkles className="size-3.5" />
									<span>Skill</span>
								</div>
								<DetailTitle className="truncate">{skill.name}</DetailTitle>
							</div>
							<div className="flex w-full shrink-0 flex-wrap gap-2 sm:w-auto sm:justify-end">
								{!accessKnown ? null : isReadOnly ? (
									<Badge
										variant="secondary"
										title="Cloud mutations are disabled for this Skill's authority or Project."
									>
										{capabilities?.badgeLabel ?? "Read-only"}
									</Badge>
								) : !isEditing ? (
									<>
										<Button
											variant="outline"
											size="sm"
											onClick={startEdit}
											disabled={!skill.content || !isProjectReady}
											title={
												!skill.content
													? "No content stored for this skill yet"
													: projectError
														? `Project unavailable: ${errorMessage(projectError)}`
														: undefined
											}
										>
											<Pencil />
											Edit
										</Button>
										<ConfirmAction
											title={`Remove ${skill.name} from Project?`}
											description={
												<>
													<p>This removes the skill {uninstallLocation}.</p>
													<p>
														Other Projects keep their copies. Add it to this Project again if
														needed.
													</p>
												</>
											}
											confirmLabel="Remove from Project"
											destructive
											onConfirm={onUninstall}
										>
											<Button
												variant="outline"
												size="sm"
												disabled={uninstall.isPending || !isProjectReady}
												title={
													projectError
														? `Project unavailable: ${errorMessage(projectError)}`
														: undefined
												}
												className="text-destructive hover:text-destructive"
											>
												<Trash2 />
												Remove from Project
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
											disabled={saveEdit.isPending || draft.length === 0 || draft === skill.content}
										>
											<Save />
											{saveEdit.isPending ? "Saving…" : "Save"}
										</Button>
									</>
								)}
							</div>
						</div>
						<DetailMeta>
							<span>{skill.source}</span>
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
					</div>

					<DetailStats>
						<Stat icon={Tag} label={`v${skill.version}`} />
						<Stat
							icon={FileText}
							label={`${skill.file_count} file${skill.file_count === 1 ? "" : "s"}`}
						/>
					</DetailStats>

					{skill.description ? (
						<p className="text-sm text-muted-foreground">{skill.description}</p>
					) : null}

					<DetailPanel className="space-y-3">
						<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
							<div className="space-y-1">
								<div className="flex items-center gap-2">
									<FolderKanban className="size-4 text-muted-foreground" />
									<h2 className="text-sm font-semibold">Project storage</h2>
								</div>
								<p className="text-xs text-muted-foreground">
									{isAgentSyncProjection
										? "This Skill is synced from the Agent and is read-only here. Manage it on the Agent."
										: "This Skill is stored and managed in this Project. Install it on an Agent separately to run it."}
								</p>
							</div>
							<Badge variant={isReadOnly ? "secondary" : "outline"}>
								{isReadOnly ? "Read-only" : "Editable"}
							</Badge>
						</div>
						{skillProject ? (
							<ProjectIdentity
								project={skillProject}
								showOwner
								showAccess
								titleClassName="text-sm"
							/>
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
							<Alert>
								<AlertTitle>Editing the Skill File</AlertTitle>
								<AlertDescription>
									Keep the YAML header at the top intact. It stores the skill name and description.
									Save updates only the Skill stored in this Project. Install it on an Agent
									separately to run the new content.
								</AlertDescription>
							</Alert>
							<Textarea
								ref={textareaRef}
								name="skill-content"
								aria-label="Skill content"
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								className="min-h-[480px] font-mono text-sm leading-relaxed"
								autoComplete="off"
								spellCheck={false}
								disabled={saveEdit.isPending}
							/>
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
											? "This read-only instruction file was projected from the Agent runtime."
											: "This instruction file is stored in the Project. Install the Skill on an Agent separately to run it."}
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
									description="No additional instruction body is stored for this Skill."
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
											? "The Agent runtime reported this Skill, but its read-only projection does not include an instruction body yet."
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
										? "When the Agent uploads its Skill file content, the read-only preview will appear here."
										: "No instruction content is stored for this Skill."
								}
							/>
						</DetailPanel>
					)}
				</>
			) : null}
		</div>
	);
}
