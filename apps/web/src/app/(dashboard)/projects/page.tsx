"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bot, FolderOpen, type LucideIcon, Plus, Share2, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { displayProjectName, ProjectIdentity } from "@/components/projects/project-metadata";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
import { formatApiError } from "@/components/sharing/vault-conflicts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, useAuthedFetch } from "@/lib/api";
import { getProjectResourceDefinition, projectDetailHref } from "@/lib/project-resource-model";
import { errorMessage } from "@/lib/utils";

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

const PROJECTS_RESOURCE = getProjectResourceDefinition("projects");

export default function ProjectsPage() {
	const authedFetch = useAuthedFetch();
	const qc = useQueryClient();
	const router = useRouter();
	const [newProjectName, setNewProjectName] = useState("");
	const [newProjectSlug, setNewProjectSlug] = useState("");
	const [createOpen, setCreateOpen] = useState(false);

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => {
			const r = await authedFetch("/api/projects");
			return r.json();
		},
	});

	const rows = projects.data ?? [];
	const ownedProjects = useMemo(
		() => rows.filter((s) => s.is_owner !== false).sort(compareProjectsForProductUse),
		[rows],
	);
	const sharedProjects = useMemo(
		() => rows.filter((s) => s.is_owner === false).sort(compareProjectsForProductUse),
		[rows],
	);

	const createProject = useMutation({
		mutationFn: async (): Promise<ProjectRow> => {
			const payload: { name: string; slug?: string } = { name: newProjectName.trim() };
			const slug = normalizeSlugInput(newProjectSlug);
			if (slug) payload.slug = slug;
			const r = await authedFetch("/api/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			return r.json();
		},
		onSuccess: (project) => {
			setNewProjectName("");
			setNewProjectSlug("");
			setCreateOpen(false);
			qc.invalidateQueries({ queryKey: ["projects"] });
			toast.success("Project created", {
				description: `${project.name} is ready for skills, vault references, and sharing.`,
			});
			router.push(projectDetailHref(project.id));
		},
		onError: (e) => {
			toast.error("Failed to create project", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	if (projects.isLoading) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<PageHeader title="Projects" description={PROJECTS_RESOURCE.managementDescription} />
				<Skeleton className="h-36 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Projects"
				description={PROJECTS_RESOURCE.managementDescription}
				actions={
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							setNewProjectName("");
							setNewProjectSlug("");
							setCreateOpen(true);
						}}
					>
						<Plus className="size-3.5" />
						New Project
					</Button>
				}
			/>

			{projects.error ? (
				<Alert variant="destructive">
					<AlertTitle>Couldn&apos;t load projects</AlertTitle>
					<AlertDescription>{errorMessage(projects.error)}</AlertDescription>
				</Alert>
			) : null}

			<Dialog
				open={createOpen}
				onOpenChange={(open) => {
					setCreateOpen(open);
					if (!open) {
						setNewProjectName("");
						setNewProjectSlug("");
					}
				}}
			>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>New Project</DialogTitle>
						<DialogDescription>
							Create a Project for a team or workflow. Add skills, vault references, and access
							settings from the Project detail page.
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (!newProjectName.trim() || createProject.isPending) return;
							createProject.mutate();
						}}
					>
						<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
							<div className="space-y-1.5">
								<Label htmlFor="project-name">Name</Label>
								<Input
									id="project-name"
									name="project-name"
									value={newProjectName}
									maxLength={200}
									placeholder="Project name…"
									autoComplete="off"
									onChange={(event) => setNewProjectName(event.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="project-slug">Slug</Label>
								<Input
									id="project-slug"
									name="project-slug"
									value={newProjectSlug}
									maxLength={80}
									placeholder="auto-generated…"
									autoComplete="off"
									spellCheck={false}
									onChange={(event) => setNewProjectSlug(normalizeSlugDraft(event.target.value))}
								/>
							</div>
						</div>
						<div className="flex justify-end gap-2">
							<Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!newProjectName.trim() || createProject.isPending}>
								<Plus className="size-3.5" />
								{createProject.isPending ? "Creating…" : "Create Project"}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			<ProjectSummaryCards
				ownedCount={ownedProjects.length}
				sharedCount={sharedProjects.length}
				totalCount={rows.length}
				onCreate={() => {
					setNewProjectName("");
					setNewProjectSlug("");
					setCreateOpen(true);
				}}
			/>

			<section className="space-y-3">
				<SectionHeader
					title="My Projects"
					count={ownedProjects.length}
					description="Projects you own. Add resources, invite people, and choose when agents use them."
				/>
				{ownedProjects.length === 0 ? (
					<EmptyLine
						title="Create Your First Collaboration Project"
						message="Use Projects you want to share and reuse across people and agents."
						action={
							<Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
								<Plus className="size-3.5" />
								New Project
							</Button>
						}
					/>
				) : (
					<div className="divide-y rounded-lg border bg-card/60">
						{ownedProjects.map((project) => (
							<OwnedProjectRow key={project.id} project={project} />
						))}
					</div>
				)}
			</section>

			<section className="space-y-3">
				<SectionHeader
					title="Shared With Me"
					count={sharedProjects.length}
					description="Projects other people shared with you. Open them or use them with an agent when needed."
				/>
				{sharedProjects.length === 0 ? (
					<EmptyLine
						title="No Shared Projects Yet"
						message="Accepted invites and share links appear here with viewer access. Pending collaboration invites are available from the inbox in the top bar; using a shared Project with an agent is your choice."
					/>
				) : (
					<div className="divide-y rounded-lg border bg-card/60">
						{sharedProjects.map((project) => (
							<SharedProjectRow key={project.id} project={project} />
						))}
					</div>
				)}
			</section>
		</div>
	);
}

