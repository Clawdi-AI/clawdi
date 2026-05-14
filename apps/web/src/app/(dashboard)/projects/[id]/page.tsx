"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	ExternalLink,
	GitBranch,
	KeyRound,
	LogOut,
	type LucideIcon,
	Plus,
	Share2,
	Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
import { formatApiError } from "@/components/sharing/vault-conflicts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, unwrap, useApi, useAuthedFetch } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type VaultSummary = components["schemas"]["VaultResponse"];

interface ProjectRow {
	id: string;
	name: string;
	slug: string;
	kind: string;
	origin_environment_id: string | null;
	archived_at: string | null;
	created_at: string;
	is_owner?: boolean;
	owner_display?: string | null;
	owner_handle?: string | null;
}

export default function ProjectDetailPage() {
	const params = useParams<{ id: string }>();
	const projectId = params.id;
	const api = useApi();
	const authedFetch = useAuthedFetch();
	const qc = useQueryClient();
	const router = useRouter();

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => {
			const r = await authedFetch("/api/projects");
			return r.json();
		},
	});

	const rows = projects.data ?? [];
	const project = rows.find((row) => row.id === projectId) ?? null;
	const isOwner = project?.is_owner !== false;

	const skills = useQuery({
		queryKey: ["skills", "project-detail", projectId],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/skills", {
					params: { query: { project_id: projectId, page_size: 100 } },
				}),
			),
		enabled: !!project,
	});

	const vaults = useQuery({
		queryKey: ["vaults", "project-detail", projectId],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/vault", {
					params: { query: { project_id: projectId, page_size: 100 } },
				}),
			),
		enabled: !!project,
	});

	const refresh = () => {
		qc.invalidateQueries({ queryKey: ["projects"] });
		qc.invalidateQueries({ queryKey: ["skills"] });
		qc.invalidateQueries({ queryKey: ["vaults"] });
	};

	const leaveSharedProject = useMutation({
		mutationFn: async (): Promise<{ status: string }> => {
			const r = await authedFetch(`/api/projects/${projectId}/leave`, { method: "POST" });
			return r.json();
		},
		onSuccess: () => {
			refresh();
			toast.success("Left shared project", { description: "Membership removed." });
			router.push("/projects");
		},
		onError: (e) => {
			toast.error("Failed to leave shared project", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	if (projects.isLoading) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Skeleton className="h-10 w-52" />
				<Skeleton className="h-28 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	if (projects.error) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Button asChild variant="ghost" size="sm" className="w-fit">
					<Link href="/projects">
						<ArrowLeft className="mr-1.5 size-4" />
						Projects
					</Link>
				</Button>
				<Alert variant="destructive">
					<AlertTitle>Couldn&apos;t load project</AlertTitle>
					<AlertDescription>{errorMessage(projects.error)}</AlertDescription>
				</Alert>
			</div>
		);
	}

	if (!project) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Button asChild variant="ghost" size="sm" className="w-fit">
					<Link href="/projects">
						<ArrowLeft className="mr-1.5 size-4" />
						Projects
					</Link>
				</Button>
				<Alert>
					<AlertTitle>Project not found</AlertTitle>
					<AlertDescription>
						This project may have been removed, or your account no longer has access.
					</AlertDescription>
				</Alert>
			</div>
		);
	}

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<Button asChild variant="ghost" size="sm" className="w-fit">
				<Link href="/projects">
					<ArrowLeft className="mr-1.5 size-4" />
					Projects
				</Link>
			</Button>

			<PageHeader
				title={displayProjectName(project)}
				description={`${isOwner ? "Owned" : "Shared viewer"} · ${projectKindMeta(project.kind).label} · ${project.slug}`}
				actions={
					<div className="flex items-center gap-2">
						<ProjectKindBadge kind={project.kind} />
						{isOwner ? (
							<ShareProjectDialog
								projectId={project.id}
								projectName={displayProjectName(project)}
								projectKind={project.kind}
							>
								<Button variant="outline" size="sm">
									<Share2 className="mr-1.5 size-3.5" />
									Share
								</Button>
							</ShareProjectDialog>
						) : null}
					</div>
				}
			/>

			<ProjectStatsStrip
				skillCount={skills.data?.items.length ?? 0}
				vaultCount={vaults.data?.items.length ?? 0}
			/>

			{!isOwner ? <SharedReadOnlyNotice project={project} /> : null}

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
				<div className="space-y-6">
					<section className="space-y-3">
						<ContentHeader
							title="Skills"
							description={
								isOwner
									? "Reusable instructions stored directly in this project."
									: "Readable shared instructions. You cannot edit this project's content."
							}
						/>
						{isOwner ? (
							<InstallSkillInProjectForm projectId={project.id} onChanged={refresh} />
						) : null}
						{skills.isLoading ? (
							<Skeleton className="h-24 w-full" />
						) : skills.error ? (
							<ErrorLine message={errorMessage(skills.error)} />
						) : skills.data?.items.length ? (
							<div className="divide-y rounded-lg border">
								{skills.data.items.map((skill) => (
									<SkillRow
										key={`${skill.project_id}:${skill.skill_key}`}
										skill={skill}
										ownProjectId={project.id}
									/>
								))}
							</div>
						) : (
							<EmptyLine message="No skills are visible in this project yet." />
						)}
					</section>

					<section className="space-y-3">
						<ContentHeader
							title="Vault references"
							description={
								isOwner
									? "Project-owned vault references available to bound agents."
									: "Read-only vault reference names from the project owner."
							}
						/>
						{isOwner ? (
							<CreateVaultInProjectForm projectId={project.id} onChanged={refresh} />
						) : null}
						{vaults.isLoading ? (
							<Skeleton className="h-24 w-full" />
						) : vaults.error ? (
							<ErrorLine message={errorMessage(vaults.error)} />
						) : vaults.data?.items.length ? (
							<div className="divide-y rounded-lg border">
								{vaults.data.items.map((vault) => (
									<VaultRow key={vault.id} vault={vault} ownProjectId={project.id} />
								))}
							</div>
						) : (
							<EmptyLine message="No vault references are visible in this project yet." />
						)}
					</section>
				</div>

				<aside className="space-y-4">
					{isOwner ? (
						<OwnerAccessPanel project={project} />
					) : (
						<SharedAccessPanel
							project={project}
							isLeaving={leaveSharedProject.isPending}
							onLeave={() => leaveSharedProject.mutate()}
						/>
					)}
				</aside>
			</div>
		</div>
	);
}

