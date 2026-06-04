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

/* The #1 job of this dashboard: move a skill from one agent/project to
 * another. Pure frontend composition — download the tar from the source
 * project, upload it to the target's project. Agent targets resolve to
 * the agent's own project, so users can think "send to my MacBook agent"
 * without learning the project layer. */

export function SendSkillDialog({
	skill,
	children,
}: {
	skill: SkillSummary;
	children?: React.ReactNode;
}) {
	const api = useApi();
	const authedFetch = useAuthedFetch();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [target, setTarget] = useState("");
	const [removeFromSource, setRemoveFromSource] = useState(false);

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
	const agentTargets = useMemo(
		() =>
			(envs ?? [])
				.filter((e) => e.default_project_id && e.default_project_id !== skill.project_id)
				.map((e) => ({
					value: e.default_project_id as string,
					label: `${cleanMachineName(e.machine_name)} (${agentTypeLabel(e.agent_type)})`,
					emoji: identityFor(e.machine_name).emoji,
				})),
		[envs, skill.project_id],
	);
	const projectTargets = useMemo(
		() =>
			(projects ?? [])
				.filter(
					(p) =>
						p.is_owner !== false &&
						p.id !== skill.project_id &&
						(p.kind === "workspace" || p.kind === "personal"),
				)
				.map((p) => ({
					value: p.id,
					label: displayProjectName(p),
					emoji: identityFor(displayProjectName(p)).emoji,
				})),
		[projects, skill.project_id],
	);

	const send = useMutation({
		mutationFn: async () => {
			if (!skill.project_id) throw new Error("Source project unknown");
			if (!target) throw new Error("Choose a destination first");
			const dl = await authedFetch(
				`/api/projects/${skill.project_id}/skills/${encodeURIComponent(skill.skill_key)}/download`,
			);
			if (!dl.ok) throw new Error(`Couldn't read the skill (${dl.status})`);
			const blob = await dl.blob();
			const form = new FormData();
			form.append("skill_key", skill.skill_key);
			form.append("file", blob, `${skill.skill_key.replace(/\//g, "-")}.tar.gz`);
			const up = await authedFetch(`/api/projects/${target}/skills/upload`, {
				method: "POST",
				body: form,
			});
			if (!up.ok) throw new Error(`Couldn't install at the destination (${up.status})`);
			if (removeFromSource) {
				await api.DELETE("/api/projects/{project_id}/skills/{skill_key}", {
					params: { path: { project_id: skill.project_id, skill_key: skill.skill_key } },
				});
			}
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["skills"] });
			const targetLabel =
				[...agentTargets, ...projectTargets].find((t) => t.value === target)?.label ??
				"the destination";
			toast.success(removeFromSource ? "Skill moved" : "Skill copied", {
				description: `${skill.name} is now available in ${targetLabel}.`,
			});
			setOpen(false);
			setTarget("");
			setRemoveFromSource(false);
		},
		onError: (e) => toast.error("Couldn't send skill", { description: errorMessage(e) }),
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
					<Button variant="ghost" size="icon-sm" aria-label={`Send ${skill.name} to…`}>
						<Send className="size-3.5" />
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Send {skill.name} to…</DialogTitle>
					<DialogDescription>
						Copy this skill to another agent or Project. The destination gets its own copy.
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
						{removeFromSource ? "Move skill" : "Copy skill"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
