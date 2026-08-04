"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Send } from "lucide-react";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { displayProjectName } from "@/components/projects/project-metadata";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
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

/* Move Cloud-owned Skills between Cloud-owned Projects, one at a time from
 * the card hover or as a batch from select mode. Agent Projects are filesystem
 * projections and are excluded at both the source capability and destination
 * boundary. */

export function SendSkillDialog({
	skills,
	children,
	onDone,
}: {
	skills: SkillSummary[];
	children?: ReactElement;
	/** Called after a successful send (bulk mode clears its selection). */
	onDone?: () => void;
}) {
	const api = useApi();
	const $api = useOpenApi();
	const uploadSkillArchive = useSkillArchiveUploader();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [target, setTarget] = useState("");
	const [removeFromSource, setRemoveFromSource] = useState(false);

	const single = skills.length === 1 ? skills[0] : null;
	const batchLabel = single ? single.name : `${skills.length} skills`;

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

	// Target value encodes a Cloud-owned destination Project id. Environment
	// Projects are filesystem projections and are deliberately excluded.
	// A destination only disappears when EVERY selected skill already
	// lives there — mixed-source batches keep it (already-there copies
	// are skipped at send time).
	const projectTargets = useMemo(
		() =>
			(projects ?? [])
				.filter(
					(p) =>
						p.is_owner !== false &&
						!skills.every((s) => s.project_id === p.id) &&
						(p.kind === "workspace" || p.kind === "personal"),
				)
				.map((p) => ({
					value: p.id,
					label: displayProjectName(p),
					emoji: identityFor(displayProjectName(p)).emoji,
				})),
		[projects, skills],
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
		mutationFn: async () => {
			if (!target) throw new Error("Choose a destination first");
			const projectsById = new Map((projects ?? []).map((project) => [project.id, project]));
			if (
				skills.some(
					(skill) =>
						!skillCapabilities(
							skill,
							skill.project_id ? projectsById.get(skill.project_id) : undefined,
						).canSend,
				)
			) {
				throw new Error("Agent-synced and Workspace Skills cannot be sent from Cloud");
			}
			// Per-skill try/catch: in a batch, one unreadable skill must
			// not abort the rest — report partial success instead.
			let copied = 0;
			const failed: string[] = [];
			const sourceRemoveFailed: string[] = [];
			for (const skill of skills) {
				if (!skill.project_id || skill.project_id === target) continue;
				const label = skill.name || skill.skill_key;
				try {
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
					copied += 1;
					if (removeFromSource) {
						try {
							unwrap(
								await api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
									params: { path: { project_id: skill.project_id, skill_key: skill.skill_key } },
								}),
							);
						} catch {
							sourceRemoveFailed.push(label);
						}
					}
				} catch {
					failed.push(label);
				}
			}
			if (copied === 0) {
				throw new Error(
					failed.length > 0
						? `Couldn't send ${failed.join(", ")}`
						: "Everything selected is already in that destination",
				);
			}
			return { copied, failed, sourceRemoveFailed };
		},
		onSuccess: ({ copied, failed, sourceRemoveFailed }) => {
			qc.invalidateQueries({ queryKey: ["skills"] });
			const targetLabel =
				projectTargets.find((candidate) => candidate.value === target)?.label ?? "the destination";
			const what = copied === 1 ? (single?.name ?? "1 skill") : `${copied} skills`;
			const sourceCleanupFailed = sourceRemoveFailed.length > 0;
			toast.success(
				removeFromSource && !sourceCleanupFailed
					? `${copied === 1 ? "Skill" : "Skills"} moved`
					: `${copied === 1 ? "Skill" : "Skills"} copied`,
				{
					description:
						`${what} now available in ${targetLabel}.` +
						(sourceCleanupFailed ? ` Source not removed: ${sourceRemoveFailed.join(", ")}.` : "") +
						(failed.length > 0 ? ` Failed: ${failed.join(", ")}.` : ""),
				},
			);
			setOpen(false);
			onDone?.();
		},
		onError: (e) => toast.error("Couldn't send skills", { description: errorMessage(e) }),
	});

	useEffect(() => {
		if (!open) return;
		setTarget("");
		setRemoveFromSource(false);
	}, [open]);

	const trigger = children ?? (
		<Button variant="ghost" size="icon-sm" aria-label={`Send ${batchLabel} to…`}>
			<Send className="size-3.5" />
		</Button>
	);

	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) {
					setTarget("");
					setRemoveFromSource(false);
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Send {batchLabel} to…</DialogTitle>
					{/* Copy-vs-reference semantics must be explicit (Kingsley's
					    review): skills duplicate per Project, so the destination's
					    copy will NOT follow future changes to the source. */}
					<DialogDescription>
						The destination gets {single ? "an independent copy" : "independent copies"} — later
						changes to the source won&apos;t sync. To give people the{" "}
						<em className="not-italic font-medium">same</em> {single ? "skill" : "skills"}, share
						the Project instead.
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
					<div className="flex items-center gap-2">
						<Checkbox
							id="send-skill-move"
							checked={removeFromSource}
							onCheckedChange={(v) => setRemoveFromSource(v === true)}
						/>
						<Label htmlFor="send-skill-move" className="text-sm font-normal">
							Remove from the source after copying (move)
						</Label>
					</div>
					<Button
						className="w-full"
						disabled={!target || send.isPending || !!destinationLoadError}
						onClick={() => send.mutate()}
					>
						{send.isPending ? <Spinner /> : <ArrowRight className="size-3.5" />}
						{removeFromSource ? `Move ${batchLabel}` : `Copy ${batchLabel}`}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
