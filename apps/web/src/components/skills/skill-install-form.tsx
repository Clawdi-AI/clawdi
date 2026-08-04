"use client";

import { useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { parseSkillRepository } from "@/components/skills/skill-install-repository";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { errorMessage } from "@/lib/utils";

type SkillInstallResponse = components["schemas"]["SkillInstallResponse"];

export function SkillInstallForm({
	projectId,
	onInstalled,
	onPendingChange,
	disabled = false,
	description = "Paste a GitHub skill path to install a Project copy.",
}: {
	projectId: string;
	onInstalled: (skill: SkillInstallResponse, projectId: string) => void;
	onPendingChange?: (isPending: boolean) => void;
	disabled?: boolean;
	description?: string;
}) {
	const api = useApi();
	const [repoInput, setRepoInput] = useState("");
	const [validationError, setValidationError] = useState<string | null>(null);
	const installInFlightRef = useRef(false);

	const install = useMutation({
		mutationFn: async ({
			repo,
			path,
			targetProjectId,
		}: {
			repo: string;
			path?: string;
			targetProjectId: string;
		}) =>
			unwrap(
				await api.POST("/v1/projects/{project_id}/skills/install", {
					params: { path: { project_id: targetProjectId } },
					body: { repo, path },
				}),
			),
		onSuccess: (skill, variables) => {
			setRepoInput("");
			setValidationError(null);
			onInstalled(skill, variables.targetProjectId);
		},
		onSettled: () => {
			installInFlightRef.current = false;
		},
	});

	useEffect(() => {
		onPendingChange?.(install.isPending);
		return () => onPendingChange?.(false);
	}, [install.isPending, onPendingChange]);

	const submit = () => {
		if (disabled || install.isPending || installInFlightRef.current) return;
		setValidationError(null);
		if (!projectId) {
			setValidationError("Choose a writable Project first.");
			return;
		}
		const parsed = parseSkillRepository(repoInput);
		if (!parsed) {
			setValidationError("Enter as `owner/repo` or `owner/repo/path-to-skill`.");
			return;
		}
		installInFlightRef.current = true;
		install.mutate({ ...parsed, targetProjectId: projectId });
	};

	return (
		<div className="grid gap-2">
			<Label htmlFor={`skill-repo-${projectId}`} className="text-xs font-medium">
				GitHub skill repository
			</Label>
			<div className="flex flex-col gap-2 sm:flex-row">
				<Input
					id={`skill-repo-${projectId}`}
					name="skill-repo"
					value={repoInput}
					onChange={(event) => {
						setRepoInput(event.target.value);
						setValidationError(null);
						install.reset();
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							submit();
						}
					}}
					placeholder="owner/repo or owner/repo/path…"
					autoComplete="off"
					spellCheck={false}
					aria-invalid={Boolean(validationError || install.error) || undefined}
					disabled={disabled || install.isPending}
					className="min-w-0 flex-1"
				/>
				<Button
					type="button"
					size="sm"
					disabled={disabled || !projectId || !repoInput.trim() || install.isPending}
					onClick={submit}
					variant={repoInput.trim() ? "default" : "outline"}
					className="w-full sm:w-auto"
				>
					{install.isPending ? <Spinner /> : <Plus className="size-3.5" />}
					{install.isPending ? "Installing…" : "Install skill"}
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">{description}</p>
			{validationError ? <p className="text-xs text-destructive">{validationError}</p> : null}
			{install.error ? (
				<p className="text-xs text-destructive">{errorMessage(install.error)}</p>
			) : null}
		</div>
	);
}
