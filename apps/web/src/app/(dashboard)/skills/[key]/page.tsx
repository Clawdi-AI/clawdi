"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FileText, Laptop, Pencil, Save, Tag, Trash2, X } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { DetailMeta, DetailNotFound, DetailStats, DetailTitle } from "@/components/detail/layout";
import { Markdown } from "@/components/markdown";
import { Stat } from "@/components/meta/stat";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, unwrap, useApi } from "@/lib/api";
import { errorMessage, relativeTime } from "@/lib/utils";

// Strip the leading `---\n...\n---` YAML frontmatter so the markdown
// renderer doesn't show "name:" / "description:" lines (already
// rendered above as DetailTitle + description) and so the closing
// `---` doesn't render as a stray `<hr>` next to the Separator.
function stripFrontmatter(raw: string): string {
	const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
	return m ? (m[1] ?? "") : raw;
}

// Next 16 prerender bails out unless `useSearchParams()` lives
// inside a Suspense boundary. Wrap the inner client tree so the
// static shell prerenders cleanly while the param-aware part
// hydrates client-side. Mirrors the same pattern in
// /skills/page.tsx and /cli-authorize.
export default function SkillDetailPage() {
	return (
		<Suspense fallback={null}>
			<SkillDetailPageInner />
		</Suspense>
	);
}

