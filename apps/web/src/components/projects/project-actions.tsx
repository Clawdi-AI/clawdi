"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Share2, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { displayProjectName } from "@/components/projects/project-metadata";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { unwrap, useApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";

type Project = components["schemas"]["ProjectResponse"];

export function ProjectActions({
	project,
	onChanged,
	onArchived,
}: {
	project: Project;
	onChanged?: () => void | Promise<void>;
	onArchived?: () => void | Promise<void>;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [editOpen, setEditOpen] = useState(false);
	const [name, setName] = useState(project.name);
	const [description, setDescription] = useState(project.description ?? "");
	const editLockedRef = useRef(false);

	const refresh = async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects"] }),
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects/{project_id}"] }),
		]);
		await onChanged?.();
	};
	const update = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.PATCH("/v1/projects/{project_id}", {
					params: { path: { project_id: project.id } },
					body: {
						name: name.trim(),
						description: description.trim() || null,
					},
				}),
			),
		onSuccess: async () => {
			setEditOpen(false);
			await refresh();
			toast.success("Project updated");
		},
		onError: (error) =>
			toast.error("Couldn't update project", { description: normalizeApiError(error) }),
		onSettled: () => {
			editLockedRef.current = false;
		},
	});
	const archive = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.DELETE("/v1/projects/{project_id}", {
					params: { path: { project_id: project.id } },
				}),
			),
		onSuccess: async () => {
			await refresh();
			toast.success("Project archived");
			await onArchived?.();
		},
		onError: (error) =>
			toast.error("Couldn't archive project", { description: normalizeApiError(error) }),
	});
	const projectName = displayProjectName(project);

	return (
		<>
			<Dialog
				open={editOpen}
				onOpenChange={(nextOpen) => {
					if (nextOpen) {
						setName(project.name);
						setDescription(project.description ?? "");
					}
					setEditOpen(nextOpen);
				}}
				onOpenChangeComplete={(nextOpen) => {
					if (!nextOpen) {
						setName(project.name);
						setDescription(project.description ?? "");
					}
				}}
			>
				<DialogTrigger
					render={
						<Button variant="ghost" size="icon-sm" aria-label={`Edit ${projectName}`}>
							<Pencil className="size-3.5" />
						</Button>
					}
				/>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Edit project</DialogTitle>
						<DialogDescription>
							Update its name and description without leaving this page.
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (!name.trim() || editLockedRef.current) return;
							editLockedRef.current = true;
							update.mutate();
						}}
					>
						<div className="space-y-1.5">
							<Label htmlFor={`project-name-${project.id}`}>Name</Label>
							<Input
								id={`project-name-${project.id}`}
								value={name}
								maxLength={200}
								onChange={(event) => setName(event.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={`project-description-${project.id}`}>Description</Label>
							<Textarea
								id={`project-description-${project.id}`}
								value={description}
								maxLength={2000}
								onChange={(event) => setDescription(event.target.value)}
								className="min-h-24"
							/>
						</div>
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!name.trim() || update.isPending}>
								{update.isPending ? <Spinner className="size-3.5" /> : <Pencil />}
								Save changes
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<ShareProjectDialog
				projectId={project.id}
				projectName={projectName}
				projectKind={project.kind}
			>
				<Button variant="ghost" size="icon-sm" aria-label={`Share ${projectName}`}>
					<Share2 className="size-3.5" />
				</Button>
			</ShareProjectDialog>

			<ConfirmAction
				title={`Archive ${projectName}?`}
				description={
					<p>
						Agents will stop using this Project's Skills and Vaults. The Project will disappear from
						your library.
					</p>
				}
				confirmLabel="Archive project"
				destructive
				onConfirm={() => archive.mutateAsync()}
			>
				<Button
					variant="ghost"
					size="icon-sm"
					disabled={archive.isPending}
					className="text-muted-foreground hover:text-destructive"
					aria-label={`Archive ${projectName}`}
				>
					{archive.isPending ? <Spinner className="size-3.5" /> : <Trash2 className="size-3.5" />}
				</Button>
			</ConfirmAction>
		</>
	);
}
