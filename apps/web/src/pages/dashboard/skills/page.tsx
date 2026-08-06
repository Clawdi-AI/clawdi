"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FolderKanban, Import as ImportIcon, Plus } from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import {
	displayProjectName,
	isCustomProject,
	isProjectOwner,
	ProjectCompactPicker,
} from "@/components/projects/project-metadata";
import {
	ProjectResourceCard,
	ProjectResourceCardSkeleton,
} from "@/components/projects/project-resource-card";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
import { SkillCardGrid } from "@/components/skills/skill-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { shouldBlockQueryError } from "@/lib/query-state";
import { isBrowserWritableSkillProject, skillCapabilities } from "@/lib/skill-authority";
import { cn, errorMessage } from "@/lib/utils";

type ProjectRow = components["schemas"]["ProjectResponse"];

const PAGE_SIZE = 30;

export default function SkillsPage() {
	return (
		<Suspense fallback={null}>
			<SkillsPageInner />
		</Suspense>
	);
}

function SkillsPageInner() {
	const api = useApi();
	const $api = useOpenApi();
	const queryClient = useQueryClient();
	const [projectParam, setProjectParam] = useQueryState(
		"project",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true, history: "push" }),
	);
	const [legacyTarget, setLegacyTarget] = useQueryState(
		"target",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true, history: "replace" }),
	);
	const [addParam, setAddParam] = useQueryState(
		"add",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true, history: "replace" }),
	);
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(1);
	const [createOpen, setCreateOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);

	const projectsQuery = $api.useQuery("get", "/v1/projects", {});
	const projects = useMemo(
		() =>
			(projectsQuery.data ?? [])
				.filter(isCustomProject)
				.sort((left, right) => displayProjectName(left).localeCompare(displayProjectName(right))),
		[projectsQuery.data],
	);
	const selectedProject = useMemo(
		() => projects.find((project) => project.id === projectParam) ?? null,
		[projectParam, projects],
	);
	const projectResolved = projectsQuery.data !== undefined;
	const staleProject = Boolean(projectParam && projectResolved && !selectedProject);
	const projectError = shouldBlockQueryError(projectsQuery.error, projectsQuery.data)
		? projectsQuery.error
		: null;

	useEffect(() => {
		setPage(1);
	}, [projectParam, search]);

	const skillsQuery = useQuery({
		queryKey: ["skills", "project", selectedProject?.id, search.trim(), page],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/skills", {
					params: {
						query: {
							project_id: selectedProject?.id,
							q: search.trim() || undefined,
							page,
							page_size: PAGE_SIZE,
						},
					},
				}),
			),
		enabled: Boolean(selectedProject),
	});
	const skillsError = shouldBlockQueryError(skillsQuery.error, skillsQuery.data)
		? skillsQuery.error
		: null;
	const skills = skillsQuery.data?.items ?? [];
	const total = skillsQuery.data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
	useEffect(() => {
		setPage((current) => Math.min(current, pageCount));
	}, [pageCount]);
	const writable = Boolean(
		selectedProject &&
			isBrowserWritableSkillProject(selectedProject) &&
			isProjectOwner(selectedProject),
	);
	useEffect(() => {
		if (addParam !== "1" || !projectResolved) return;
		if (selectedProject && writable) {
			setCreateOpen(true);
			return;
		}
		void setAddParam("");
	}, [addParam, projectResolved, selectedProject, setAddParam, writable]);
	const handleCreateOpenChange = (nextOpen: boolean) => {
		setCreateOpen(nextOpen);
		if (!nextOpen && addParam === "1") void setAddParam("");
	};

	const selectProject = (projectId: string) => {
		void setProjectParam(projectId);
		void setLegacyTarget("");
	};

	const removeSkill = useMutation({
		mutationFn: async (skillKey: string) => {
			if (!selectedProject || !writable) throw new Error("This Project is read-only");
			return unwrap(
				await api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
					params: {
						path: { project_id: selectedProject.id, skill_key: skillKey },
					},
				}),
			);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["skills", "project"] });
			toast.success("Skill removed");
		},
		onError: (error) => toast.error("Couldn't remove skill", { description: errorMessage(error) }),
	});

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6")}>
			<PageHeader
				title="Skills"
				description={
					selectedProject
						? `Skills in ${displayProjectName(selectedProject)}. Linked Agents use the whole Project.`
						: "Choose a Project to view or add its Skills."
				}
				actions={
					selectedProject ? (
						<div className="flex flex-wrap items-center gap-2">
							{isProjectOwner(selectedProject) ? (
								<ShareProjectDialog
									projectId={selectedProject.id}
									projectName={displayProjectName(selectedProject)}
									projectKind={selectedProject.kind}
								/>
							) : null}
							{writable ? (
								<>
									<Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
										<ImportIcon />
										Import from GitHub
									</Button>
									<Button size="sm" onClick={() => setCreateOpen(true)}>
										<Plus />
										Add skill
									</Button>
								</>
							) : null}
						</div>
					) : undefined
				}
			/>

			{projectError ? (
				<ApiErrorPanel
					error={projectError}
					onRetry={() => void projectsQuery.refetch()}
					title="Couldn't load Projects"
				/>
			) : null}

			{legacyTarget && !projectParam ? (
				<Alert>
					<AlertTitle>Agent Workspace Skills moved to the Agent</AlertTitle>
					<AlertDescription className="space-y-2">
						<p>
							A Workspace contains one Agent&apos;s private resources. Open that Agent to view its
							Workspace Skills, or choose a Project here.
						</p>
						<Button
							variant="outline"
							size="sm"
							render={<Link to="/agents/$id/skills" params={{ id: legacyTarget }} />}
						>
							Open workspace
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{staleProject ? (
				<Alert>
					<AlertTitle>Project unavailable</AlertTitle>
					<AlertDescription>
						Choose another Project. It may have been archived or your access may have changed.
					</AlertDescription>
				</Alert>
			) : null}

			{!selectedProject ? (
				<ProjectSelection projects={projects} loading={!projectResolved && !projectError} />
			) : (
				<>
					<ListToolbar
						search={
							<SearchInput value={search} onChange={setSearch} placeholder="Search this Project…" />
						}
						filters={
							<ProjectCompactPicker
								projects={projects}
								value={selectedProject.id}
								onValueChange={selectProject}
								placeholder="Choose a Project"
								ariaLabel="Choose Project"
								className="w-full sm:w-72"
							/>
						}
					/>

					{!writable ? (
						<Alert>
							<AlertTitle>Read-only Project</AlertTitle>
							<AlertDescription>
								You can view these Skills. Only the Project owner can add, edit, copy, move, or
								remove them.
							</AlertDescription>
						</Alert>
					) : null}

					{skillsError ? (
						<ApiErrorPanel
							error={skillsError}
							onRetry={() => void skillsQuery.refetch()}
							title="Couldn't load skills"
						/>
					) : null}

					<SkillCardGrid
						skills={skills}
						isLoading={skillsQuery.isLoading}
						emptyMessage={
							search.trim()
								? "No Skills in this Project match that search."
								: writable
									? "No Skills yet. Add one with instructions or import one from GitHub."
									: "No Skills are in this Project yet."
						}
						capabilitiesFor={(skill) => skillCapabilities(skill, selectedProject)}
						onUninstall={writable ? (skillKey) => removeSkill.mutate(skillKey) : undefined}
						uninstallPending={removeSkill.isPending}
					/>

					{total > PAGE_SIZE ? (
						<div className="flex items-center justify-between gap-3 border-t pt-4">
							<p className="text-sm text-muted-foreground tabular-nums">
								Page {page} of {pageCount} · {total} Skills
							</p>
							<div className="flex items-center gap-2">
								<Button
									variant="outline"
									size="sm"
									disabled={page <= 1 || skillsQuery.isFetching}
									onClick={() => setPage((current) => Math.max(1, current - 1))}
								>
									Previous
								</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={page >= pageCount || skillsQuery.isFetching}
									onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
								>
									Next
								</Button>
							</div>
						</div>
					) : null}
				</>
			)}

			{selectedProject ? (
				<>
					<CreateSkillDialog
						open={createOpen}
						onOpenChange={handleCreateOpenChange}
						project={selectedProject}
					/>
					<ImportSkillDialog
						open={importOpen}
						onOpenChange={setImportOpen}
						project={selectedProject}
					/>
				</>
			) : null}
		</div>
	);
}

