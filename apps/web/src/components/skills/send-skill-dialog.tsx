"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Copy } from "lucide-react";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
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
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ensureBlob, unwrap, useApi, useOpenApi, useSkillArchiveUploader } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { shouldBlockQueryError } from "@/lib/query-state";
import { skillCapabilities } from "@/lib/skill-authority";
import { errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

/* Copy or move Cloud-owned Skills between two explicit Projects from the
 * canonical Skill card. Agent Workspace projections are excluded at both the
 * source capability and destination boundary. */

export function SendSkillDialog({
	skill,
	children,
}: {
	skill: SkillSummary;
	children?: ReactElement;
}) {
	const api = useApi();
	const $api = useOpenApi();
	const uploadSkillArchive = useSkillArchiveUploader();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [target, setTarget] = useState("");
	const sendLockedRef = useRef(false);

	const projectsQuery = $api.useQuery(
		"get",
		"/v1/projects",
		{},
		{
			enabled: open,
		},
	);
	const projects = projectsQuery.data;
	const destinationLoadError = shouldBlockQueryError(projectsQuery.error, projectsQuery.data)
		? projectsQuery.error
		: null;

	// Copy/Move is always between two explicit user Projects. Agent Workspace
	// projections are excluded at both source and destination boundaries.
	const projectTargets = useMemo(
		() =>
			(projects ?? [])
				.filter((p) => p.is_owner !== false && p.id !== skill.project_id && p.kind === "workspace")
				.map((p) => ({
					value: p.id,
					label: displayProjectName(p),
					emoji: identityFor(displayProjectName(p)).emoji,
				})),
		[projects, skill.project_id],
	);
	const targetItems = useMemo(
		() =>
			projectTargets.map((target) => ({
				value: target.value,
				label: target.label,
			})),
		[projectTargets],
	);

	const send = useMutation({
		mutationFn: async (action: "copy" | "move") => {
			if (!target) throw new Error("Choose a destination first");
			if (!skill.project_id) throw new Error("Open this Skill from its Project and try again");
			const projectsById = new Map((projects ?? []).map((project) => [project.id, project]));
			if (!skillCapabilities(skill, projectsById.get(skill.project_id)).canSend) {
				throw new Error("This Skill is read-only");
			}
			const blob = ensureBlob(
				unwrap(
					await api.GET("/v1/projects/{project_id}/skills/{skill_key}/download", {
						params: {
							path: { project_id: skill.project_id, skill_key: skill.skill_key },
						},
						parseAs: "blob",
					}),
				),
			);
			await uploadSkillArchive(target, skill.skill_key, blob);
			if (action === "copy") return { sourceRemoved: null };
			try {
				unwrap(
					await api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
						params: { path: { project_id: skill.project_id, skill_key: skill.skill_key } },
					}),
				);
				return { sourceRemoved: true };
			} catch {
				return { sourceRemoved: false };
			}
		},
		onSuccess: ({ sourceRemoved }) => {
			qc.invalidateQueries({ queryKey: ["skills"] });
			const targetLabel =
				projectTargets.find((candidate) => candidate.value === target)?.label ?? "the destination";
			toast.success(
				sourceRemoved === true
					? "Skill moved"
					: sourceRemoved === false
						? "Skill copied, but not removed"
						: "Skill copied",
				{
					description:
						`${skill.name} is now available in ${targetLabel}.` +
						(sourceRemoved === false
							? " It could not be removed from the source; remove it after checking the new copy."
							: ""),
				},
			);
			setOpen(false);
		},
		onError: (e) => toast.error("Couldn't copy or move skill", { description: errorMessage(e) }),
		onSettled: () => {
			sendLockedRef.current = false;
		},
	});
	const submit = (action: "copy" | "move") => {
		if (sendLockedRef.current || send.isPending) return;
		sendLockedRef.current = true;
		send.mutate(action);
	};

	useEffect(() => {
		if (!open) return;
		setTarget("");
	}, [open]);

	const trigger = children ?? (
		<Button variant="ghost" size="icon-sm" aria-label={`Copy or move ${skill.name}`}>
			<Copy className="size-3.5" />
		</Button>
	);

	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) {
					setTarget("");
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Copy or move {skill.name}</DialogTitle>
					{/* Copy-vs-reference semantics must be explicit (Kingsley's
					    review): skills duplicate per Project, so the destination's
					    copy will NOT follow future changes to the source. */}
					<DialogDescription>
						The destination gets an independent copy — later changes to the source won&apos;t sync.
						To give people the <em className="not-italic font-medium">same</em> Skill, share the
						Project instead.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="send-skill-target">Destination</Label>
						<Select
							items={targetItems}
							value={target}
							onValueChange={(value) => {
								if (value !== null) setTarget(value);
							}}
						>
							<SelectTrigger id="send-skill-target" className="w-full">
								<SelectValue placeholder="Choose a Project…" />
							</SelectTrigger>
							<SelectContent className="max-h-80">
								{projectTargets.map((t) => (
									<SelectItem key={`p-${t.value}`} value={t.value} label={t.label}>
										<span aria-hidden className="select-none">
											{t.emoji}
										</span>
										{t.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{destinationLoadError ? (
						<ApiErrorPanel
							error={destinationLoadError}
							onRetry={() => {
								if (projectsQuery.error) void projectsQuery.refetch();
							}}
							title="Couldn't load destinations"
						/>
					) : null}
					<DialogFooter>
						<Button
							variant="outline"
							disabled={!target || send.isPending || !!destinationLoadError}
							onClick={() => submit("copy")}
						>
							{send.isPending && send.variables === "copy" ? (
								<Spinner />
							) : (
								<Copy className="size-3.5" />
							)}
							Copy skill
						</Button>
						<Button
							disabled={!target || send.isPending || !!destinationLoadError}
							onClick={() => submit("move")}
						>
							{send.isPending && send.variables === "move" ? (
								<Spinner />
							) : (
								<ArrowRight className="size-3.5" />
							)}
							Move skill
						</Button>
					</DialogFooter>
				</div>
			</DialogContent>
		</Dialog>
	);
}