function OwnedProjectRow({ project }: { project: ProjectRow }) {
	const projectName = displayProjectName(project);
	return (
		<div className="group px-4 py-4 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-muted/20">
			<div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
				<div className="min-w-0">
					<ProjectIdentity project={project} />
					<p className="mt-1 text-xs text-muted-foreground">
						Owner access. Add resources, invite people, and share links.
					</p>
				</div>
				<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
					<Button asChild variant="outline" size="sm">
						<Link href={projectDetailHref(project.id)}>
							Open
							<ArrowRight className="size-3.5" />
						</Link>
					</Button>
					<ShareProjectDialog
						projectId={project.id}
						projectName={projectName}
						projectKind={project.kind}
					>
						<Button variant="outline" size="sm" aria-label={`Share ${projectName}`}>
							<Share2 className="mr-1.5 size-3.5" />
							Share
						</Button>
					</ShareProjectDialog>
				</div>
			</div>
		</div>
	);
}

function SharedProjectRow({ project }: { project: ProjectRow }) {
	return (
		<div className="group px-4 py-4 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-muted/20">
			<div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
				<div className="min-w-0">
					<ProjectIdentity project={project} />
					<p className="mt-1 text-xs text-muted-foreground">
						Viewer access is read-only. Attach it to an agent when you choose.
					</p>
				</div>
				<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
					<Button asChild variant="outline" size="sm">
						<Link href={projectDetailHref(project.id)}>
							Open
							<ArrowRight className="size-3.5" />
						</Link>
					</Button>
					<Button asChild variant="outline" size="sm">
						<Link href={`${projectDetailHref(project.id)}?useWithAgent=1`}>
							<Bot className="mr-1.5 size-3.5" />
							Attach to Agent
						</Link>
					</Button>
				</div>
			</div>
		</div>
	);
}

function ProjectSummaryCards({
	ownedCount,
	sharedCount,
	totalCount,
	onCreate,
}: {
	ownedCount: number;
	sharedCount: number;
	totalCount: number;
	onCreate: () => void;
}) {
	return (
		<div className="grid gap-3 md:grid-cols-3">
			<SummaryCard
				icon={FolderOpen}
				label="My Projects"
				value={ownedCount}
				description="Projects you own and can share."
				action={
					<Button variant="ghost" size="sm" onClick={onCreate} className="h-7 px-2">
						<Plus className="size-3.5" />
						New
					</Button>
				}
			/>
			<SummaryCard
				icon={Users}
				label="Shared With Me"
				value={sharedCount}
				description="Viewer access from other owners."
			/>
			<SummaryCard
				icon={Bot}
				label="Ready for Agents"
				value={totalCount}
				description="Available to use with agents when you choose."
			/>
		</div>
	);
}

function SummaryCard({
	icon: Icon,
	label,
	value,
	description,
	action,
}: {
	icon: LucideIcon;
	label: string;
	value: number;
	description: string;
	action?: React.ReactNode;
}) {
	return (
		<div className="rounded-lg border bg-card/60 p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2 text-sm font-medium">
					<Icon className="size-4 text-muted-foreground" />
					<span className="truncate">{label}</span>
				</div>
				{action}
			</div>
			<div className="mt-3 text-2xl font-semibold">{value}</div>
			<p className="mt-1 text-xs text-muted-foreground">{description}</p>
		</div>
	);
}

function SectionHeader({
	title,
	count,
	description,
}: {
	title: string;
	count: number;
	description: string;
}) {
	return (
		<div className="space-y-1 px-1">
			<div className="flex items-center gap-2">
				<h2 className="text-base font-semibold">{title}</h2>
				<Badge variant="secondary" className="text-xs">
					{count}
				</Badge>
			</div>
			<p className="text-xs text-muted-foreground">{description}</p>
		</div>
	);
}

function normalizeSlugInput(value: string) {
	return normalizeSlugDraft(value).replace(/-+$/, "");
}

function normalizeSlugDraft(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+/, "");
}

function compareProjectsForProductUse(a: ProjectRow, b: ProjectRow) {
	const rank = (kind: string) => (kind === "workspace" ? 0 : kind === "personal" ? 1 : 2);
	const byRank = rank(a.kind) - rank(b.kind);
	if (byRank !== 0) return byRank;
	return a.name.localeCompare(b.name);
}

function EmptyLine({
	title,
	message,
	action,
}: {
	title: string;
	message: string;
	action?: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-3 rounded-lg border border-dashed px-4 py-6 sm:flex-row sm:items-center sm:justify-between">
			<div className="space-y-1">
				<h3 className="text-sm font-medium">{title}</h3>
				<p className="max-w-2xl text-sm text-muted-foreground">{message}</p>
			</div>
			{action ? <div className="shrink-0">{action}</div> : null}
		</div>
	);
}
