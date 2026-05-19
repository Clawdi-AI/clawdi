"use client";

import { FEATURED_SKILLS } from "@clawdi/shared/consts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertCircle,
	Check,
	Download,
	ExternalLink,
	FolderKanban,
	Plus,
	Search,
	Sparkles,
} from "lucide-react";
import Link from "next/link";
import { parseAsString, useQueryState } from "nuqs";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";
import { agentTypeLabel, cleanMachineName } from "@/components/dashboard/agent-label";
import { PageHeader } from "@/components/page-header";
import {
	compareProjectsForUse,
	displayProjectName,
	isCustomProject,
	isProjectOwner,
	ProjectScopePicker,
} from "@/components/projects/project-metadata";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
import { makeSkillColumns } from "@/components/skills/skill-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { getProjectResourceDefinition, skillDetailHref } from "@/lib/project-resource-model";
import { errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

// /skills is the Project skill control center. Pick a Project at
// the top, manage its installed skills below, and use the install
// bar + featured tiles to add new ones. Agent pages deep-link here
// through their Home Project.

const FALLBACK_TARGET_LABEL = "Active agent";
const SKILLS_RESOURCE = getProjectResourceDefinition("skills");

// Next 16 prerender bails out unless `useSearchParams()` lives
// inside a Suspense boundary. Wrap the whole page so static
// export still produces a stable HTML shell while the param-aware
// inner client tree hydrates.
export default function SkillsPage() {
	return (
		<Suspense fallback={null}>
			<SkillsPageInner />
		</Suspense>
	);
}

function SkillsPageInner() {
	const api = useApi();
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
		queryFn: async () => unwrap(await api.GET("/api/projects")),
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
		queryFn: async () => unwrap(await api.GET("/api/environments")),
	});

	// Resolution order:
	//   - URL has ?project=X and projects loaded:
	//       project found → that Project
	//       project missing → stale link, block writes
	//   - Legacy URL has ?target=X and envs loaded:
	//       env found → its Home Project
	//       env missing → stale link, block writes
	//   - No URL scope → first visible Project, ordered for common use
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
	const targetProjectId = (() => {
		if (hasProjectParam) return projectFromUrl?.id ?? null;
		if (hasTargetParam) return targetEnvFromUrl?.default_project_id ?? null;
		return orderedProjects[0]?.id ?? null;
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
		queryFn: async () => {
			const PAGE_SIZE = 200;
			const items: SkillSummary[] = [];
			let page = 1;
			let total = 0;
			while (true) {
				const result = unwrap(
					await api.GET("/api/skills", {
						params: { query: { page, page_size: PAGE_SIZE } },
					}),
				);
				items.push(...result.items);
				total = result.total ?? items.length;
				if (items.length >= total || result.items.length === 0) break;
				page += 1;
				// Defense-in-depth: bail at 50 pages = 10k skills, far
				// above any plausible account today. Hitting this would
				// suggest a backend pagination bug.
				if (page > 50) break;
			}
			return { items, total, page: 1, page_size: PAGE_SIZE };
		},
		enabled: !isResolvingTarget,
	});
	const isProjectReady = !!targetProjectId && !!targetProject && !isStaleProject && !isStaleTarget;
	const canWriteTargetProject = !!targetProject && isProjectReady && isProjectOwner(targetProject);
	const targetProjectLabel = targetProject ? displayProjectName(targetProject) : "Project";
	const targetEnv = envs?.find((e) => e.default_project_id === targetProjectId);

	const targetAgentLabel = useMemo(() => {
		if (!envs || envs.length === 0 || !targetEnv) return FALLBACK_TARGET_LABEL;
		const baseName = cleanMachineName(targetEnv.machine_name) || FALLBACK_TARGET_LABEL;
		const collidesWithSibling = envs.some(
			(e) => e.id !== targetEnv.id && e.machine_name === targetEnv.machine_name,
		);
		if (collidesWithSibling) return `${baseName} · ${agentTypeLabel(targetEnv.agent_type)}`;
		return baseName;
	}, [envs, targetEnv]);

	const skillsForTarget = useMemo(() => {
		if (!skillsData?.items) return undefined;
		if (isStaleProject || isStaleTarget || !targetProjectId) return [];
		return skillsData.items.filter((s) => s.project_id === targetProjectId);
	}, [skillsData, targetProjectId, isStaleProject, isStaleTarget]);

	const installedKeysOnTarget = useMemo(() => {
		const items = skillsForTarget;
		if (!items) return new Set<string>();
		return new Set(items.map((s) => s.skill_key));
	}, [skillsForTarget]);

	const uninstallSkill = useMutation({
		mutationFn: async ({ skillKey, projectId }: { skillKey: string; projectId: string }) =>
			unwrap(
				await api.DELETE("/api/projects/{project_id}/skills/{skill_key}", {
					params: { path: { project_id: projectId, skill_key: skillKey } },
				}),
			),
		onSuccess: (_data, vars) => {
			toast.success("Skill Uninstalled", {
				description: `${vars.skillKey} was removed from ${targetProjectLabel}.`,
			});
			queryClient.invalidateQueries({ queryKey: ["skills"] });
		},
		onError: (e) => toast.error("Failed to Uninstall Skill", { description: errorMessage(e) }),
	});

	const skillColumns = useMemo(
		() =>
			makeSkillColumns(
				(skillKey, projectId) => uninstallSkill.mutate({ skillKey, projectId }),
				uninstallSkill.isPending,
				{ currentProjectId: targetProjectId, writableProjectIds },
			),
		[uninstallSkill.mutate, uninstallSkill.isPending, targetProjectId, writableProjectIds],
	);

	const installSkill = async (repo: string, path?: string): Promise<boolean> => {
		const key = `${repo}/${path || ""}`;
		setInstalling(key);
		setInstallError(null);
		try {
			if (!targetProjectId || !targetProject) throw new Error("Choose a Project first");
			if (!canWriteTargetProject) throw new Error("This Project is read-only");
			unwrap(
				await api.POST("/api/projects/{project_id}/skills/install", {
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
					description: "Attach this Project to an agent when you want it available during a run.",
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

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Skills"
				description={SKILLS_RESOURCE.managementDescription}
				actions={
					targetProject && isProjectOwner(targetProject) && isCustomProject(targetProject) ? (
						<ShareProjectDialog
							projectId={targetProject.id}
							projectName={displayProjectName(targetProject)}
							projectKind={targetProject.kind}
						/>
					) : null
				}
			/>

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

			{orderedProjects.length > 0 ? (
				<section className="rounded-lg border bg-card/60 p-4">
					<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,420px)] lg:items-start">
						<div className="flex items-start gap-2">
							<span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
								<FolderKanban className="size-3.5" />
							</span>
							<div className="min-w-0">
								<h2 className="text-sm font-semibold">Current Project</h2>
								<p className="mt-0.5 text-xs text-muted-foreground">
									Skills are installed into one Project. Pick the Project first, then install or
									remove skills below.
								</p>
							</div>
						</div>
						<ProjectScopePicker
							projects={orderedProjects}
							agents={envs ?? []}
							value={targetProjectId ?? ""}
							onValueChange={(projectId) => {
								void setProjectParam(projectId);
								void setTargetEnvId("");
							}}
							label="Project"
							layout="stacked"
						/>
					</div>
				</section>
			) : null}

			{!canWriteTargetProject && targetProject ? (
				<Alert>
					<AlertCircle />
					<AlertTitle>Read-only Project</AlertTitle>
					<AlertDescription>
						You can inspect skills in {displayProjectName(targetProject)}, but only the owner can
						install or remove them.
					</AlertDescription>
				</Alert>
			) : null}

			<section className="space-y-2">
				<div className="flex items-baseline justify-between gap-3">
					<h2 className="text-base font-semibold">
						Installed Skills
						{skillsForTarget ? (
							<span className="ml-2 text-sm font-normal text-muted-foreground">
								{skillsForTarget.length}
							</span>
						) : null}
					</h2>
				</div>
				<DataTable
					columns={skillColumns}
					data={skillsForTarget ?? []}
					isLoading={skillsLoading || isResolvingTarget}
					rowAriaLabel={(s) => `Open ${s.name}`}
					emptyMessage={
						isStaleProject
							? "This link points to a Project that is no longer available. Pick another Project."
							: isStaleTarget
								? "This link points to an agent that no longer exists. Pick a Project above."
								: orderedProjects.length === 0
									? "Create a Project first, then install skills into it."
									: isProjectReady
										? "No skills in this Project yet. Install one from the marketplace below."
										: "Pick a Project to see its skills."
					}
				/>
			</section>

			<section className="rounded-lg border bg-card/60 p-4">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="min-w-0">
						<h2 className="text-base font-semibold">Add a Skill</h2>
						<p className="mt-1 text-xs text-muted-foreground">
							Installs into{" "}
							{targetProject ? displayProjectName(targetProject) : "the selected Project"}. Use an
							owner/repo path, or pick one of the suggested skills below.
						</p>
					</div>
					<a
						href="https://skills.sh"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						More on skills.sh <ExternalLink className="size-3" />
					</a>
				</div>
				<div className="mt-3 grid gap-1.5">
					<Label htmlFor="skill-custom-repo" className="text-xs font-medium">
						GitHub skill repository
					</Label>
					<div className="flex flex-col gap-2 sm:flex-row">
						<div className="relative min-w-0 flex-1">
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
							/>
						</div>
						<Button
							onClick={handleCustom}
							disabled={!customRepo.trim() || !!installing || !canWriteTargetProject}
							variant={customRepo.trim() && canWriteTargetProject ? "default" : "outline"}
							className="sm:w-auto"
						>
							{installing && customRepo ? <Spinner /> : <Plus />}
							Install Skill
						</Button>
					</div>
				</div>
				{customRepoError ? <p className="text-xs text-destructive">{customRepoError}</p> : null}
				{installError ? (
					<Alert variant="destructive">
						<AlertTitle>Install Failed</AlertTitle>
						<AlertDescription>{installError}</AlertDescription>
					</Alert>
				) : null}

				<div className="mt-4 space-y-2">
					<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Suggested Skills
					</p>
					<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
						{FEATURED_SKILLS.map((skill) => {
							const key = `${skill.repo}/${skill.path ?? ""}`;
							const isInstalled = installedKeysOnTarget.has(skill.skillKey);
							const isInstalling = installing === key;
							return (
								<Card key={key} className="py-0">
									<CardContent className="flex items-start justify-between gap-3 p-3">
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<Sparkles className="size-4 shrink-0 text-primary" />
												{isInstalled && targetProjectId ? (
													<Link
														href={skillDetailHref(skill.skillKey, targetProjectId)}
														className="truncate text-sm font-medium hover:underline"
													>
														{skill.name}
													</Link>
												) : (
													<span className="truncate text-sm font-medium">{skill.name}</span>
												)}
											</div>
											<p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
												{skill.description}
											</p>
											<p className="mt-1.5 text-xs text-muted-foreground">
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
									</CardContent>
								</Card>
							);
						})}
					</div>
				</div>
			</section>
		</div>
	);
}