function SharedReadOnlyNotice({ project }: { project: ProjectRow }) {
	return (
		<Alert>
			<GitBranch className="size-4" />
			<AlertTitle>Viewer access</AlertTitle>
			<AlertDescription>
				You can read this project
				{project.owner_display ? ` from ${project.owner_display}` : ""}. It will not affect any
				agent until you bind it as an attached context.
			</AlertDescription>
		</Alert>
	);
}

function OwnerAccessPanel({ project }: { project: ProjectRow }) {
	const projectName = displayProjectName(project);
	return (
		<section className="space-y-4 rounded-lg border bg-card/60 p-4">
			<div className="space-y-1">
				<div className="flex items-center gap-2">
					<Share2 className="size-4 text-muted-foreground" />
					<h2 className="text-sm font-semibold">Collaboration</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					Manage people, pending invites, and share links for this project. Shared members join as
					read-only viewers.
				</p>
			</div>
			<div className="grid gap-2 text-xs text-muted-foreground">
				<div className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2">
					<span>Default shared role</span>
					<Badge variant="secondary">viewer</Badge>
				</div>
				<div className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2">
					<span>Agent access</span>
					<span className="font-medium text-foreground">Explicit binding</span>
				</div>
			</div>
			<ShareProjectDialog
				projectId={project.id}
				projectName={projectName}
				projectKind={project.kind}
			>
				<Button className="w-full" size="sm">
					<Share2 className="mr-1.5 size-3.5" />
					Share / manage access
				</Button>
			</ShareProjectDialog>
		</section>
	);
}

