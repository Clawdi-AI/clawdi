"use client";
import { workspaceSkillsPanelClasses } from "@clawdi/shared/ui";
import {
	agentSurfaceCopy,
	workspaceSkillInstallCommand,
	workspaceSkillRemoveCommand,
} from "@clawdi/shared/view";
import { Check, Copy, Plus, TerminalSquare, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
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
							<Plus className={workspaceSkillsPanelClasses.actionIcon} />
							Install skill
						</Button>
					}
				/>
			) : null}
			<Alert>
				<AlertTitle>{agentSurfaceCopy.installOnTheAgent}</AlertTitle>
				<AlertDescription
					className={
						pageHeader
							? undefined
							: "flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"
					}
				>
					<span>{agentSurfaceCopy.thisAgentManagesItsFilesLocallyRunTheCommand}</span>
					{pageHeader ? null : (
						<Button
							size="sm"
							className={workspaceSkillsPanelClasses.installAction}
							onClick={() => setInstallOpen(true)}
						>
							<Plus className={workspaceSkillsPanelClasses.actionIcon} />
							Install skill
						</Button>
					)}
				</AlertDescription>
			</Alert>

			{projectionError ? (
				<ApiErrorPanel
					error={projectionError}
					onRetry={onRetryProjections}
					title={agentSurfaceCopy.couldnTLoadSyncedSkills}
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
					description={agentSurfaceCopy.noSkillsHaveSyncedFromThisAgent}
				/>
			) : (
				<div className={HERO_GRID_CLASS}>
					{projections.map((skill) => (
						<SkillCard
							key={skill.id}
							skill={skill}
							cloudSkill={skill}
							readOnly
							readOnlyLabel={agentSurfaceCopy.readOnly}
							provenanceLabel={agentSurfaceCopy.syncedFromAgent}
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
				<DialogContent className={workspaceSkillsPanelClasses.dialog}>
					<DialogHeader>
						<DialogTitle>{agentSurfaceCopy.installSkill}</DialogTitle>
						<DialogDescription>
							Enter a GitHub Skill path, then run the generated command on the Agent machine.
						</DialogDescription>
					</DialogHeader>
					<div className={workspaceSkillsPanelClasses.form}>
						<div className={workspaceSkillsPanelClasses.field}>
							<Label htmlFor="workspace-skill-repo">{agentSurfaceCopy.gitHubSkillRepository}</Label>
							<Input
								id="workspace-skill-repo"
								value={repo}
								autoComplete="off"
								spellCheck={false}
								placeholder={agentSurfaceCopy.ownerRepoOrOwnerRepoPathTo}
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
				className={workspaceSkillsPanelClasses.removeAction}
				onClick={() => setOpen(true)}
				aria-label={`Uninstall ${skill.name} from Agent`}
			>
				<Trash2 className={workspaceSkillsPanelClasses.actionIcon} />
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className={workspaceSkillsPanelClasses.dialog}>
					<DialogHeader>
						<DialogTitle>{agentSurfaceCopy.uninstallSkill}</DialogTitle>
						<DialogDescription>
							{agentSurfaceCopy.runThisCommandOnTheAgentMachineTheSkill}
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
		<div className={workspaceSkillsPanelClasses.commandRow}>
			<code className={workspaceSkillsPanelClasses.command}>{command}</code>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				onClick={() => void copy(command)}
				aria-label="Copy CLI command"
			>
				{copied ? (
					<Check className={workspaceSkillsPanelClasses.actionIcon} />
				) : (
					<Copy className={workspaceSkillsPanelClasses.actionIcon} />
				)}
			</Button>
		</div>
	);
}
