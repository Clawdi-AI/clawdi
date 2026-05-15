"use client";

import { FEATURED_SKILLS } from "@clawdi/shared/consts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Download, ExternalLink, Plus, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { parseAsString, useQueryState } from "nuqs";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { agentTypeLabel, cleanMachineName } from "@/components/dashboard/agent-label";
import { PageHeader } from "@/components/page-header";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
import { AgentTargetPicker } from "@/components/skills/agent-target-picker";
import { makeSkillColumns } from "@/components/skills/skill-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

// /skills is the cross-agent skill control center. Pick an agent
// at the top, manage that agent's installed skills below, and use
// the install bar + featured tiles at the bottom to add new ones.
// Same DataTable + skillColumns the agent detail page uses, so
// the two surfaces stay in lockstep.

const FALLBACK_TARGET_LABEL = "Active agent";

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
	// `?target=<env_id>` lives in nuqs — shareable, refresh-stable,
	// and round-trippable from the agent detail page's "Install
	// skills" deep link. `clearOnDefault` keeps `/skills` clean when
	// no target is set.
	const [targetEnvId, setTargetEnvId] = useQueryState(
		"target",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true, history: "replace" }),
	);
	const hasTargetParam = targetEnvId.trim().length > 0;
	const [installing, setInstalling] = useState<string | null>(null);
	const [installError, setInstallError] = useState<string | null>(null);
	const [customRepo, setCustomRepo] = useState("");
	const [customRepoError, setCustomRepoError] = useState<string | null>(null);

	const { error: defaultProjectError } = useQuery({
		queryKey: ["projects", "default"],
		queryFn: async () => unwrap(await api.GET("/api/projects/default")),
	});

	const { data: envs } = useQuery({
		queryKey: ["environments"],
		queryFn: async () => unwrap(await api.GET("/api/environments")),
	});

	const agentCount = envs?.length ?? 0;

	const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
	useEffect(() => {
		if (!hasTargetParam || !envs) return;
		const env = envs.find((e) => e.id === targetEnvId);
		if (env?.default_project_id) setSelectedProjectId(env.default_project_id);
	}, [hasTargetParam, targetEnvId, envs]);

	const onPickProject = useCallback(
		(projectId: string) => {
			setSelectedProjectId(projectId);
			const env = envs?.find((e) => e.default_project_id === projectId);
			if (!env) return;
			void setTargetEnvId(env.id);
		},
		[envs, setTargetEnvId],
	);

	const orderedEnvs = useMemo(() => {
		return [...(envs ?? [])].sort((a, b) => {
			const aT = a.last_sync_at ? new Date(a.last_sync_at).getTime() : 0;
			const bT = b.last_sync_at ? new Date(b.last_sync_at).getTime() : 0;
			return bT - aT;
		});
	}, [envs]);

	const defaultAgentProjectId = useMemo(() => {
		return orderedEnvs.find((env) => env.default_project_id)?.default_project_id ?? null;
	}, [orderedEnvs]);

	// Resolve the target project synchronously from the optional
	// `target` URL param + `envs` so a deep-link `?target=X`
	// never falls through to
	// the account-default during the brief render window where
	// `selectedProjectId` hasn't been populated by its useEffect
	// yet. Pre-fix that window (and stale/deleted target ids
	// permanently) exposed install/uninstall actions wired to
	// the WRONG agent's project.
	//
	// Resolution order:
	//   - URL has ?target=X and envs loaded:
	//       env found → that env's project
	//       env not found (stale/deleted) → null (block actions)
	//   - URL has ?target=X but envs still loading → null
	//   - No ?target=, picker selection (post-mount) → that project
	//   - No ?target=, no picker → most-recent agent project
	const targetEnvFromUrl = useMemo(() => {
		if (!hasTargetParam) return null;
		if (!envs) return undefined; // still loading
		return envs.find((e) => e.id === targetEnvId) ?? null; // null = stale id
	}, [hasTargetParam, targetEnvId, envs]);
	const isResolvingTarget = targetEnvFromUrl === undefined;
	const targetProjectId = (() => {
		if (hasTargetParam) {
			// URL-driven target: only resolve once envs say
			// whether it's valid.
			if (targetEnvFromUrl === undefined) return null; // loading
			return targetEnvFromUrl?.default_project_id ?? null; // null = stale
		}
		// No URL target. If the account has zero envs registered,
		// the default resolves to Personal — but
		// installing into Personal is silent harm: a future
		// connected agent gets its own env project and won't see
		// the Personal install. Block installs until an env exists
		// (envs still loading: `envs === undefined` → null too).
		if (!envs || envs.length === 0) return null;
		return selectedProjectId ?? defaultAgentProjectId;
	})();

	// Always fetch account-wide. Earlier shape pinned project_id
	// to the resolved target, but that hid two real cases the
	// page MUST surface:
	//   1. Personal-project skills that pre-dated agent envs.
	//   2. Orphaned projects whose origin env was disconnected
	//      (backend keeps the project + skills; the env is gone).
	// Both produce skills with a project_id that no active env
	// references; client-side filtering handles the per-agent
	// view + a separate orphan section below.
	//
	// Walk every page server-side: the backend caps page_size
	// at 200, so an account with > 200 skills across projects
	// would lose page 2+ rows under a single-page fetch. The
	// loop runs inside the queryFn so React only sees one
	// completed result; a hard cap of 50 pages (10k skills)
	// guards against a server bug or runaway listing.
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
	const isProjectReady = !!targetProjectId;
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

	// A URL `?target=X` that points at an env that doesn't
	// exist (deleted on another machine, never registered, copy-
	// pasted from a different account) is a stale deep link.
	// We MUST NOT show ANY skills in that case — the row's
	// uninstall button would otherwise wire to whatever project
	// the row carries, hitting an arbitrary agent's skill
	// instead of the one the user thought they were operating
	// on. Pre-fix the round-46 fallback rendered the account-
	// wide listing here and the buttons stayed enabled.
	const isStaleTarget = hasTargetParam && targetEnvFromUrl === null;

	// Set of project_ids that belong to currently-connected envs.
	// Anything outside this set is either Personal project, or an
	// orphaned project whose env was disconnected (backend
	// preserves both the project and its skills).
	const envProjectIds = useMemo(
		() =>
			new Set(
				(envs ?? [])
					.map((e) => e.default_project_id)
					.filter((s): s is string => typeof s === "string"),
			),
		[envs],
	);

	const skillsForTarget = useMemo(() => {
		if (!skillsData?.items) return undefined;
		if (isStaleTarget) return [];
		// All-skills fallback is ONLY for the "user has zero
		// connected agents AND zero URL pin" state — where
		// Personal-project or orphan-project skills (pre-env-
		// deployment leftovers) need a place to live so the
		// user can still manage them. Pre-fix this branch fired
		// whenever `targetProjectId` was falsy, including the
		// brief window while the default-project query is
		// resolving AND the permanent state when it errors.
		// During those states the page would expose every
		// project's skills with active uninstall buttons —
		// uninstalling a row would target whatever project the
		// row carries instead of the agent the user thought
		// they'd selected. Gate strictly on `agentCount === 0`
		// to avoid that footgun.
		if (!targetProjectId) {
			// All-skills fallback ONLY when envs have RESOLVED
			// AND are confirmed empty. Pre-fix `agentCount === 0`
			// also fired during the loading window when
			// `envs === undefined` — the skills query could
			// resolve from cache faster than envs and briefly
			// expose every project's rows with row-level uninstall
			// buttons. Distinguish "still loading" from
			// "confirmed empty" before unlocking the fallback.
			if (envs !== undefined && envs.length === 0) return skillsData.items;
			// envs still loading OR has agents but the
			// default-project hasn't resolved yet (or errored) —
			// return undefined so the table shows its loading
			// skeleton / empty-state instead of a misrouted
			// action surface.
			return undefined;
		}
		return skillsData.items.filter((s) => s.project_id === targetProjectId);
	}, [skillsData, targetProjectId, isStaleTarget, envs]);

	// Orphan-project skills: rows whose project_id is NOT one of the
	// currently-connected envs' projects. Surfaces preserved skills
	// from disconnected agents so they remain manageable; without
	// this they'd disappear entirely whenever the user has any
	// active env (the picker only shows connected envs, the
	// project-filtered query filtered the rest out). Excluded from the
	// list when the user is viewing the orphan-only "no envs"
	// state above (`!targetProjectId` already shows everything).
	const orphanSkills = useMemo(() => {
		if (!skillsData?.items || !targetProjectId) return [];
		return skillsData.items.filter((s) => !s.project_id || !envProjectIds.has(s.project_id));
	}, [skillsData, envProjectIds, targetProjectId]);

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
			toast.success(
				`Uninstalled ${vars.skillKey} from ${targetAgentLabel}. Other agents keep their copies.`,
			);
			queryClient.invalidateQueries({ queryKey: ["skills"] });
		},
		onError: (e) => toast.error("Failed to uninstall skill", { description: errorMessage(e) }),
	});

	const skillColumns = useMemo(
		() =>
			makeSkillColumns(
				(skillKey, projectId) => uninstallSkill.mutate({ skillKey, projectId }),
				uninstallSkill.isPending,
				targetProjectId,
			),
		[uninstallSkill.mutate, uninstallSkill.isPending, targetProjectId],
	);

	const installSkill = async (repo: string, path?: string): Promise<boolean> => {
		const key = `${repo}/${path || ""}`;
		setInstalling(key);
		setInstallError(null);
		try {
			if (!targetProjectId) throw new Error("No target agent selected");
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
			toast.success(
				daemonHealthy
					? `Installed. Will appear on ${targetAgentLabel} within a couple seconds.`
					: `Installed. Will apply on ${targetAgentLabel} when its daemon reconnects.`,
			);
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
				description="Install reusable capabilities on an agent. Shared projects can add skills from collaborators too."
				actions={
					targetProjectId ? (
						<ShareProjectDialog projectId={targetProjectId} projectName={targetAgentLabel} />
					) : null
				}
			/>

			{defaultProjectError ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Couldn&apos;t reach your default project</AlertTitle>
					<AlertDescription>
						Install and uninstall are temporarily disabled. {errorMessage(defaultProjectError)}
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

			{/* Project picker — primary control. Single agent accounts
			    skip the picker entirely (one option, no choice to
			    make); the page just operates on that agent. */}
			{agentCount >= 2 ? (
				<AgentTargetPicker
					envs={envs ?? []}
					selectedProjectId={targetProjectId}
					targetEnv={targetEnv}
					targetAgentLabel={targetAgentLabel}
					onChange={onPickProject}
				/>
			) : null}

			{/* Installed-on-this-agent table. Same DataTable +
			    ColumnDef pattern Sessions and the agent detail
			    page use, so a row reads identically across
			    surfaces. Inline uninstall lives in the Actions
			    column on hover. */}
			<section className="space-y-2">
				<div className="flex items-baseline justify-between gap-3">
					<h2 className="text-base font-semibold">
						Installed
						{/* Just the count — the agent label is already in the
						    picker right above. Repeating "44 on
						    Jings-MacBook-Pro.local · Hermes" duplicates info
						    the eye just read in the picker chip. */}
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
					isLoading={skillsLoading}
					rowAriaLabel={(s) => `Open ${s.name}`}
					emptyMessage={
						isStaleTarget
							? "This link points to an agent that no longer exists. Pick a current agent above to manage its skills."
							: agentCount === 0
								? "Connect an agent first to install skills. Open the dashboard to add one."
								: isProjectReady
									? "No skills installed on this agent yet. Install one from the marketplace below."
									: "Pick an agent to see its skills."
					}
				/>
			</section>

			{/* Install row. Custom GitHub repo on the left, install
			    button on the right. The featured tiles below are
			    one-click installs. Both routes hit the same
			    install action. */}
			<section className="space-y-3">
				{/* "More on skills.sh" lives in the section heading
				    rather than the page header — install is the only
				    place that link is actually useful, so it sits with
				    the other install controls instead of double-billing
				    the page header. */}
				<div className="flex items-baseline justify-between gap-3">
					<h2 className="text-base font-semibold">Install more</h2>
					<a
						href="https://skills.sh"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						More on skills.sh <ExternalLink className="size-3" />
					</a>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<div className="relative min-w-[280px] flex-1">
						<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={customRepo}
							onChange={(e) => {
								setCustomRepo(e.target.value);
								setCustomRepoError(null);
								setInstallError(null);
							}}
							placeholder="Install from GitHub: owner/repo or owner/repo/path"
							className="pl-9"
							onKeyDown={(e) => {
								if (e.key === "Enter") handleCustom();
							}}
							aria-invalid={!!customRepoError || undefined}
						/>
					</div>
					<Button
						onClick={handleCustom}
						disabled={!customRepo.trim() || !!installing || !isProjectReady}
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

				<div className="space-y-2">
					<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Featured
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
												<Link
													href={`/skills/${encodeURIComponent(skill.skillKey)}${
														targetProjectId ? `?project=${encodeURIComponent(targetProjectId)}` : ""
													}`}
													className="truncate text-sm font-medium hover:underline"
												>
													{skill.name}
												</Link>
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
												disabled={isInstalling || !isProjectReady}
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

			{/* Orphan-project skills. Surfaces preserved skills whose
			    origin agent has been disconnected (backend keeps
			    the project + skills; the env is gone). This section
			    sits after install actions because maintaining old
			    projects is secondary to the common "install a skill
			    on this agent" job. The uninstall column still works
			    because each row carries its own project_id and the
			    DELETE route is project-explicit. */}
			{orphanSkills.length > 0 ? (
				<section className="space-y-2">
					<div className="flex items-baseline justify-between gap-3">
						<h2 className="text-base font-semibold">
							Other saved skills
							<span className="ml-2 text-sm font-normal text-muted-foreground">
								{orphanSkills.length}
							</span>
						</h2>
					</div>
					<p className="text-xs text-muted-foreground">
						These skills are kept from projects that are not connected to a current agent. You can
						still open or uninstall them here.
					</p>
					<DataTable
						columns={skillColumns}
						data={orphanSkills}
						rowAriaLabel={(s) => `Open ${s.name}`}
					/>
				</section>
			) : null}
		</div>
	);
}
