"use client";

import { Plus } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
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
import type { components } from "@/lib/api-schemas";

type ProjectCreate = components["schemas"]["ProjectCreate"];

export function ProjectCreateDialog({
	open,
	onOpenChange,
	onCreate,
	isPending,
	formLocked = false,
	title = "New project",
	description = "Create a Project for a team, workflow, repo, or shareable resources. Add skills, vaults, and sharing settings after it is created.",
	feedback,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreate: (body: ProjectCreate) => Promise<unknown>;
	isPending: boolean;
	formLocked?: boolean;
	title?: string;
	description?: string;
	feedback?: ReactNode;
}) {
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [submissionActive, setSubmissionActive] = useState(false);
	const submissionActiveRef = useRef(false);
	const pending = isPending || submissionActive;

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && pending) return;
				onOpenChange(nextOpen);
			}}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) {
					setName("");
					setSlug("");
					setSubmissionActive(false);
					submissionActiveRef.current = false;
				}
			}}
		>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (!name.trim() || pending || formLocked || submissionActiveRef.current) return;
						const body: ProjectCreate = { name: name.trim() };
						const normalizedSlug = normalizeSlugInput(slug);
						if (normalizedSlug) body.slug = normalizedSlug;
						submissionActiveRef.current = true;
						setSubmissionActive(true);
						void Promise.resolve(onCreate(body))
							.catch(() => {
								// The mutation owner presents the user-facing error.
							})
							.finally(() => {
								submissionActiveRef.current = false;
								setSubmissionActive(false);
							});
					}}
				>
					<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
						<div className="space-y-1.5">
							<Label htmlFor="project-name">Name</Label>
							<Input
								id="project-name"
								name="project-name"
								value={name}
								maxLength={200}
								placeholder="Project name…"
								autoComplete="off"
								disabled={pending || formLocked}
								onChange={(event) => setName(event.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="project-slug">Slug</Label>
							<Input
								id="project-slug"
								name="project-slug"
								value={slug}
								maxLength={80}
								placeholder="auto-generated…"
								autoComplete="off"
								spellCheck={false}
								disabled={pending || formLocked}
								onChange={(event) => setSlug(normalizeSlugDraft(event.target.value))}
							/>
						</div>
					</div>
					{feedback}
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							variant="ghost"
							disabled={pending}
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={!name.trim() || pending || formLocked}
							variant={name.trim() && !formLocked ? "default" : "outline"}
						>
							<Plus className="size-3.5" />
							{pending ? "Creating…" : "Create project"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
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