function SharedAccessPanel({
	project,
	isLeaving,
	onLeave,
}: {
	project: ProjectRow;
	isLeaving: boolean;
	onLeave: () => void;
}) {
	const alias = project.owner_handle ? `@${project.owner_handle}/${project.slug}` : project.slug;
	return (
		<section className="space-y-4 rounded-lg border bg-card/60 p-4">
			<div className="space-y-1">
				<div className="flex items-center gap-2">
					<GitBranch className="size-4 text-muted-foreground" />
					<h2 className="text-sm font-semibold">Access</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					You are a read-only viewer. Bind this project to an agent when you want its context in
					runtime resolution.
				</p>
			</div>
			<div className="space-y-2 rounded-md border bg-background/60 p-3 text-xs">
				<div className="flex items-center justify-between gap-3">
					<span className="text-muted-foreground">Role</span>
					<Badge variant="secondary">viewer</Badge>
				</div>
				<div className="flex items-center justify-between gap-3">
					<span className="text-muted-foreground">Owner</span>
					<span className="truncate font-medium">
						{project.owner_display ?? project.owner_handle ?? "Unknown"}
					</span>
				</div>
				<div className="truncate font-mono text-muted-foreground">{alias}</div>
			</div>
			<Button asChild size="sm" className="w-full">
				<Link href="/agents">
					<GitBranch className="mr-1.5 size-3.5" />
					Bind to agent
				</Link>
			</Button>
			<AlertDialog>
				<AlertDialogTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						disabled={isLeaving}
						className="w-full text-muted-foreground hover:text-destructive"
					>
						<LogOut className="mr-1.5 size-3.5" />
						{isLeaving ? "Leaving..." : "Leave project"}
					</Button>
				</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Leave "{displayProjectName(project)}"?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes your read-only membership. Any context binding for this project stops
							applying to your agents.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={onLeave}
							className="bg-destructive text-white hover:bg-destructive/90"
						>
							Leave project
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}

function ProjectStatsStrip({ skillCount, vaultCount }: { skillCount: number; vaultCount: number }) {
	return (
		<div className="grid divide-y rounded-lg border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
			<StatCell icon={Sparkles} label="Skills" value={skillCount} />
			<StatCell icon={KeyRound} label="Vaults" value={vaultCount} />
		</div>
	);
}

function StatCell({
	icon: Icon,
	label,
	value,
}: {
	icon: LucideIcon;
	label: string;
	value: number;
}) {
	return (
		<div className="flex items-center justify-between gap-3 px-4 py-3">
			<div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
				<Icon className="size-4 shrink-0" />
				<span className="truncate">{label}</span>
			</div>
			<div className="text-xl font-semibold">{value}</div>
		</div>
	);
}

function ContentHeader({ title, description }: { title: string; description: string }) {
	return (
		<div className="space-y-1">
			<h2 className="text-base font-semibold">{title}</h2>
			<p className="text-xs text-muted-foreground">{description}</p>
		</div>
	);
}

function InstallSkillInProjectForm({
	projectId,
	onChanged,
}: {
	projectId: string;
	onChanged: () => void;
}) {
	const api = useApi();
	const [repoInput, setRepoInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const install = useMutation({
		mutationFn: async ({ repo, path }: { repo: string; path?: string }) =>
			unwrap(
				await api.POST("/api/projects/{project_id}/skills/install", {
					params: { path: { project_id: projectId } },
					body: { repo, path },
				}),
			),
		onSuccess: () => {
			setRepoInput("");
			setError(null);
			onChanged();
			toast.success("Skill installed in this project");
		},
		onError: (e) => {
			setError(errorMessage(e));
		},
	});

	const submit = () => {
		setError(null);
		const trimmed = repoInput.trim();
		if (!trimmed) return;
		const clean = trimmed.replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
		const parts = clean.split("/").filter(Boolean);
		if (parts.length < 2) {
			setError("Enter as `owner/repo` or `owner/repo/path-to-skill`.");
			return;
		}
		install.mutate({
			repo: `${parts[0]}/${parts[1]}`,
			path: parts.length > 2 ? parts.slice(2).join("/") : undefined,
		});
	};

	return (
		<div className="flex max-w-3xl flex-col gap-2 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:flex-wrap sm:items-center">
			<Input
				value={repoInput}
				onChange={(e) => {
					setRepoInput(e.target.value);
					setError(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") submit();
				}}
				placeholder="Install skill from GitHub: owner/repo or owner/repo/path"
				aria-invalid={!!error || undefined}
				className="min-w-0 flex-1"
			/>
			<Button
				size="sm"
				disabled={!repoInput.trim() || install.isPending}
				onClick={submit}
				className="w-full sm:w-auto"
			>
				{install.isPending ? <Spinner /> : <Plus className="mr-1.5 size-3.5" />}
				Install skill
			</Button>
			{error ? <p className="text-xs text-destructive sm:basis-full">{error}</p> : null}
		</div>
	);
}

function CreateVaultInProjectForm({
	projectId,
	onChanged,
}: {
	projectId: string;
	onChanged: () => void;
}) {
	const api = useApi();
	const [slug, setSlug] = useState("");
	const create = useMutation({
		mutationFn: async (nextSlug: string) =>
			unwrap(
				await api.POST("/api/vault", {
					params: { query: { project_id: projectId } },
					body: { slug: nextSlug, name: nextSlug },
				}),
			),
		onSuccess: () => {
			setSlug("");
			onChanged();
			toast.success("Vault created in this project");
		},
		onError: (e) => toast.error("Failed to create vault", { description: errorMessage(e) }),
	});

	return (
		<div className="flex max-w-3xl flex-col gap-2 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center">
			<Input
				value={slug}
				onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
				onKeyDown={(e) => {
					if (e.key === "Enter" && slug) create.mutate(slug);
				}}
				placeholder="New vault name for this project"
				className="min-w-0 flex-1"
			/>
			<Button
				size="sm"
				disabled={!slug || create.isPending}
				onClick={() => slug && create.mutate(slug)}
				className="w-full sm:w-auto"
			>
				{create.isPending ? <Spinner /> : <Plus className="mr-1.5 size-3.5" />}
				Create vault
			</Button>
		</div>
	);
}

function SkillRow({ skill, ownProjectId }: { skill: SkillSummary; ownProjectId: string }) {
	const direct = skill.project_id === ownProjectId;
	return (
		<div className="flex items-center justify-between gap-3 p-3">
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm font-medium">{skill.name}</span>
					<Badge variant={direct ? "secondary" : "outline"}>{direct ? "direct" : "linked"}</Badge>
				</div>
				<div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
					{skill.skill_key}
				</div>
			</div>
			<Button asChild variant="ghost" size="icon-sm">
				<Link
					href={`/skills/${encodeURIComponent(skill.skill_key)}?project=${encodeURIComponent(skill.project_id ?? ownProjectId)}`}
					aria-label={`Open ${skill.name}`}
				>
					<ExternalLink className="size-3.5" />
				</Link>
			</Button>
		</div>
	);
}

function VaultRow({ vault, ownProjectId }: { vault: VaultSummary; ownProjectId: string }) {
	const direct = vault.project_id === ownProjectId;
	return (
		<div className="flex items-center justify-between gap-3 p-3">
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm font-medium">{vault.name}</span>
					<Badge variant={direct ? "secondary" : "outline"}>{direct ? "direct" : "linked"}</Badge>
				</div>
				<div className="mt-0.5 font-mono text-xs text-muted-foreground">{vault.slug}</div>
			</div>
			<Button asChild variant="ghost" size="icon-sm">
				<Link href="/vault" aria-label="Open vault page">
					<ExternalLink className="size-3.5" />
				</Link>
			</Button>
		</div>
	);
}

function ProjectKindBadge({ kind }: { kind: string }) {
	const meta = projectKindMeta(kind);
	return (
		<Badge
			variant={kind === "personal" ? "outline" : "secondary"}
			className="text-xs"
			title={meta.description}
		>
			{meta.label}
		</Badge>
	);
}

function projectKindMeta(kind: string) {
	if (kind === "workspace") {
		return {
			label: "Project",
			description: "Reusable context for a project, team, or workflow.",
		};
	}
	if (kind === "environment") {
		return {
			label: "Environment",
			description: "Project created by an agent environment.",
		};
	}
	if (kind === "personal") {
		return {
			label: "Personal",
			description: "Personal default project.",
		};
	}
	return { label: kind, description: `Project type: ${kind}` };
}

function displayProjectName(project: ProjectRow) {
	if (
		project.kind === "personal" &&
		(project.slug === "personal" || ["default", "personal"].includes(project.name.toLowerCase()))
	) {
		return "Personal";
	}
	return project.name;
}

function EmptyLine({ message }: { message: string }) {
	return (
		<div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
			{message}
		</div>
	);
}

function ErrorLine({ message }: { message: string }) {
	return (
		<div className="rounded-lg border border-dashed border-destructive/40 px-4 py-4 text-sm text-destructive">
			{message}
		</div>
	);
}
