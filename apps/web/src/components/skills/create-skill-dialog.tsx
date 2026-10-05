"use client";

import { buildSkillCreateRequest } from "@clawdi/shared/api";
import { createSkillDialogClasses } from "@clawdi/shared/ui";
import { skillFormCopy as copy, createSkillDescription } from "@clawdi/shared/view";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type ReactElement, useRef, useState } from "react";
import { toast } from "sonner";
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
					body: buildSkillCreateRequest({ name, description, instructions }),
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
			<DialogContent className={createSkillDialogClasses.dialog}>
				<DialogHeader>
					<DialogTitle>{copy.title}</DialogTitle>
					<DialogDescription>{createSkillDescription(project)}</DialogDescription>
				</DialogHeader>
				<form
					className={createSkillDialogClasses.form}
					onSubmit={(event) => {
						event.preventDefault();
						if (!name || !description.trim() || !instructions.trim() || submitLockedRef.current)
							return;
						submitLockedRef.current = true;
						create.mutate();
					}}
				>
					<div className={createSkillDialogClasses.field}>
						<Label htmlFor="skill-name">{copy.name}</Label>
						<Input
							id="skill-name"
							value={name}
							maxLength={64}
							required
							pattern="[a-z0-9]+(-[a-z0-9]+)*"
							aria-describedby="skill-name-help"
							autoFocus
							onChange={(event) => setName(event.target.value)}
							placeholder={copy.namePlaceholder}
						/>
						<p id="skill-name-help" className={createSkillDialogClasses.help}>
							{copy.nameHelp}
						</p>
					</div>
					<div className={createSkillDialogClasses.field}>
						<Label htmlFor="skill-description">{copy.description}</Label>
						<Input
							id="skill-description"
							value={description}
							maxLength={1024}
							required
							onChange={(event) => setDescription(event.target.value)}
							placeholder={copy.descriptionPlaceholder}
						/>
					</div>
					<div className={createSkillDialogClasses.field}>
						<Label htmlFor="skill-instructions">{copy.instructions}</Label>
						<Textarea
							id="skill-instructions"
							value={instructions}
							maxLength={200 * 1024}
							onChange={(event) => setInstructions(event.target.value)}
							placeholder={copy.instructionsPlaceholder}
							className={createSkillDialogClasses.textarea}
						/>
					</div>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={!name || !description.trim() || !instructions.trim() || create.isPending}
						>
							{create.isPending ? <Spinner /> : <Plus />}
							{create.isPending ? copy.adding : copy.title}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
