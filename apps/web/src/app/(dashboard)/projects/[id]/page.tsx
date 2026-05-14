"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	BookOpen,
	Bot,
	ExternalLink,
	Eye,
	KeyRound,
	LogOut,
	type LucideIcon,
	Plus,
	Share2,
	Sparkles,
	Users,
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
				description={`${isOwner ? "Project workspace" : "Shared workspace"} · ${project.slug}`}
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

			<OverviewCard
				project={project}
				isOwner={isOwner}
				skillCount={skills.data?.items.length ?? 0}
				vaultCount={vaults.data?.items.length ?? 0}
			/>

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
				<div className="space-y-6">
					<section className="space-y-5 rounded-lg border bg-card/60 p-4">
						<ContentHeader
							title="Content library"
							description={
								isOwner
									? "Skills and vault references saved in this workspace."
									: "Shared resources you can read from this workspace."
							}
						/>
						<ProjectStatsStrip
							skillCount={skills.data?.items.length ?? 0}
							vaultCount={vaults.data?.items.length ?? 0}
						/>
						<div className="space-y-5">
							<div className="space-y-3">
								<ContentHeader
									title="Skills"
									description={
										isOwner
											? "Reusable instructions stored in this workspace."
											: "Readable instructions shared by the owner."
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
									<div className="divide-y rounded-lg border bg-background/50">
										{skills.data.items.map((skill) => (
											<SkillRow
												key={`${skill.project_id}:${skill.skill_key}`}
												skill={skill}
												ownProjectId={project.id}
											/>
										))}
									</div>
								) : (
									<EmptyLine message="No skills are visible in this workspace yet." />
								)}
							</div>

							<div className="space-y-3">
								<ContentHeader
									title="Vault references"
									description={
										isOwner
											? "Vault key references saved in this workspace."
											: "Read-only vault key names shared by the owner."
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
									<div className="divide-y rounded-lg border bg-background/50">
										{vaults.data.items.map((vault) => (
											<VaultRow key={vault.id} vault={vault} ownProjectId={project.id} />
										))}
									</div>
								) : (
									<EmptyLine message="No vault references are visible in this workspace yet." />
								)}
							</div>
						</div>
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

function OverviewCard({
	project,
	isOwner,
	skillCount,
	vaultCount,
}: {
	project: ProjectRow;
	isOwner: boolean;
	skillCount: number;
	vaultCount: number;
}) {
	const owner = isOwner ? "You" : (project.owner_display ?? project.owner_handle ?? "Unknown");
	return (
		<section className="rounded-lg border bg-card/60 p-4">
			<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
				<div className="min-w-0 space-y-3">
					<div className="flex flex-wrap items-center gap-2">
						<BookOpen className="size-4 text-muted-foreground" />
						<h2 className="text-sm font-semibold">Overview</h2>
						<Badge variant={isOwner ? "outline" : "secondary"}>
							{isOwner ? "owner" : "viewer"}
						</Badge>
						<ProjectKindBadge kind={project.kind} />
					</div>
					<div className="grid gap-2 text-sm sm:grid-cols-3">
						<OverviewField label="Workspace" value={displayProjectName(project)} />
						<OverviewField label="Owner" value={owner} />
						<OverviewField label="Access" value={isOwner ? "Edit and share" : "Read-only viewer"} />
					</div>
				</div>
				<div className="grid min-w-52 gap-2 rounded-md border bg-background/60 p-3 text-xs text-muted-foreground">
					<div className="flex items-center justify-between gap-3">
						<span>Skills</span>
						<span className="font-semibold text-foreground">{skillCount}</span>
					</div>
					<div className="flex items-center justify-between gap-3">
						<span>Vault refs</span>
						<span className="font-semibold text-foreground">{vaultCount}</span>
					</div>
					<div className="truncate font-mono">{project.slug}</div>
				</div>
			</div>
		</section>
	);
}

function OverviewField({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-md border bg-background/60 px-3 py-2">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="mt-1 truncate font-medium">{value}</div>
		</div>
	);
}

function OwnerAccessPanel({ project }: { project: ProjectRow }) {
	const projectName = displayProjectName(project);
	return (
		<section className="space-y-4 rounded-lg border bg-card/60 p-4">
			<div className="space-y-1">
				<div className="flex items-center gap-2">
					<Users className="size-4 text-muted-foreground" />
					<h2 className="text-sm font-semibold">Collaborators and access</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					Manage people, pending invites, and share links for this workspace. New members join as
					viewers by default.
				</p>
			</div>
			<div className="grid gap-2 text-xs text-muted-foreground">
				<div className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2">
					<span>Default role</span>
					<Badge variant="secondary">viewer</Badge>
				</div>
				<div className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2">
					<span>Manage</span>
					<span className="font-medium text-foreground">People, Invites, Links</span>
				</div>
			</div>
			<ShareProjectDialog
				projectId={project.id}
				projectName={projectName}
				projectKind={project.kind}
			>
				<Button className="w-full" size="sm">
					<Share2 className="mr-1.5 size-3.5" />
					Manage sharing
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
					<Eye className="size-4 text-muted-foreground" />
					<h2 className="text-sm font-semibold">You have viewer access</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					You can read this workspace. Attach this project to an agent when you want it available
					during a run.
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
					<Bot className="mr-1.5 size-3.5" />
					Use with agent
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
							This removes your read-only membership. Agents will no longer be able to use this
							project through your account.
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
		<div className="grid divide-y rounded-md bg-muted/20 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
			<StatCell icon={Sparkles} label="Skills" value={skillCount} />
			<StatCell icon={KeyRound} label="Vault refs" value={vaultCount} />
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
			description: "Shared workspace for a project, team, or workflow.",
		};
	}
	if (kind === "environment") {
		return {
			label: "Environment",
			description: "Workspace created by an agent environment.",
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