function SkillDetailPageInner() {
	const { key } = useParams<{ key: string }>();
	const searchParams = useSearchParams();
	const router = useRouter();
	const api = useApi();
	const queryClient = useQueryClient();

	// `?scope=<scope_id>` is set by the skills list page when the
	// row knows its scope. Without it, the legacy GET /api/skills/{key}
	// resolves multi-scope by "most-recently-updated", which means a
	// multi-machine user clicking machine-B's row could load
	// machine-A's content and silently overwrite the wrong copy on
	// save. Routing the fetch through the scope-explicit endpoint
	// when we have the scope_id removes that ambiguity. Falls back
	// to the legacy endpoint for single-machine accounts (where
	// there's only one row, so the resolver is unambiguous).
	const scopeIdParam = searchParams.get("scope");

	const {
		data: skill,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["skill", key, scopeIdParam],
		queryFn: async () => {
			if (scopeIdParam) {
				return unwrap(
					await api.GET("/api/scopes/{scope_id}/skills/{skill_key}", {
						params: { path: { scope_id: scopeIdParam, skill_key: key } },
					}),
				);
			}
			return unwrap(
				await api.GET("/api/skills/{skill_key}", { params: { path: { skill_key: key } } }),
			);
		},
	});

	useSetBreadcrumbTitle(skill?.name || (skill ? key : null));

	const { data: defaultScope, error: scopeError } = useQuery({
		queryKey: ["scopes", "default"],
		queryFn: async () => unwrap(await api.GET("/api/scopes/default")),
	});
	// Edits land in the skill's own scope when the detail response
	// carries one (multi-machine accounts), falling back to the
	// caller's default scope (single-machine accounts and legacy
	// rows). Falling back to defaultScope is also what the delete
	// path does, so the editor stays consistent with uninstall.
	const targetScopeId = skill?.scope_id ?? defaultScope?.scope_id ?? null;
	const isScopeReady = !!targetScopeId;

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
			toast.error("This skill has no content to edit yet.");
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
			if (!targetScopeId) throw new Error("No scope available for this skill");
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
				await api.PUT("/api/scopes/{scope_id}/skills/{skill_key}/content", {
					params: { path: { scope_id: targetScopeId, skill_key: key } },
					body: { content: draft, content_hash: editingHash ?? undefined },
				}),
			);
		},
		onSuccess: () => {
			toast.success(
				skill?.machine_name
					? `Saved. ${skill.machine_name} picks up the new version within a couple seconds via sync.`
					: "Saved. The change applies on this agent within a couple seconds via sync.",
			);
			setIsEditing(false);
			setDraft("");
			setEditingHash(null);
			queryClient.invalidateQueries({ queryKey: ["skill", key] });
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
				queryClient.invalidateQueries({ queryKey: ["skill", key] });
				return;
			}
			toast.error("Failed to save", { description: errorMessage(e) });
		},
	});

	const uninstall = useMutation({
		mutationFn: async () => {
			if (!targetScopeId) throw new Error("Default scope not loaded yet");
			return unwrap(
				await api.DELETE("/api/scopes/{scope_id}/skills/{skill_key}", {
					params: { path: { scope_id: targetScopeId, skill_key: key } },
				}),
			);
		},
		onSuccess: () => {
			toast.success(
				skill?.machine_name
					? `Skill uninstalled from ${skill.machine_name}. Other agents keep their copies.`
					: "Skill uninstalled from this agent. Other agents keep their copies.",
			);
			queryClient.invalidateQueries({ queryKey: ["skills"] });
			router.push("/skills");
		},
		onError: (e) => toast.error("Failed to uninstall", { description: errorMessage(e) }),
	});

	const onUninstall = () => {
		if (!isScopeReady) {
			toast.error("Account scope unavailable — try again in a moment.");
			return;
		}
		// Per-agent isolation: this DELETE only removes the skill
		// from the current scope (one agent's copy). The same
		// skill_key on other agents stays untouched. Confirm copy
		// has to make that scope explicit so the user doesn't think
		// they're nuking it everywhere.
		const where = skill?.machine_name ? `from ${skill.machine_name}` : "from this agent";
		const ok = window.confirm(
			`Uninstall "${skill?.name ?? key}" ${where}?\n\n` +
				"Your other agents keep their copies. To get it back here, " +
				"re-install it from the marketplace.",
		);
		if (ok) uninstall.mutate();
	};

	const agentCaption = skill?.machine_name
		? `on ${skill.machine_name}`
		: skill?.scope_name
			? `in ${skill.scope_name}`
			: null;

	return (
		<div className="space-y-5 px-4 lg:px-6">
			{error ? (
				<DetailNotFound title="Skill not found" message={errorMessage(error)} />
			) : isLoading ? (
				<div className="space-y-3 py-2">
					<Skeleton className="h-6 w-48" />
					<Skeleton className="h-4 w-64" />
				</div>
			) : skill ? (
				<>
					<div className="space-y-2">
						<div className="flex items-start justify-between gap-3">
							<DetailTitle className="truncate">{skill.name}</DetailTitle>
							<div className="flex shrink-0 gap-2">
								{!isEditing ? (
									<>
										<Button
											variant="outline"
											size="sm"
											onClick={startEdit}
											disabled={!skill.content || !isScopeReady}
											title={
												!skill.content
													? "No content stored for this skill yet"
													: scopeError
														? `Account scope unavailable: ${errorMessage(scopeError)}`
														: undefined
											}
										>
											<Pencil />
											Edit
										</Button>
										<Button
											variant="outline"
											size="sm"
											onClick={onUninstall}
											disabled={uninstall.isPending || !isScopeReady}
											title={
												scopeError
													? `Account scope unavailable: ${errorMessage(scopeError)}`
													: undefined
											}
											className="text-destructive hover:text-destructive"
										>
											<Trash2 />
											Uninstall
										</Button>
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

					{isEditing ? (
						<>
							<Separator />
							<Alert>
								<AlertTitle>Editing the source-of-truth file</AlertTitle>
								<AlertDescription>
									Keep the YAML frontmatter (between the leading <code>---</code> markers) intact —
									it's how the agent finds and titles this skill. Save lands instantly in the cloud
									and reaches the agent within ~2 seconds.
								</AlertDescription>
							</Alert>
							<Textarea
								ref={textareaRef}
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								className="min-h-[480px] font-mono text-sm leading-relaxed"
								spellCheck={false}
								disabled={saveEdit.isPending}
							/>
						</>
					) : skill.content ? (
						<>
							<Separator />
							<div className="prose prose-sm max-w-none dark:prose-invert">
								<Markdown content={stripFrontmatter(skill.content)} />
							</div>
						</>
					) : null}
				</>
			) : null}
		</div>
	);
}
