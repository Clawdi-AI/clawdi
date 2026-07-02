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
import { useSetBreadcrumbSegmentTitle, useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { cleanMachineName } from "@/components/dashboard/agent-label";
import {
	DetailMeta,
	DetailNotFound,
	DetailPanel,
	DetailStats,
	DetailTitle,
} from "@/components/detail/layout";
import { Markdown } from "@/components/markdown";
import { Stat } from "@/components/meta/stat";
import { isProjectOwner, ProjectIdentity } from "@/components/projects/project-metadata";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { agentSectionHref } from "@/lib/agent-routes";
import { ApiError, unwrap, useApi } from "@/lib/api";
import { decodeResourceRouteParam, projectResourceHref } from "@/lib/project-resource-model";
import { errorMessage, relativeTime } from "@/lib/utils";

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
}: {
	skillKey: string;
	agentId?: string | null;
}) {
	const router = useRouter();
	const api = useApi();
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
		? agentSectionHref(agentId, "skills")
		: projectResourceHref("skills");

	const {
		data: skill,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["skill", skillKey, selectedProjectId],
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
	});

	const breadcrumbTitle = skill?.name || (skill ? skillKey : null);
	const agentTitle = skill?.machine_name ? cleanMachineName(skill.machine_name) : null;
	useSetBreadcrumbSegmentTitle(agentId ? agentSectionHref(agentId) : null, agentTitle);
	useSetBreadcrumbTitle(breadcrumbTitle);

	const { data: defaultProject, error: projectError } = useQuery({
		queryKey: ["projects", "default"],
		queryFn: async () => unwrap(await api.GET("/v1/projects/default")),
	});
	// Edits land in the skill's own project when the detail response
	// carries one (multi-machine accounts), falling back to the
	// caller's default project (single-machine accounts and legacy
	// rows). Falling back to defaultProject is also what the delete
	// path does, so the editor stays consistent with uninstall.
	const targetProjectId = skill?.project_id ?? defaultProject?.project_id ?? null;
	const isProjectReady = !!targetProjectId;

	// Shared-project skills are read-only from this viewer's perspective:
	// hide Edit/Uninstall (would 403 from the backend), surface a
	// "shared" badge with the owner's project as the source. Re-uses the
	// same is_owner cross-reference pattern as /vault and /skills.
	const { data: ownedProjects } = useQuery({
		queryKey: ["projects"],
		queryFn: async () => unwrap(await api.GET("/v1/projects")),
	});
	const ownedProjectIds = useMemo(
		() =>
			new Set(
				(ownedProjects ?? [])
					.filter((project) => isProjectOwner(project))
					.map((project) => project.id),
			),
		[ownedProjects],
	);
	const ownershipKnown = !skill?.project_id || ownedProjects !== undefined;
	const isReadOnly =
		ownershipKnown && !!skill?.project_id && !ownedProjectIds.has(skill.project_id);

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
			// `content_hash` here is an If-Match PRECONDITION — the
			// hash the editor saw when this page loaded, NOT the
			// new content's hash. The backend route accepts it as
			// `expected_content_hash` and 412s if the row's current
			// hash differs (a sibling tab / daemon / dashboard
			// edit landed in the meantime). Without this, two
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
				description: skill?.machine_name
					? `${skill.machine_name} picks up the new version within a couple seconds via sync.`
					: "The change applies on this agent within a couple seconds via sync.",
			});
			setIsEditing(false);
			setDraft("");
			setEditingHash(null);
			queryClient.invalidateQueries({ queryKey: ["skill", skillKey] });
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
				queryClient.invalidateQueries({ queryKey: ["skill", skillKey] });
				return;
			}
			toast.error("Couldn't save skill", { description: errorMessage(e) });
		},
	});

	const uninstall = useMutation({
		mutationFn: async () => {
			if (!targetProjectId) throw new Error("Project not loaded yet");
			return unwrap(
				await api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
					params: { path: { project_id: targetProjectId, skill_key: skillKey } },
				}),
			);
		},
		onSuccess: () => {
			toast.success("Skill Uninstalled", {
				description: skill?.machine_name
					? `Removed from ${skill.machine_name}. Other agents keep their copies.`
					: "Removed from this agent. Other agents keep their copies.",
			});
			queryClient.invalidateQueries({ queryKey: ["skills"] });
			void router.navigate({ href: skillListHref });
		},
		onError: (e) => toast.error("Couldn't uninstall skill", { description: errorMessage(e) }),
	});

	const onUninstall = () => {
		if (!isProjectReady || !ownershipKnown) {
			toast.error("Project Access Unavailable", { description: "Try again in a moment." });
			return;
		}
		if (isReadOnly) {
			toast.error("Shared Skills Are Read-only");
			return;
		}
		uninstall.mutate();
	};

	const sourceProjectName = skill?.project_name ?? null;
	const uninstallLocation = skill?.machine_name ? `from ${skill.machine_name}` : "from this agent";
	const agentCaption = skill?.machine_name
		? `on ${skill.machine_name}`
		: sourceProjectName
			? `in ${sourceProjectName}`
			: null;
	const skillBody = useMemo(() => stripFrontmatter(skill?.content ?? "").trim(), [skill?.content]);
	const skillProject = useMemo(
		() =>
			skill?.project_id
				? (ownedProjects?.find((project) => project.id === skill.project_id) ?? null)
				: null,
		[ownedProjects, skill?.project_id],
	);

	return (
		<div className="space-y-5 px-4 lg:px-6">
			{!skillKey ? (
				<DetailNotFound title="Skill not found" message="The URL is missing a skill key." />
			) : error ? (
				<DetailNotFound title="Skill not found" message={errorMessage(error)} />
			) : isLoading ? (
				<div className="space-y-3 py-2">
					<Skeleton className="h-6 w-48" />
					<Skeleton className="h-4 w-64" />
				</div>
			) : skill ? (
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
								{!ownershipKnown ? null : isReadOnly ? (
									<Badge
										variant="secondary"
										title={
											sourceProjectName
												? `Shared from "${sourceProjectName}". Viewer access is read-only.`
												: "Shared from another Project. Viewer access is read-only."
										}
									>
										Shared · Read-only
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
							<p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
								No Project information is available for this Skill.
							</p>
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
								<p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
									No additional instruction body is stored for this Skill.
								</p>
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
							<p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
								When the agent uploads the Skill file content, the preview and editor will appear
								here.
							</p>
						</DetailPanel>
					)}
				</>
			) : null}
		</div>
	);
}
