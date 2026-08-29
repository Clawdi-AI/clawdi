"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type ReactElement, useRef, useState } from "react";
import { toast } from "sonner";
import { displayProjectName } from "@/components/projects/project-metadata";
import { Button } from "@/components/ui/button";
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

export function CreateSkillDialog({
	project,
	open,
	onOpenChange,
	onCreated,
	children,
}: {
	project: Project;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	onCreated?: () => void | Promise<void>;
	children?: ReactElement;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [internalOpen, setInternalOpen] = useState(false);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [instructions, setInstructions] = useState("");
	const submitLockedRef = useRef(false);
	const dialogOpen = open ?? internalOpen;
	const setDialogOpen = (nextOpen: boolean) => {
		setInternalOpen(nextOpen);
		onOpenChange?.(nextOpen);
	};

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
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["skills", "project", project.id] }),
				queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects"] }),
			]);
			setDialogOpen(false);
			await onCreated?.();
			toast.success("Skill added");
		},
		onError: (error) =>
			toast.error("Couldn't add skill", { description: normalizeApiError(error) }),
		onSettled: () => {
			submitLockedRef.current = false;
		},
	});

	const reset = () => {
		setName("");
		setDescription("");
		setInstructions("");
		create.reset();
	};

	return (
		<Dialog
			open={dialogOpen}
			onOpenChange={setDialogOpen}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) reset();
			}}
		>
			{children ? <DialogTrigger render={children} /> : null}
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
						if (!name.trim() || !instructions.trim() || submitLockedRef.current) return;
						submitLockedRef.current = true;
						create.mutate();
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
						<Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
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
