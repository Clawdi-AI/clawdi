"use client";

import { FEATURED_SKILLS } from "@clawdi/shared/consts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	AlertCircle,
	Check,
	ChevronDown,
	Copy as CopyIcon,
	Download,
	ExternalLink,
	ListChecks,
	Plus,
	RefreshCw,
	Search,
	Send as SendIcon,
	Trash2,
} from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";
import { BulkActionBar } from "@/components/bulk-action-bar";
import { agentIdentity } from "@/components/dashboard/agent-label";
import { PageHeader } from "@/components/page-header";
import {
	compareProjectsForUse,
	displayProjectName,
	isCustomProject,
	isProjectOwner,
} from "@/components/projects/project-metadata";
import { ProjectTab } from "@/components/projects/project-tab";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
import { SendSkillDialog } from "@/components/skills/send-skill-dialog";
import { SkillCardGrid, skillSelectionKey } from "@/components/skills/skill-card";
import { resolveSkillProjectAccess } from "@/components/skills/skill-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ensureBlob, unwrap, useApi, useSkillArchiveUploader } from "@/lib/api";
import { fetchAllPages } from "@/lib/api-pagination";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { getProjectResourceDefinition } from "@/lib/project-resource-model";
import { cn, errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

// /skills is the Project skill control center. Pick a Project at
// the top, manage its installed skills below, and use the install
// bar + featured tiles to add new ones. Agent pages deep-link here
// through their Agent Project.

const FALLBACK_TARGET_LABEL = "Active agent";
const SKILLS_RESOURCE = getProjectResourceDefinition("skills");

// Wrap the URL-state body in Suspense so the shell remains stable while the
// param-aware inner client tree hydrates.
export default function SkillsPage() {
	return (
		<Suspense fallback={null}>
			<SkillsPageInner />
		</Suspense>
	);
}

function SkillsPageInner() {
	const api = useApi();
	const uploadSkillArchive = useSkillArchiveUploader();
	const queryClient = useQueryClient();
	// `?project=<project_id>` is the canonical scope. `?target=<env_id>`
	// remains supported for older deep links from agent detail pages.
	const [projectParam, setProjectParam] = useQueryState(
		"project",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true, history: "replace" }),
	);
	const [targetEnvId, setTargetEnvId] = useQueryState(
		"target",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true, history: "replace" }),
	);
	const hasProjectParam = projectParam.trim().length > 0;
	const hasTargetParam = targetEnvId.trim().length > 0;
	const [installing, setInstalling] = useState<string | null>(null);
	const [installError, setInstallError] = useState<string | null>(null);
	const [customRepo, setCustomRepo] = useState("");
	const [customRepoError, setCustomRepoError] = useState<string | null>(null);

	const { data: projects, error: projectsError } = useQuery({
		queryKey: ["projects"],
		queryFn: async () => unwrap(await api.GET("/v1/projects")),
	});
	const orderedProjects = useMemo(
		() => [...(projects ?? [])].filter((project) => project.id).sort(compareProjectsForUse),
		[projects],
	);
	const writableProjectIds = useMemo(
		() =>
			projects
				? new Set(
						projects.filter((project) => isProjectOwner(project)).map((project) => project.id),
					)
				: null,
		[projects],
	);

	const { data: envs } = useQuery({
		queryKey: ["environments"],
		queryFn: async () => unwrap(await api.GET("/v1/environments")),
	});

	// Resolution order:
	//   - URL has ?project=X and projects loaded:
	//       project found → that Project
	//       project missing → stale link, block writes
	//   - Legacy URL has ?target=X and envs loaded:
	//       env found → its Agent Project
	//       env missing → stale link, block writes
	//   - No URL scope → "All projects": most skills live in agent/system
	//     projects, so defaulting to one customized Project hid the bulk
	//     of the user's inventory (Marvin: "users very hard to view them")
	const targetEnvFromUrl = useMemo(() => {
		if (!hasTargetParam || hasProjectParam) return null;
		if (!envs) return undefined; // still loading
		return envs.find((e) => e.id === targetEnvId) ?? null; // null = stale id
	}, [hasProjectParam, hasTargetParam, targetEnvId, envs]);
	const projectFromUrl = useMemo(() => {
		if (!hasProjectParam) return null;
		if (!projects) return undefined; // still loading
		return orderedProjects.find((project) => project.id === projectParam) ?? null;
	}, [hasProjectParam, projectParam, projects, orderedProjects]);
	const isResolvingTarget =
		projects === undefined || targetEnvFromUrl === undefined || projectFromUrl === undefined;
	const isAllScope = !hasProjectParam && !hasTargetParam;
	const targetProjectId = (() => {
		if (hasProjectParam) return projectFromUrl?.id ?? null;
		if (hasTargetParam) return targetEnvFromUrl?.default_project_id ?? null;
		return null; // All-projects view
	})();
	const targetProject = orderedProjects.find((project) => project.id === targetProjectId) ?? null;
	const isStaleProject = hasProjectParam && projectFromUrl === null;
	const isStaleTarget = !hasProjectParam && hasTargetParam && targetEnvFromUrl === null;

	// Fetch account-wide, then filter client-side by the selected
	// Project. That keeps one inventory cache for Project switching
	// while preserving exact project_id writes for install/uninstall.
	const {
		data: skillsData,
		isLoading: skillsLoading,
		error: skillsError,
	} = useQuery({
		queryKey: ["skills", "all-projects"],
		queryFn: async () =>
			fetchAllPages<SkillSummary>(
				async (page, pageSize) =>
					unwrap(
						await api.GET("/v1/skills", {
							params: { query: { page, page_size: pageSize } },
						}),
					),
				{ pageSize: 200, resourceName: "skills" },
			),
		enabled: !isResolvingTarget,
	});
	// Tab row shows custom + personal projects; the per-agent long tail
	// lives behind one overflow menu (a 16-tab row teaches nothing).
	// Both ranked by installed-skill count, busiest first.
	const skillCountByProject = useMemo(() => {
		const m = new Map<string, number>();
		for (const s of skillsData?.items ?? []) {
			if (s.project_id) m.set(s.project_id, (m.get(s.project_id) ?? 0) + 1);
		}
		return m;
	}, [skillsData]);
	const byCountDesc = useMemo(
		() => (a: { id: string; name: string }, b: { id: string; name: string }) =>
			(skillCountByProject.get(b.id) ?? 0) - (skillCountByProject.get(a.id) ?? 0) ||
			a.name.localeCompare(b.name),
		[skillCountByProject],
	);
	const tabProjects = useMemo(
		() =>
			orderedProjects
				.filter((p) => p.kind === "workspace" || p.kind === "personal")
				.sort(byCountDesc),
		[orderedProjects, byCountDesc],
	);
	const overflowProjects = useMemo(
		() =>
			orderedProjects
				.filter((p) => p.kind !== "workspace" && p.kind !== "personal")
				.sort(byCountDesc),
		[orderedProjects, byCountDesc],
	);

	const isProjectReady = !!targetProjectId && !!targetProject && !isStaleProject && !isStaleTarget;
	const canWriteTargetProject = !!targetProject && isProjectReady && isProjectOwner(targetProject);
	const targetProjectLabel = targetProject ? displayProjectName(targetProject) : "Project";
	const overflowActive = !!targetProject && overflowProjects.some((p) => p.id === targetProject.id);
	const targetEnv = envs?.find((e) => e.default_project_id === targetProjectId);

	const targetAgentLabel = useMemo(() => {
		if (!envs || envs.length === 0 || !targetEnv) return FALLBACK_TARGET_LABEL;
		const identity = agentIdentity(targetEnv);
		const baseName = identity.primaryLabel || FALLBACK_TARGET_LABEL;
		const collidesWithSibling = envs.some(
			(e) => e.id !== targetEnv.id && agentIdentity(e).primaryLabel === baseName,
		);
		if (collidesWithSibling && identity.secondaryLabel) {
			return `${baseName} · ${identity.secondaryLabel}`;
		}
		return baseName;
	}, [envs, targetEnv]);

	// Curation toolkit: search across every copy of every skill, then
	// batch-select and send them somewhere better. This is how content
	// escapes the agent/system projects it accumulates in.
	const [search, setSearch] = useState("");
	const [selectMode, setSelectMode] = useState(false);
	const [selectedSkillKeys, setSelectedSkillKeys] = useState<Set<string>>(new Set());
	const clearSelection = () => setSelectedSkillKeys(new Set());
	const toggleSkill = (skill: SkillSummary) => {
		setSelectedSkillKeys((prev) => {
			const next = new Set(prev);
			const key = skillSelectionKey(skill);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const matchesSearch = useMemo(() => {
		const needle = search.trim().toLowerCase();
		if (!needle) return () => true;
		return (s: SkillSummary) =>
			(s.name ?? "").toLowerCase().includes(needle) ||
			s.skill_key.toLowerCase().includes(needle) ||
			(s.description ?? "").toLowerCase().includes(needle);
	}, [search]);

	const skillsForTarget = useMemo(() => {
		if (!skillsData?.items) return undefined;
		if (isStaleProject || isStaleTarget) return [];
		if (isAllScope) return skillsData.items.filter(matchesSearch);
		if (!targetProjectId) return [];
		return skillsData.items.filter((s) => s.project_id === targetProjectId && matchesSearch(s));
	}, [skillsData, targetProjectId, isStaleProject, isStaleTarget, isAllScope, matchesSearch]);

	// Duplicates lens: the same skill_key installed in several Projects is
	// N independent copies (see DESIGN.md copy-vs-reference) — and on real
	// fleets a third of installs are duplicates, many at drifted versions.
	// Group them by key, flag drift via content_hash (catches same-version
	// content edits too), and offer one-click "sync all copies to newest".
	const duplicateGroups = useMemo(() => {
		if (!skillsData?.items) return [];
		const byKey = new Map<string, SkillSummary[]>();
		for (const s of skillsData.items) {
			if (!s.project_id) continue;
			const arr = byKey.get(s.skill_key);
			if (arr) arr.push(s);
			else byKey.set(s.skill_key, [s]);
		}
		return [...byKey.entries()]
			.filter(([, copies]) => copies.length > 1)
			.map(([key, copies]) => {
				const newest = [...copies].sort(
					(a, b) => b.version - a.version || b.updated_at.localeCompare(a.updated_at),
				)[0];
				const drift = new Set(copies.map((c) => c.content_hash)).size > 1;
				return { key, copies, newest, drift };
			})
			.filter((g) => matchesSearch(g.newest))
			.sort(
				(a, b) =>
					Number(b.drift) - Number(a.drift) ||
					b.copies.length - a.copies.length ||
					a.newest.name.localeCompare(b.newest.name),
			);
	}, [skillsData, matchesSearch]);
	const [showDuplicates, setShowDuplicates] = useState(false);
	const duplicatesView = showDuplicates && isAllScope;

	// All-projects view groups by source project, busiest first — this is
	// the "where do most of my skills actually live?" answer at a glance.
	const allGroups = useMemo(() => {
		if (!isAllScope || !skillsForTarget) return [];
		const byProject = new Map<string, SkillSummary[]>();
		for (const s of skillsForTarget) {
			const pid = s.project_id ?? "";
			const bucket = byProject.get(pid);
			if (bucket) bucket.push(s);
			else byProject.set(pid, [s]);
		}
		return [...byProject.entries()]
			.map(([pid, groupSkills]) => {
				const project = orderedProjects.find((p) => p.id === pid) ?? null;
				const label = project
					? displayProjectName(project)
					: (groupSkills[0]?.project_name ?? "Other");
				return { pid, project, label, skills: groupSkills };
			})
			.sort((a, b) => b.skills.length - a.skills.length || a.label.localeCompare(b.label));
	}, [isAllScope, skillsForTarget, orderedProjects]);

	const selectedSkills = useMemo(
		() => (skillsData?.items ?? []).filter((s) => selectedSkillKeys.has(skillSelectionKey(s))),
		[skillsData, selectedSkillKeys],
	);

	const installedKeysOnTarget = useMemo(() => {
		const items = skillsForTarget;
		if (!items) return new Set<string>();
		return new Set(items.map((s) => s.skill_key));
	}, [skillsForTarget]);

	const uninstallSkill = useMutation({
		mutationFn: async ({ skillKey, projectId }: { skillKey: string; projectId: string }) =>
			unwrap(
				await api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
					params: { path: { project_id: projectId, skill_key: skillKey } },
				}),
			),
		onSuccess: (_data, vars) => {
			toast.success("Skill Uninstalled", {
				description: `${vars.skillKey} was removed from ${targetProjectLabel}.`,
			});
			queryClient.invalidateQueries({ queryKey: ["skills"] });
		},
		onError: (e) => toast.error("Couldn't uninstall skill", { description: errorMessage(e) }),
	});

	const syncGroup = useMutation({
		mutationFn: async (group: { newest: SkillSummary; copies: SkillSummary[] }) => {
			const { newest, copies } = group;
			const stale = copies.filter(
				(c) =>
					c.project_id &&
					c.project_id !== newest.project_id &&
					c.content_hash !== newest.content_hash,
			);
			if (stale.length === 0) return { name: newest.name, updated: 0, failed: [] as string[] };
			if (!newest.project_id) {
				return { name: newest.name, updated: 0, failed: ["source project"] };
			}
			const blob = ensureBlob(
				unwrap(
					await api.GET("/v1/projects/{project_id}/skills/{skill_key}/download", {
						params: {
							path: { project_id: newest.project_id, skill_key: newest.skill_key },
						},
						parseAs: "blob",
					}),
				),
			);
			let updated = 0;
			const failed: string[] = [];
			for (const copy of stale) {
				if (!copy.project_id) {
					failed.push(copy.project_name ?? "unknown project");
					continue;
				}
				try {
					await uploadSkillArchive(copy.project_id, newest.skill_key, blob);
					updated += 1;
				} catch {
					failed.push(copy.project_name ?? "unknown project");
				}
			}
			return { name: newest.name, updated, failed };
		},
		onSuccess: ({ name, updated, failed }) => {
			queryClient.invalidateQueries({ queryKey: ["skills"] });
			if (updated === 0 && failed.length === 0) {
				toast.success(`${name} copies already match`);
				return;
			}
			if (updated === 0) {
				toast.error(`Couldn't sync ${name}`, {
					description: `Failed: ${failed.join(", ")}.`,
				});
				return;
			}
			toast.success(`${name} synced`, {
				description:
					`${updated} ${updated === 1 ? "copy" : "copies"} updated to the newest content.` +
					(failed.length > 0 ? ` Failed: ${failed.join(", ")}.` : ""),
			});
		},
		onError: (e) => toast.error("Couldn't sync copies", { description: errorMessage(e) }),
	});

	const bulkUninstall = useMutation({
		mutationFn: async (skills: SkillSummary[]) => {
			let removed = 0;
			for (const s of skills) {
				if (!s.project_id || !(writableProjectIds?.has(s.project_id) ?? false)) continue;
				unwrap(
					await api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
						params: { path: { project_id: s.project_id, skill_key: s.skill_key } },
					}),
				);
				removed += 1;
			}
			return removed;
		},
		onSuccess: (removed) => {
			toast.success(`${removed} ${removed === 1 ? "skill" : "skills"} uninstalled`);
			queryClient.invalidateQueries({ queryKey: ["skills"] });
			clearSelection();
		},
		onError: (e) => toast.error("Couldn't uninstall skills", { description: errorMessage(e) }),
	});

	const installSkill = async (repo: string, path?: string): Promise<boolean> => {
		const key = `${repo}/${path || ""}`;
		setInstalling(key);
		setInstallError(null);
		try {
			if (!targetProjectId || !targetProject) throw new Error("Choose a Project first");
			if (!canWriteTargetProject) throw new Error("This Project is read-only");
			unwrap(
				await api.POST("/v1/projects/{project_id}/skills/install", {
					params: { path: { project_id: targetProjectId } },
					body: { repo, path },
				}),
			);
			queryClient.invalidateQueries({ queryKey: ["skills"] });
			const daemonHealthy =
				targetEnv?.sync_enabled && targetEnv?.last_sync_at
					? Date.now() - new Date(targetEnv.last_sync_at).getTime() < 90_000
					: false;
			const projectName = displayProjectName(targetProject);
			if (targetEnv) {
				toast.success(
					daemonHealthy
						? `Installed. Will appear on ${targetAgentLabel} within a couple seconds.`
						: `Installed. Will apply on ${targetAgentLabel} when its daemon reconnects.`,
				);
			} else {
				toast.success(`Installed in ${projectName}`, {
					description: "Add this Project to an agent when you want it available during a run.",
				});
			}
			return true;
		} catch (e: unknown) {
			setInstallError(errorMessage(e));
			return false;
		} finally {
			setInstalling(null);
		}
	};

	const handleCustom = async () => {
		setCustomRepoError(null);
		const trimmed = customRepo.trim();
		if (!trimmed) return;
		const clean = trimmed.replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
		const parts = clean.split("/").filter(Boolean);
		if (parts.length < 2) {
			setCustomRepoError("Enter as `owner/repo` or `owner/repo/path-to-skill`.");
			return;
		}
		const repo = `${parts[0]}/${parts[1]}`;
		const path = parts.length > 2 ? parts.slice(2).join("/") : undefined;
		const ok = await installSkill(repo, path);
		if (ok) setCustomRepo("");
	};

	const installedSkillsEmptyMessage = isStaleProject
		? "This link points to a Project that is no longer available. Pick another Project."
		: isStaleTarget
			? "This link points to an agent that no longer exists. Pick a Project above."
			: orderedProjects.length === 0
				? "Create a Project first, then install skills into it."
				: isProjectReady
					? "No skills in this Project yet. Install one from the marketplace below."
					: "Pick a Project to see its skills.";
	const canShareTargetProject =
		targetProject && isProjectOwner(targetProject) && isCustomProject(targetProject);
	const renderShareProjectAction = () =>
		canShareTargetProject && targetProject ? (
			<ShareProjectDialog
				projectId={targetProject.id}
				projectName={displayProjectName(targetProject)}
				projectKind={targetProject.kind}
			/>
		) : null;

	return (
		<div className="space-y-6 px-4 lg:px-6">
			<PageHeader
				title="Skills"
				description={SKILLS_RESOURCE.managementDescription}
				actions={orderedProjects.length > 0 ? renderShareProjectAction() : null}
			/>

			{/* Project scope as visible tabs, mirroring the vault page: custom
			    projects + Global up front, the long tail of per-agent projects
			    behind one overflow menu. */}
			{orderedProjects.length > 0 ? (
				<div
					className="flex flex-wrap items-center gap-1.5"
					role="tablist"
					aria-label="Project scope for skills"
				>
					<ProjectTab
						active={isAllScope}
						onClick={() => {
							void setProjectParam("");
							void setTargetEnvId("");
						}}
						label="All projects"
						count={skillsData?.items.length}
					/>
					{tabProjects.map((p) => (
						<ProjectTab
							key={p.id}
							active={targetProjectId === p.id}
							onClick={() => {
								void setProjectParam(p.id);
								void setTargetEnvId("");
							}}
							label={displayProjectName(p)}
							emoji={identityFor(displayProjectName(p)).emoji}
							count={skillCountByProject.get(p.id) ?? 0}
						/>
					))}
					{overflowProjects.length > 0 ? (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									className={cn(
										"inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus:outline-none",
										overflowActive
											? "border-foreground/20 bg-accent font-medium text-foreground"
											: "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
									)}
								>
									{overflowActive && targetProject
										? `${identityFor(displayProjectName(targetProject)).emoji} ${displayProjectName(targetProject)}`
										: `Agent projects (${overflowProjects.length})`}
									<ChevronDown className="size-3.5" />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
								{overflowProjects.map((p) => (
									<DropdownMenuItem
										key={p.id}
										onSelect={() => {
											void setProjectParam(p.id);
											void setTargetEnvId("");
										}}
									>
										<span aria-hidden className="select-none">
											{identityFor(displayProjectName(p)).emoji}
										</span>
										<span className="min-w-0 flex-1 truncate">{displayProjectName(p)}</span>
										<span className="text-xs text-muted-foreground tabular-nums">
											{skillCountByProject.get(p.id) ?? 0}
										</span>
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
				</div>
			) : null}

			{projectsError ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Couldn&apos;t load Projects</AlertTitle>
					<AlertDescription>
						Project-scoped install and uninstall are temporarily disabled.{" "}
						{errorMessage(projectsError)}
					</AlertDescription>
				</Alert>
			) : null}

			{/* Skills inventory failure: a load error must not look
			    like an empty inventory — pre-fix the page swallowed
			    `skillsError` and fell through to the empty-state copy
			    'No skills installed on this agent yet,' which is
			    indistinguishable from a real /api/skills outage from
			    the user's perspective. */}
			{skillsError ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Couldn&apos;t load skills</AlertTitle>
					<AlertDescription>
						Your installed skills aren&apos;t showing because of an API error. Refresh to retry.{" "}
						{errorMessage(skillsError)}
					</AlertDescription>
				</Alert>
			) : null}

			{!canWriteTargetProject && targetProject ? (
				<Alert>
					<AlertCircle />
					<AlertTitle>Read-only Project</AlertTitle>
					<AlertDescription>
						You can view skills in {displayProjectName(targetProject)}, but only the owner can
						install or remove them.
					</AlertDescription>
				</Alert>
			) : null}

			<section className="space-y-3">
				<div className="flex flex-wrap items-center gap-2">
					<div className="flex items-center gap-2">
						<h2 className="text-sm font-semibold">Installed</h2>
						{skillsForTarget ? (
							<Badge variant="secondary" className="tabular-nums">
								{skillsForTarget.length}
							</Badge>
						) : null}
						{targetProject ? (
							<span className="text-xs text-muted-foreground">
								in {displayProjectName(targetProject)}
							</span>
						) : isAllScope ? (
							<span className="text-xs text-muted-foreground">across every Project</span>
						) : null}
					</div>
					<div className="ml-auto flex items-center gap-2">
						<div className="relative">
							<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
							<Input
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="Search skills…"
								aria-label="Search skills"
								className="h-8 w-44 pl-8 text-sm sm:w-56"
							/>
						</div>
						{isAllScope && duplicateGroups.length > 0 ? (
							<Button
								variant={showDuplicates ? "secondary" : "outline"}
								size="sm"
								onClick={() => setShowDuplicates((on) => !on)}
								aria-pressed={showDuplicates}
							>
								<CopyIcon className="size-3.5" />
								Duplicates
								<span className="text-xs text-muted-foreground tabular-nums">
									{duplicateGroups.length}
								</span>
							</Button>
						) : null}
						<Button
							variant={selectMode ? "secondary" : "outline"}
							size="sm"
							onClick={() => {
								setSelectMode((on) => {
									if (on) clearSelection();
									return !on;
								});
							}}
							aria-pressed={selectMode}
						>
							<ListChecks className="size-3.5" />
							{selectMode ? "Done" : "Select"}
						</Button>
					</div>
				</div>
				{duplicatesView ? (
					duplicateGroups.length === 0 ? (
						<div className="rounded-xl border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
							No duplicated skills{search.trim() ? " match that search" : ""}.
						</div>
					) : (
						<div className="space-y-6">
							{duplicateGroups.map((group) => {
								const versions = [...new Set(group.copies.map((c) => c.version))].sort(
									(a, b) => b - a,
								);
								const staleCount = group.copies.filter(
									(c) => c.content_hash !== group.newest.content_hash,
								).length;
								return (
									<div key={group.key} className="space-y-2">
										<div className="flex flex-wrap items-center gap-2">
											<span aria-hidden className="select-none text-sm leading-none">
												{identityFor(group.newest.name || group.key).emoji}
											</span>
											<span className="text-sm font-medium">{group.newest.name}</span>
											<span className="text-xs text-muted-foreground tabular-nums">
												in {group.copies.length} projects
											</span>
											{group.drift ? (
												<Badge
													variant="secondary"
													className="bg-warning-muted text-warning-muted-foreground"
												>
													content differs · {versions.map((v) => `v${v}`).join(" / ")}
												</Badge>
											) : (
												<Badge variant="secondary">identical copies · v{versions[0]}</Badge>
											)}
											{group.drift ? (
												<ConfirmAction
													title={`Sync ${group.newest.name} everywhere?`}
													description={
														<p>
															Overwrites {staleCount} older {staleCount === 1 ? "copy" : "copies"}{" "}
															with v{group.newest.version} from{" "}
															{group.newest.project_name ?? "the newest Project"}. Local edits in
															those Projects are replaced.
														</p>
													}
													confirmLabel="Sync copies"
													onConfirm={() => syncGroup.mutate(group)}
												>
													<Button
														variant="outline"
														size="sm"
														className="h-6 px-2 text-xs"
														disabled={syncGroup.isPending}
													>
														<RefreshCw className="size-3" />
														Sync all to newest
													</Button>
												</ConfirmAction>
											) : null}
										</div>
										<SkillCardGrid
											skills={group.copies}
											isLoading={false}
											emptyMessage={null}
											readOnlySkillCheck={(sk) =>
												resolveSkillProjectAccess(sk, { writableProjectIds }) !== "writable"
											}
											onUninstall={(skillKey, projectId) =>
												uninstallSkill.mutate({ skillKey, projectId })
											}
											uninstallPending={uninstallSkill.isPending}
											sourceLabelFor={(sk) => {
												const project = orderedProjects.find((p) => p.id === sk.project_id);
												const label = project
													? displayProjectName(project)
													: (sk.project_name ?? "Unknown");
												return { name: label, emoji: identityFor(label).emoji };
											}}
										/>
									</div>
								);
							})}
						</div>
					)
				) : isAllScope ? (
					skillsLoading || isResolvingTarget ? (
						<SkillCardGrid skills={[]} isLoading emptyMessage={null} />
					) : allGroups.length === 0 ? (
						<div className="rounded-xl border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
							{search.trim()
								? "No skills match that search."
								: "No skills installed anywhere yet. Pick a Project tab to install one."}
						</div>
					) : (
						<div className="space-y-6">
							{allGroups.map((group) => {
								const groupKeys = group.skills.map(skillSelectionKey);
								const allSelected =
									groupKeys.length > 0 && groupKeys.every((k) => selectedSkillKeys.has(k));
								return (
									<div key={group.pid || "other"} className="space-y-2">
										<div className="flex items-center gap-2">
											<span aria-hidden className="select-none text-sm leading-none">
												{identityFor(group.label).emoji}
											</span>
											{group.project ? (
												<button
													type="button"
													onClick={() => void setProjectParam(group.pid)}
													className="text-sm font-medium hover:underline"
												>
													{group.label}
												</button>
											) : (
												<span className="text-sm font-medium">{group.label}</span>
											)}
											<span className="text-xs text-muted-foreground tabular-nums">
												{group.skills.length}
											</span>
											{selectMode ? (
												<Button
													variant="ghost"
													size="sm"
													className="h-6 px-2 text-xs"
													onClick={() => {
														setSelectedSkillKeys((prev) => {
															const next = new Set(prev);
															for (const k of groupKeys) {
																if (allSelected) next.delete(k);
																else next.add(k);
															}
															return next;
														});
													}}
												>
													{allSelected ? "Deselect all" : "Select all"}
												</Button>
											) : null}
										</div>
										<SkillCardGrid
											skills={group.skills}
											isLoading={false}
											emptyMessage={null}
											readOnlySkillCheck={(s) =>
												resolveSkillProjectAccess(s, { writableProjectIds }) !== "writable"
											}
											onUninstall={(skillKey, projectId) =>
												uninstallSkill.mutate({ skillKey, projectId })
											}
											uninstallPending={uninstallSkill.isPending}
											selectMode={selectMode}
											selectedKeys={selectedSkillKeys}
											onToggleSelect={toggleSkill}
										/>
									</div>
								);
							})}
						</div>
					)
				) : (
					<SkillCardGrid
						skills={skillsForTarget ?? []}
						isLoading={skillsLoading || isResolvingTarget}
						emptyMessage={installedSkillsEmptyMessage}
						readOnlySkillCheck={(s) =>
							resolveSkillProjectAccess(s, {
								currentProjectId: targetProjectId,
								writableProjectIds,
							}) !== "writable"
						}
						onUninstall={(skillKey, projectId) => uninstallSkill.mutate({ skillKey, projectId })}
						uninstallPending={uninstallSkill.isPending}
						selectMode={selectMode}
						selectedKeys={selectedSkillKeys}
						onToggleSelect={toggleSkill}
					/>
				)}
			</section>

			<BulkActionBar count={selectedSkillKeys.size} noun="skill" onClear={clearSelection}>
				<SendSkillDialog skills={selectedSkills} onDone={clearSelection}>
					<Button size="sm">
						<SendIcon className="size-3.5" />
						Send to…
					</Button>
				</SendSkillDialog>
				<ConfirmAction
					title={`Uninstall ${selectedSkillKeys.size} ${selectedSkillKeys.size === 1 ? "skill" : "skills"}?`}
					description={
						<p>Each selected copy is removed from its Project. Read-only copies are skipped.</p>
					}
					confirmLabel="Uninstall"
					destructive
					onConfirm={() => bulkUninstall.mutate(selectedSkills)}
				>
					<Button
						size="sm"
						variant="outline"
						disabled={bulkUninstall.isPending}
						className="text-destructive"
					>
						<Trash2 className="size-3.5" />
						Uninstall
					</Button>
				</ConfirmAction>
			</BulkActionBar>

			{isAllScope ? (
				<p className="text-xs text-muted-foreground">
					Pick a Project tab above to install new skills into it.
				</p>
			) : (
				<section className="space-y-3">
					<div className="flex items-center justify-between gap-2">
						<h2 className="text-sm font-semibold">Add a skill</h2>
						<a
							href="https://skills.sh"
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
						>
							More on skills.sh <ExternalLink className="size-3" />
						</a>
					</div>
					<div className="flex flex-col gap-2 sm:flex-row">
						<div className="relative min-w-0 flex-1 sm:max-w-md">
							<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								id="skill-custom-repo"
								name="skill-custom-repo"
								value={customRepo}
								onChange={(e) => {
									setCustomRepo(e.target.value);
									setCustomRepoError(null);
									setInstallError(null);
								}}
								placeholder="owner/repo or owner/repo/path…"
								autoComplete="off"
								spellCheck={false}
								className="pl-9"
								onKeyDown={(e) => {
									if (e.key === "Enter") handleCustom();
								}}
								aria-invalid={!!customRepoError || undefined}
								aria-label="GitHub skill repository"
							/>
						</div>
						<Button
							onClick={handleCustom}
							disabled={!customRepo.trim() || !!installing || !canWriteTargetProject}
							variant={customRepo.trim() && canWriteTargetProject ? "default" : "outline"}
							className="sm:w-auto"
						>
							{installing && customRepo ? <Spinner /> : <Plus />}
							Install
						</Button>
					</div>
					{customRepoError ? <p className="text-xs text-destructive">{customRepoError}</p> : null}
					{installError ? (
						<Alert variant="destructive">
							<AlertTitle>Install failed</AlertTitle>
							<AlertDescription>{installError}</AlertDescription>
						</Alert>
					) : null}

					<p className="pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
						Suggested
					</p>
					<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
						{FEATURED_SKILLS.map((skill) => {
							const key = `${skill.repo}/${skill.path ?? ""}`;
							const isInstalled = installedKeysOnTarget.has(skill.skillKey);
							const isInstalling = installing === key;
							return (
								<div
									key={key}
									className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3 transition-colors hover:border-foreground/20"
								>
									<div className="min-w-0 flex-1">
										{isInstalled && targetProjectId ? (
											<Link
												to="/skills/$key"
												params={{ key: skill.skillKey }}
												search={{ project: targetProjectId }}
												className="truncate text-sm font-medium hover:underline"
											>
												{skill.name}
											</Link>
										) : (
											<span className="truncate text-sm font-medium">{skill.name}</span>
										)}
										<p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
											{skill.description}
										</p>
										<p className="mt-1.5 font-mono text-xs text-muted-foreground">
											{skill.repo}
											{skill.path ? `/${skill.path}` : ""}
										</p>
									</div>
									{isInstalled ? (
										<Badge variant="secondary" className="shrink-0">
											<Check />
											Installed
										</Badge>
									) : (
										<Button
											variant="outline"
											size="sm"
											onClick={() => installSkill(skill.repo, skill.path)}
											disabled={isInstalling || !canWriteTargetProject}
											className="shrink-0"
										>
											{isInstalling ? <Spinner /> : <Download />}
											Install
										</Button>
									)}
								</div>
							);
						})}
					</div>
				</section>
			)}
		</div>
	);
}