function ProjectSelection({ projects, loading }: { projects: ProjectRow[]; loading: boolean }) {
	if (loading) {
		return (
			<div className={HERO_GRID_CLASS}>
				{Array.from({ length: 3 }).map((_, index) => (
					<ProjectResourceCardSkeleton key={index} />
				))}
			</div>
		);
	}
	if (projects.length === 0) {
		return (
			<EmptyState
				icon={FolderKanban}
				description="Create a Project to bundle Skills and Vault access for Agents."
				action={
					<Button render={<Link to="/projects" />}>
						<Plus />
						Create project
					</Button>
				}
			/>
		);
	}
	return (
		<section className="space-y-3">
			<h2 className="text-sm font-medium">Choose a Project</h2>
			<div className={HERO_GRID_CLASS}>
				{projects.map((project) => (
					<ProjectResourceCard
						key={project.id}
						project={project}
						footer={[
							`${project.skill_count} ${project.skill_count === 1 ? "Skill" : "Skills"}`,
							`${project.vault_count} ${project.vault_count === 1 ? "Vault" : "Vaults"}`,
						]}
						link={{ to: "/skills", search: { project: project.id } }}
					/>
				))}
			</div>
		</section>
	);
}

function CreateSkillDialog({
	open,
	onOpenChange,
	project,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	project: ProjectRow;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [instructions, setInstructions] = useState("");
	const create = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.POST("/v1/projects/{project_id}/skills", {
					params: { path: { project_id: project.id } },
					body: {
						name: name.trim(),
						description: description.trim() || null,
						instructions: instructions.trim(),
					},
				}),
			),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["skills", "project", project.id] });
			void queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects"] });
			onOpenChange(false);
			toast.success("Skill added");
		},
		onError: (error) => toast.error("Couldn't add skill", { description: errorMessage(error) }),
	});
	const reset = () => {
		setName("");
		setDescription("");
		setInstructions("");
		create.reset();
	};
	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) reset();
			}}
		>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Add skill</DialogTitle>
					<DialogDescription>
						Add instructions to {displayProjectName(project)}. Linked Agents receive the Skill
						automatically.
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (name.trim() && instructions.trim() && !create.isPending) create.mutate();
					}}
				>
					<div className="space-y-1.5">
						<Label htmlFor="skill-name">Name</Label>
						<Input
							id="skill-name"
							value={name}
							maxLength={200}
							autoFocus
							onChange={(event) => setName(event.target.value)}
							placeholder="Review pull requests"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="skill-description">
							Description <span className="text-muted-foreground">(optional)</span>
						</Label>
						<Input
							id="skill-description"
							value={description}
							maxLength={2000}
							onChange={(event) => setDescription(event.target.value)}
							placeholder="When and why an Agent should use this Skill"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="skill-instructions">Instructions</Label>
						<Textarea
							id="skill-instructions"
							value={instructions}
							maxLength={200 * 1024}
							onChange={(event) => setInstructions(event.target.value)}
							placeholder="Explain what the Agent should do, including constraints and examples."
							className="min-h-48"
						/>
					</div>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={!name.trim() || !instructions.trim() || create.isPending}
						>
							{create.isPending ? <Spinner /> : <Plus />}
							{create.isPending ? "Adding…" : "Add skill"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function ImportSkillDialog({
	open,
	onOpenChange,
	project,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	project: ProjectRow;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [source, setSource] = useState("");
	const importSkill = useMutation({
		mutationFn: async () => {
			const clean = source
				.trim()
				.replace(/^https?:\/\/github\.com\//, "")
				.replace(/\/$/, "");
			const parts = clean.split("/").filter(Boolean);
			if (parts.length < 2) throw new Error("Enter owner/repository or a GitHub Skill path");
			return unwrap(
				await api.POST("/v1/projects/{project_id}/skills/install", {
					params: { path: { project_id: project.id } },
					body: {
						repo: `${parts[0]}/${parts[1]}`,
						path: parts.length > 2 ? parts.slice(2).join("/") : undefined,
					},
				}),
			);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["skills", "project", project.id] });
			void queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects"] });
			onOpenChange(false);
			toast.success("Skill imported");
		},
		onError: (error) => toast.error("Couldn't import skill", { description: errorMessage(error) }),
	});
	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) {
					setSource("");
					importSkill.reset();
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Import from GitHub</DialogTitle>
					<DialogDescription>
						Copy a GitHub Skill into {displayProjectName(project)}. This Project owns the imported
						copy.
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (source.trim() && !importSkill.isPending) importSkill.mutate();
					}}
				>
					<div className="space-y-1.5">
						<Label htmlFor="github-skill-source">Repository or Skill path</Label>
						<Input
							id="github-skill-source"
							value={source}
							autoFocus
							onChange={(event) => setSource(event.target.value)}
							placeholder="owner/repository/path-to-skill"
							autoComplete="off"
							spellCheck={false}
						/>
					</div>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={!source.trim() || importSkill.isPending}>
							{importSkill.isPending ? <Spinner /> : <ImportIcon />}
							{importSkill.isPending ? "Importing…" : "Import skill"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
