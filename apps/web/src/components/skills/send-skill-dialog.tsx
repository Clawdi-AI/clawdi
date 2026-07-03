"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Send } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	AgentLabel,
	AgentSourceBadgeForEnvironment,
	agentTextLabel,
	compareAgentEnvironments,
} from "@/components/dashboard/agent-label";
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
import { agentOwnershipKindFromId, useAgentOwnership } from "@/lib/agent-ownership";
import { ensureBlob, unwrap, useApi, useSkillArchiveUploader } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type Environment = components["schemas"]["AgentResponse"];

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
	const uploadSkillArchive = useSkillArchiveUploader();
	const qc = useQueryClient();
	const ownership = useAgentOwnership();
	const [open, setOpen] = useState(false);
	const [target, setTarget] = useState("");
	const [removeFromSource, setRemoveFromSource] = useState(false);

	const single = skills.length === 1 ? skills[0] : null;
	const batchLabel = single ? single.name : `${skills.length} skills`;

	const { data: projects } = useQuery({
		queryKey: ["projects"],
		queryFn: async () => unwrap(await api.GET("/v1/projects")),
		enabled: open,
	});
	const { data: envs } = useQuery({
		queryKey: ["agents"],
		queryFn: async () => unwrap(await api.GET("/v1/agents")),
		enabled: open,
	});

	// Target value encodes the destination project id. Agents are listed
	// first (that's how users think) and resolve to their own project.
	// A destination only disappears when EVERY selected skill already
	// lives there — mixed-source batches keep it (already-there copies
	// are skipped at send time).
	const agentTargets = useMemo(
		() =>
			[...(envs ?? [])]
				.sort(compareAgentEnvironments)
				.filter(
					(e) =>
						e.default_project_id && !skills.every((s) => s.project_id === e.default_project_id),
				)
				.map((e) => ({
					value: e.default_project_id as string,
					label: agentTextLabel(e, {
						ownershipKind: agentOwnershipKindFromId(e.id, ownership),
					}),
					env: e,
				})),
		[envs, ownership, skills],
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
				[...agentTargets, ...projectTargets].find((t) => t.value === target)?.label ??
				"the destination";
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
						<Select value={target} onValueChange={setTarget}>
							<SelectTrigger id="send-skill-target" className="w-full">
								<SelectValue placeholder="Choose an agent or Project…" />
							</SelectTrigger>
							<SelectContent className="max-h-80">
								{agentTargets.length > 0 ? (
									<SelectGroup>
										<SelectLabel>Agents</SelectLabel>
										{agentTargets.map((t) => (
											<SelectItem key={`a-${t.value}`} value={t.value} textValue={t.label}>
												<AgentTargetOption env={t.env} />
											</SelectItem>
										))}
									</SelectGroup>
								) : null}
								{projectTargets.length > 0 ? (
									<SelectGroup>
										<SelectLabel>Projects</SelectLabel>
										{projectTargets.map((t) => (
											<SelectItem key={`p-${t.value}`} value={t.value} textValue={t.label}>
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

function AgentTargetOption({ env }: { env: Environment }) {
	const ownership = useAgentOwnership();
	const ownershipKind = agentOwnershipKindFromId(env.id, ownership);
	return (
		<AgentLabel
			machineName={env.machine_name}
			displayName={env.display_name}
			defaultName={env.default_name}
			type={env.agent_type}
			avatarUrl={env.avatar_url}
			size="sm"
			titleAdornment={
				<AgentSourceBadgeForEnvironment env={env} ownershipKind={ownershipKind} compact />
			}
		/>
	);
}
