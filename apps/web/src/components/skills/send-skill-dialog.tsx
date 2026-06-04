"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Send } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { agentTypeLabel, cleanMachineName } from "@/components/dashboard/agent-label";
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
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi, useAuthedFetch } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

/* The #1 job of this dashboard: move skills from one agent/project to
 * another — one at a time from the card hover, or a whole batch from
 * select mode. Pure frontend composition — download each tar from its
 * source project, upload it to the target's project. Agent targets
 * resolve to the agent's own project, so users can think "send to my
 * MacBook agent" without learning the project layer. */

export function SendSkillDialog({
	skills,
	children,
	onDone,
}: {
	skills: SkillSummary[];
	children?: React.ReactNode;
	/** Called after a successful send (bulk mode clears its selection). */
	onDone?: () => void;
}) {
	const api = useApi();
	const authedFetch = useAuthedFetch();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [target, setTarget] = useState("");
	const [removeFromSource, setRemoveFromSource] = useState(false);

	const single = skills.length === 1 ? skills[0] : null;
	const batchLabel = single ? single.name : `${skills.length} skills`;

	const { data: projects } = useQuery({
		queryKey: ["projects"],
		queryFn: async () => unwrap(await api.GET("/api/projects")),
		enabled: open,
	});
	const { data: envs } = useQuery({
		queryKey: ["environments"],
		queryFn: async () => unwrap(await api.GET("/api/environments")),
		enabled: open,
	});

	// Target value encodes the destination project id. Agents are listed
	// first (that's how users think) and resolve to their own project.
	// A destination only disappears when EVERY selected skill already
	// lives there — mixed-source batches keep it (already-there copies
	// are skipped at send time).
	const agentTargets = useMemo(
		() =>
			(envs ?? [])
				.filter(
					(e) =>
						e.default_project_id && !skills.every((s) => s.project_id === e.default_project_id),
				)
				.map((e) => ({
					value: e.default_project_id as string,
					label: `${cleanMachineName(e.machine_name)} (${agentTypeLabel(e.agent_type)})`,
					emoji: identityFor(e.machine_name).emoji,
				})),
		[envs, skills],
	);
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

	const send = useMutation({
		mutationFn: async () => {
			if (!target) throw new Error("Choose a destination first");
			// Per-skill try/catch: in a batch, one unreadable skill must
			// not abort the rest — report partial success instead.
			let sent = 0;
			const failed: string[] = [];
			for (const skill of skills) {
				if (!skill.project_id || skill.project_id === target) continue;
				try {
					const dl = await authedFetch(
						`/api/projects/${skill.project_id}/skills/${encodeURIComponent(skill.skill_key)}/download`,
					);
					const blob = await dl.blob();
					const form = new FormData();
					form.append("skill_key", skill.skill_key);
					form.append("file", blob, `${skill.skill_key.replace(/\//g, "-")}.tar.gz`);
					await authedFetch(`/api/projects/${target}/skills/upload`, {
						method: "POST",
						body: form,
					});
					if (removeFromSource) {
						await api.DELETE("/api/projects/{project_id}/skills/{skill_key}", {
							params: { path: { project_id: skill.project_id, skill_key: skill.skill_key } },
						});
					}
					sent += 1;
				} catch {
					failed.push(skill.name || skill.skill_key);
				}
			}
			if (sent === 0) {
				throw new Error(
					failed.length > 0
						? `Couldn't read ${failed.join(", ")} from the source`
						: "Everything selected is already in that destination",
				);
			}
			return { sent, failed };
		},
		onSuccess: ({ sent, failed }) => {
			qc.invalidateQueries({ queryKey: ["skills"] });
			const targetLabel =
				[...agentTargets, ...projectTargets].find((t) => t.value === target)?.label ??
				"the destination";
			const what = sent === 1 && single ? single.name : `${sent} skills`;
			toast.success(
				removeFromSource
					? `${sent === 1 ? "Skill" : "Skills"} moved`
					: `${sent === 1 ? "Skill" : "Skills"} copied`,
				{
					description:
						`${what} now available in ${targetLabel}.` +
						(failed.length > 0 ? ` Skipped (couldn't read): ${failed.join(", ")}.` : ""),
				},
			);
			setOpen(false);
			setTarget("");
			setRemoveFromSource(false);
			onDone?.();
		},
		onError: (e) => toast.error("Couldn't send skills", { description: errorMessage(e) }),
	});

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setTarget("");
					setRemoveFromSource(false);
				}
			}}
		>
			<DialogTrigger asChild>
				{children ?? (
					<Button variant="ghost" size="icon-sm" aria-label={`Send ${batchLabel} to…`}>
						<Send className="size-3.5" />
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Send {batchLabel} to…</DialogTitle>
					<DialogDescription>
						Copy {single ? "this skill" : "these skills"} to another agent or Project. The
						destination gets its own {single ? "copy" : "copies"}.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="send-skill-target">Destination</Label>
						<Select value={target} onValueChange={setTarget}>
							<SelectTrigger id="send-skill-target" className="w-full">
								<SelectValue placeholder="Choose an agent or Project…" />
							</SelectTrigger>
							<SelectContent className="max-h-80">
								{agentTargets.length > 0 ? (
									<SelectGroup>
										<SelectLabel>Agents</SelectLabel>
										{agentTargets.map((t) => (
											<SelectItem key={`a-${t.value}`} value={t.value}>
												<span aria-hidden className="select-none">
													{t.emoji}
												</span>
												{t.label}
											</SelectItem>
										))}
									</SelectGroup>
								) : null}
								{projectTargets.length > 0 ? (
									<SelectGroup>
										<SelectLabel>Projects</SelectLabel>
										{projectTargets.map((t) => (
											<SelectItem key={`p-${t.value}`} value={t.value}>
												<span aria-hidden className="select-none">
													{t.emoji}
												</span>
												{t.label}
											</SelectItem>
										))}
									</SelectGroup>
								) : null}
							</SelectContent>
						</Select>
					</div>
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
						disabled={!target || send.isPending}
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
