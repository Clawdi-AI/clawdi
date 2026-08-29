"use client";

import { useMutation } from "@tanstack/react-query";
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

type ProjectCreate = components["schemas"]["ProjectCreate"];
type Project = components["schemas"]["ProjectResponse"];

export function CreateProjectDialog({
	agentId,
	children,
	onCreated,
}: {
	agentId?: string;
	children: ReactElement;
	onCreated: (project: Project) => void | Promise<void>;
}) {
	const api = useApi();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const submitLockedRef = useRef(false);

	const createProject = useMutation({
		mutationFn: async (body: ProjectCreate) =>
			agentId
				? unwrap(
						await api.POST("/v1/projects/for-agent/{agent_id}", {
							params: { path: { agent_id: agentId } },
							body,
						}),
					)
				: unwrap(await api.POST("/v1/projects", { body })),
		onSuccess: async (project) => {
			setOpen(false);
			await onCreated(project);
		},
		onError: (error) =>
			toast.error("Couldn't create project", { description: normalizeApiError(error) }),
		onSettled: () => {
			submitLockedRef.current = false;
		},
	});

	const submit = () => {
		const trimmedName = name.trim();
		if (!trimmedName || submitLockedRef.current) return;
		submitLockedRef.current = true;
		createProject.mutate({
			name: trimmedName,
			description: description.trim() || null,
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) {
					setName("");
					setDescription("");
				}
			}}
		>
			<DialogTrigger render={children} />
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Create project</DialogTitle>
					<DialogDescription>
						{agentId
							? "Create a shareable bundle and link it to this Agent immediately."
							: "Create a shareable bundle for Skills and attached Vault access."}
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<div className="space-y-1.5">
						<Label htmlFor="create-project-name">Name</Label>
						<Input
							id="create-project-name"
							name="create-project-name"
							value={name}
							maxLength={200}
							autoComplete="off"
							placeholder="Project name…"
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="create-project-description">Description</Label>
						<Textarea
							id="create-project-description"
							name="create-project-description"
							value={description}
							maxLength={2000}
							placeholder="What should Agents use this Project for?"
							autoComplete="off"
							onChange={(event) => setDescription(event.target.value)}
							className="min-h-24"
						/>
					</div>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={!name.trim() || createProject.isPending}>
							{createProject.isPending ? <Spinner className="size-3.5" /> : <Plus />}
							Create project
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
