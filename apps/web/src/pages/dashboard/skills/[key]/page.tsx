"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
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
	agentSectionHref,
} from "@/lib/agent-routes";
import { ApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import { isApiNotFoundError } from "@/lib/api-errors";
import { decodeResourceRouteParam, projectResourceHref } from "@/lib/project-resource-model";
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

	// `?project=<project_id>` is set by the skills list page when the
	// row knows its project. Without it, the legacy GET /api/skills/{key}
	// resolves multi-project by "most-recently-updated", which means a
	// multi-machine user clicking machine-B's row could load
	// machine-A's content and silently overwrite the wrong copy on
	// save. Routing the fetch through the project-explicit endpoint
	// when we have the project_id removes that ambiguity. Falls back
	// to the legacy endpoint for single-machine accounts (where
	// there's only one row, so the resolver is unambiguous).
	const [projectIdParam] = useQueryState("project", parseAsString.withDefault(""));
	const selectedProjectId = projectIdParam;
	const skillListHref = agentId
		? agentSectionHref(agentId, "skills", agentDeploymentRouteQuery(routeSearch))
		: projectResourceHref("skills");

	const {
		data: skill,
		isLoading,
		error,
		refetch,
	} = useQuery({
		queryKey: skillDetailQueryKey(
			skillKey,
			selectedProjectId,
			agentId ? `agent:${agentId}` : "cloud",
		),
		// An empty key would interpolate to `GET /v1/skills/`, which the
		// backend's `{skill_key:path}` catch-all rejects with a 422.
		// Nothing useful can load without a key, so don't fire at all.
		enabled: skillKey.length > 0,
		queryFn: async () => {
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
			toast.success("Skill Uninstalled", {
				description: skillAgentLabel
					? `Removed from ${skillAgentLabel}. Other agents keep their copies.`
					: "Removed from this agent. Other agents keep their copies.",
			});
			await removeDeletedSkillQueries(queryClient, skillKey);
			void router.navigate({ href: skillListHref });
		},
		onError: (e) => toast.error("Couldn't uninstall skill", { description: errorMessage(e) }),
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
	const uninstallLocation = skillAgentLabel ? `from ${skillAgentLabel}` : "from this agent";
	const agentCaption = skillAgentLabel
		? `on ${skillAgentLabel}`
		: sourceProjectName
			? `in ${sourceProjectName}`
			: null;
	const skillBody = useMemo(() => stripFrontmatter(skill?.content ?? "").trim(), [skill?.content]);
	const viewState = skillDetailViewState({
		skillKey,
		error,
		hasSkill: Boolean(skill),
		isLoading,
	});

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
			{viewState === "missing-key" ? (
				<DetailNotFound title="Skill not found" message="The URL is missing a skill key." />
			) : viewState === "not-found" ? (
				<DetailNotFound title="Skill not found" message={errorMessage(error)} />
			) : viewState === "error" ? (
				<ApiErrorPanel
					error={error}
					onRetry={() => {
						void refetch();
					}}
					title="Couldn't load skill"
				/>
			) : viewState === "loading" ? (
				<div className="space-y-3 py-2">
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
														? `Default project unavailable: ${errorMessage(projectError)}`
														: undefined
											}
										>
											<Pencil />
											Edit
										</Button>
										<ConfirmAction
											title={`Uninstall ${skill.name}?`}
											description={
												<>
													<p>This removes the skill {uninstallLocation}.</p>
													<p>
														Your other agents keep their copies. To get it back here, re-install it
														from the marketplace.
													</p>
												</>
											}
											confirmLabel="Uninstall Skill"
											destructive
											onConfirm={onUninstall}
										>
											<Button
												variant="outline"
												size="sm"
												disabled={uninstall.isPending || !isProjectReady}
												title={
													projectError
														? `Default project unavailable: ${errorMessage(projectError)}`
														: undefined
												}
												className="text-destructive hover:text-destructive"
											>
												<Trash2 />
												Uninstall
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
									<span>installed {relativeTime(skill.created_at)}</span>
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
									<h2 className="text-sm font-semibold">Project availability</h2>
								</div>
								<p className="text-xs text-muted-foreground">
									Skills live in a Project. Agents can use this Skill when that Project is added to
									an agent.
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
									Save updates this Project and syncs to the agent.
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
										Agents read this file when the Project provides the Skill.
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
										The Skill is installed, but no editable instruction body is available from the
										current sync.
									</p>
								</div>
								<Badge variant="secondary">
									{skill.file_count} file{skill.file_count === 1 ? "" : "s"}
								</Badge>
							</div>
							<EmptyState
								variant="inset"
								description="When the agent uploads the Skill file content, the preview and editor will appear here."
							/>
						</DetailPanel>
					)}
				</>
			) : null}
		</div>
	);
}
