"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { PackageOpen, Plus, Upload } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ProjectCompactPicker } from "@/components/projects/project-metadata";
import { SkillInstallForm } from "@/components/skills/skill-install-form";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AgentRouteQuery } from "@/lib/agent-routes";
import { agentSkillDetailLink } from "@/lib/agent-routes";
import { useSkillArchiveUploader } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { errorMessage } from "@/lib/utils";

type ProjectRow = components["schemas"]["ProjectResponse"];
type SkillInstallResponse = components["schemas"]["SkillInstallResponse"];
type SkillUploadResponse = components["schemas"]["SkillUploadResponse"];

export function AgentSkillAddDialog({
	agentId,
	projects,
	defaultProjectId,
	routeSearch,
	trigger,
}: {
	agentId: string;
	projects: ProjectRow[];
	defaultProjectId: string;
	routeSearch: AgentRouteQuery;
	trigger?: ReactElement;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const uploadSkillArchive = useSkillArchiveUploader();
	const [open, setOpen] = useState(false);
	const [projectId, setProjectId] = useState(defaultProjectId);
	const [skillKey, setSkillKey] = useState("");
	const [archive, setArchive] = useState<File | null>(null);
	const [installPending, setInstallPending] = useState(false);
	const uploadInFlightRef = useRef(false);
	const fixedProject = projects.length === 1 ? projects[0] : null;

	useEffect(() => {
		if (!open) return;
		setProjectId(
			projects.some((project) => project.id === defaultProjectId)
				? defaultProjectId
				: (projects[0]?.id ?? ""),
		);
	}, [defaultProjectId, open, projects]);

	const finish = (skill: SkillInstallResponse | SkillUploadResponse, targetProjectId: string) => {
		void queryClient.invalidateQueries({ queryKey: ["skills"] });
		setOpen(false);
		toast.success("Skill added to Project", {
			description: "This Project copy is now available to every Agent using the selected Project.",
		});
		void router.navigate(
			agentSkillDetailLink(agentId, skill.skill_key, targetProjectId, routeSearch),
		);
	};

	const upload = useMutation({
		mutationFn: async () => {
			const selectedProject = projects.find((project) => project.id === projectId);
			if (!selectedProject) throw new Error("Choose an available writable Project");
			const normalizedKey = skillKey.trim();
			if (!normalizedKey) throw new Error("Enter the Skill key stored in the archive");
			if (!archive) throw new Error("Choose a .tar.gz Skill archive");
			return {
				skill: await uploadSkillArchive(selectedProject.id, normalizedKey, archive),
				projectId: selectedProject.id,
			};
		},
		onSuccess: ({ skill, projectId: uploadedProjectId }) => finish(skill, uploadedProjectId),
		onError: (error) => toast.error("Couldn't upload Skill", { description: errorMessage(error) }),
		onSettled: () => {
			uploadInFlightRef.current = false;
		},
	});

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!upload.isPending && !installPending) setOpen(nextOpen);
			}}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) {
					setSkillKey("");
					setArchive(null);
					setInstallPending(false);
					uploadInFlightRef.current = false;
					upload.reset();
				}
			}}
		>
			<DialogTrigger
				render={
					trigger ?? (
						<Button size="sm">
							<Plus className="size-3.5" />
							Add Skill
						</Button>
					)
				}
			/>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						{fixedProject ? `Add Skill to ${fixedProject.name}` : "Add Skill for this Agent"}
					</DialogTitle>
					<DialogDescription>
						Creates a Project copy. Every Agent using {fixedProject ? "this" : "that"} Project
						receives the same copy.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					{fixedProject ? null : (
						<div className="space-y-1.5">
							<Label>Target Project</Label>
							<ProjectCompactPicker
								projects={projects}
								value={projectId}
								onValueChange={setProjectId}
								ariaLabel="Writable Agent Project for the Skill"
								disabled={upload.isPending || installPending}
							/>
							<p className="text-xs text-muted-foreground">
								Only effective, owner-writable Projects are available here.
							</p>
						</div>
					)}
					<Tabs defaultValue="install">
						<TabsList className="w-full">
							<TabsTrigger value="install" className="flex-1">
								<PackageOpen className="size-3.5" />
								Install from GitHub
							</TabsTrigger>
							<TabsTrigger value="upload" className="flex-1">
								<Upload className="size-3.5" />
								Upload archive
							</TabsTrigger>
						</TabsList>
						<TabsContent value="install" className="pt-4">
							<SkillInstallForm
								projectId={projectId}
								onInstalled={finish}
								onPendingChange={setInstallPending}
								disabled={upload.isPending}
								description="Install a supported Skill from GitHub into this Project."
							/>
						</TabsContent>
						<TabsContent value="upload" className="space-y-3 pt-4">
							<div className="space-y-1.5">
								<Label htmlFor="agent-skill-key">Skill key</Label>
								<Input
									id="agent-skill-key"
									value={skillKey}
									onChange={(event) => setSkillKey(event.target.value)}
									placeholder="owner/skill-name"
									autoComplete="off"
									spellCheck={false}
									disabled={upload.isPending || installPending}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="agent-skill-archive">Skill archive</Label>
								<Input
									id="agent-skill-archive"
									type="file"
									accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
									onChange={(event) => setArchive(event.target.files?.[0] ?? null)}
									disabled={upload.isPending || installPending}
								/>
							</div>
							{upload.error ? (
								<p className="text-xs text-destructive">{errorMessage(upload.error)}</p>
							) : null}
							<div className="flex justify-end">
								<Button
									type="button"
									disabled={
										!projectId || !skillKey.trim() || !archive || upload.isPending || installPending
									}
									onClick={() => {
										if (uploadInFlightRef.current) return;
										uploadInFlightRef.current = true;
										upload.mutate();
									}}
								>
									{upload.isPending ? <Spinner /> : <Upload className="size-3.5" />}
									{upload.isPending ? "Uploading…" : "Upload Skill"}
								</Button>
							</div>
						</TabsContent>
					</Tabs>
				</div>
			</DialogContent>
		</Dialog>
	);
}
