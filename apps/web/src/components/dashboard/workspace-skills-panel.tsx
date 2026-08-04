"use client";

import { Check, Copy, Plus, TerminalSquare, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	workspaceSkillInstallCommand,
	workspaceSkillRemoveCommand,
} from "@/components/dashboard/workspace-skills.logic";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { SkillCard } from "@/components/skills/skill-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import type { AgentRouteQuery } from "@/lib/agent-routes";
import { agentSkillDetailLink } from "@/lib/agent-routes";
import type { components } from "@/lib/api-schemas";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

export function ConnectedWorkspaceSkillsPanel({
	agentId,
	projectId,
	routeSearch,
	agentType,
	projections,
	isLoading,
	projectionError,
	onRetryProjections,
}: {
	agentId: string;
	projectId: string;
	routeSearch?: AgentRouteQuery;
	agentType: string;
	projections: SkillSummary[];
	isLoading: boolean;
	projectionError?: unknown;
	onRetryProjections?: () => void;
}) {
	const [installOpen, setInstallOpen] = useState(false);
	const [repo, setRepo] = useState("");

	return (
		<div className="space-y-4">
			<Alert>
				<AlertTitle>Agent filesystem is the install authority</AlertTitle>
				<AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
					<span>
						This browser cannot write the connected Agent's local files. Run the CLI command on the
						Agent machine; synced Cloud cards below remain read-only projections.
					</span>
					<Button
						size="sm"
						className="w-full shrink-0 sm:w-auto"
						onClick={() => setInstallOpen(true)}
					>
						<Plus className="size-3.5" />
						Install skill
					</Button>
				</AlertDescription>
			</Alert>

			{projectionError ? (
				<ApiErrorPanel
					error={projectionError}
					onRetry={onRetryProjections}
					title="Cloud Skill projections unavailable"
				/>
			) : isLoading ? (
				<div className={HERO_GRID_CLASS}>
					{Array.from({ length: 3 }).map((_, index) => (
						<Skeleton key={index} className="h-28 w-full rounded-xl" />
					))}
				</div>
			) : projections.length === 0 ? (
				<EmptyState
					variant="inset"
					icon={TerminalSquare}
					description="No Agent-synced Skill projections yet. Install with the CLI, then sync the Agent."
				/>
			) : (
				<div className={HERO_GRID_CLASS}>
					{projections.map((skill) => (
						<SkillCard
							key={skill.id}
							skill={skill}
							cloudSkill={skill}
							readOnly
							readOnlyLabel="Agent projection · Read-only"
							actions={<ConnectedSkillRemoveAction skill={skill} agentType={agentType} />}
							skillLink={(cloudSkill) =>
								agentSkillDetailLink(agentId, cloudSkill.skill_key, projectId, routeSearch)
							}
						/>
					))}
				</div>
			)}

			<Dialog
				open={installOpen}
				onOpenChange={setInstallOpen}
				onOpenChangeComplete={(open) => {
					if (!open) setRepo("");
				}}
			>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>Install skill</DialogTitle>
						<DialogDescription>
							Enter a GitHub Skill path, then run the generated command on the connected Agent
							machine.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-3">
						<div className="space-y-1.5">
							<Label htmlFor="workspace-skill-repo">GitHub Skill repository</Label>
							<Input
								id="workspace-skill-repo"
								value={repo}
								autoComplete="off"
								spellCheck={false}
								placeholder="owner/repo or owner/repo/path-to-skill…"
								onChange={(event) => setRepo(event.target.value)}
							/>
						</div>
						{repo.trim() ? (
							<CliCommand command={workspaceSkillInstallCommand(repo, agentType)} />
						) : null}
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setInstallOpen(false)}>
							Done
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function ConnectedSkillRemoveAction({
	skill,
	agentType,
}: {
	skill: SkillSummary;
	agentType: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				className="text-muted-foreground hover:text-destructive"
				onClick={() => setOpen(true)}
			>
				<Trash2 className="size-3.5" />
				Uninstall skill
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>Uninstall skill</DialogTitle>
						<DialogDescription>
							Run this command on the connected Agent machine. The Cloud projection is not an
							uninstall authority.
						</DialogDescription>
					</DialogHeader>
					<CliCommand command={workspaceSkillRemoveCommand(skill.skill_key, agentType)} />
					<DialogFooter>
						<Button variant="ghost" onClick={() => setOpen(false)}>
							Done
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function CliCommand({ command }: { command: string }) {
	const { copied, copy } = useCopyToClipboard({
		success: "Command copied",
		error: "Couldn't copy command",
	});
	return (
		<div className="flex min-w-0 items-center gap-2 rounded-md border bg-background p-2">
			<code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-xs">
				{command}
			</code>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				onClick={() => void copy(command)}
				aria-label="Copy CLI command"
			>
				{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
			</Button>
		</div>
	);
}
