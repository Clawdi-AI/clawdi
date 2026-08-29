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
import { PageHeader, type PageHeaderProps } from "@/components/page-header";
import { SkillCard, SkillCardSkeleton } from "@/components/skills/skill-card";
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
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { agentSkillDetailLink } from "@/lib/agent-routes";
import type { components } from "@/lib/api-schemas";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

export function ConnectedWorkspaceSkillsPanel({
	agentId,
	projectId,
	agentType,
	projections,
	isLoading,
	projectionError,
	onRetryProjections,
	pageHeader,
}: {
	agentId: string;
	projectId: string;
	agentType: string;
	projections: SkillSummary[];
	isLoading: boolean;
	projectionError?: unknown;
	onRetryProjections?: () => void;
	pageHeader?: Omit<PageHeaderProps, "actions">;
}) {
	const [installOpen, setInstallOpen] = useState(false);
	const [repo, setRepo] = useState("");

	return (
		<div className={pageHeader ? "space-y-6" : "space-y-4"}>
			{pageHeader ? (
				<PageHeader
					{...pageHeader}
					actions={
						<Button size="sm" onClick={() => setInstallOpen(true)}>
							<Plus className="size-3.5" />
							Install skill
						</Button>
					}
				/>
			) : null}
			<Alert>
				<AlertTitle>Install on the Agent</AlertTitle>
				<AlertDescription
					className={
						pageHeader
							? undefined
							: "flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"
					}
				>
					<span>
						This Agent manages its files locally. Run the command on its host; Skills appear here
						after the next sync.
					</span>
					{pageHeader ? null : (
						<Button
							size="sm"
							className="min-h-11 w-full shrink-0 sm:min-h-8 sm:w-auto"
							onClick={() => setInstallOpen(true)}
						>
							<Plus className="size-3.5" />
							Install skill
						</Button>
					)}
				</AlertDescription>
			</Alert>

			{projectionError ? (
				<ApiErrorPanel
					error={projectionError}
					onRetry={onRetryProjections}
					title="Couldn't load synced Skills"
				/>
			) : isLoading ? (
				<div className={HERO_GRID_CLASS}>
					{Array.from({ length: 3 }).map((_, index) => (
						<SkillCardSkeleton key={index} />
					))}
				</div>
			) : projections.length === 0 ? (
				<EmptyState
					variant="inset"
					icon={TerminalSquare}
					description="No Skills have synced from this Agent yet. Install one with the CLI, then sync the Agent."
				/>
			) : (
				<div className={HERO_GRID_CLASS}>
					{projections.map((skill) => (
						<SkillCard
							key={skill.id}
							skill={skill}
							cloudSkill={skill}
							readOnly
							readOnlyLabel="Read-only"
							provenanceLabel="Synced from Agent"
							actions={<ConnectedSkillRemoveAction skill={skill} agentType={agentType} />}
							skillLink={(cloudSkill) =>
								agentSkillDetailLink(agentId, cloudSkill.skill_key, projectId)
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
							Enter a GitHub Skill path, then run the generated command on the Agent machine.
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
				size="icon-sm"
				className="text-muted-foreground hover:text-destructive"
				onClick={() => setOpen(true)}
				aria-label={`Uninstall ${skill.name} from Agent`}
			>
				<Trash2 className="size-3.5" />
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>Uninstall skill</DialogTitle>
						<DialogDescription>
							Run this command on the Agent machine. The Skill belongs to that Workspace.
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
