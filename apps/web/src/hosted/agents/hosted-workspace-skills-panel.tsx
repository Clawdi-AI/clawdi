"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	mergeWorkspaceRuntimeSkills,
	parseWorkspaceSkillGitHubInput,
	workspaceSkillMutationsAvailable,
} from "@/components/dashboard/workspace-skills.logic";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { SkillCard } from "@/components/skills/skill-card";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
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
import { Spinner } from "@/components/ui/spinner";
import { useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { useBillingClient } from "@/hosted/billing/billing-client";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { newIdempotencyKey } from "@/hosted/billing/idempotency";
import type { AgentRouteQuery } from "@/lib/agent-routes";
import { agentSkillDetailLink } from "@/lib/agent-routes";
import type { components } from "@/lib/api-schemas";
import { shouldBlockQueryError } from "@/lib/query-state";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type WorkspaceSkillMutation =
	| { action: "install"; repo: string; path?: string }
	| { action: "uninstall"; skillKey: string };

type HostedWorkspaceSkillsPanelProps = {
	agentId: string;
	projectId: string;
	routeSearch?: AgentRouteQuery;
	deploymentSelector?: string | null;
	projections: SkillSummary[];
	projectionsLoading: boolean;
	projectionError?: unknown;
	onRetryProjections?: () => void;
};

export function HostedWorkspaceSkillsPanel(props: HostedWorkspaceSkillsPanelProps) {
	return (
		<div data-hosted="true" className="contents">
			<HostedWorkspaceSkillsPanelContent {...props} />
		</div>
	);
}

function HostedWorkspaceSkillsPanelContent({
	agentId,
	projectId,
	routeSearch,
	deploymentSelector,
	projections,
	projectionsLoading,
	projectionError,
	onRetryProjections,
}: HostedWorkspaceSkillsPanelProps) {
	const billingClient = useBillingClient();
	const queryClient = useQueryClient();
	const actionLockedRef = useRef(false);
	const [installOpen, setInstallOpen] = useState(false);
	const [repoInput, setRepoInput] = useState("");
	const [installError, setInstallError] = useState<string | null>(null);
	const deploymentResolution = useAgentDeployment(agentId, deploymentSelector);
	const deployment = deploymentResolution.deployment;
	const deploymentId = deployment?.resource.id ?? null;
	const statusKey = ["hosted", "deployments", deploymentId, "skills"] as const;

	const status = useQuery({
		queryKey: statusKey,
		queryFn: () => {
			if (!deploymentId) throw new Error("Deployment is not available");
			return billingClient.listWorkspaceSkills(deploymentId);
		},
		enabled: Boolean(deploymentId),
	});
	const canMutate = workspaceSkillMutationsAvailable(status.data, status.error);

	const mutateSkill = useMutation({
		mutationFn: async (variables: WorkspaceSkillMutation) => {
			const { action } = variables;
			const resourceVersion = status.data?.deployment_resource_version;
			if (!deploymentId || !canMutate || !resourceVersion) {
				throw new Error("Skill management isn't available right now.");
			}
			const idempotencyKey = newIdempotencyKey(`workspace-skill-${action}`);
			if (action === "uninstall") {
				return billingClient.uninstallWorkspaceSkill(
					deploymentId,
					variables.skillKey,
					resourceVersion,
					idempotencyKey,
				);
			}
			return billingClient.installWorkspaceSkill(
				deploymentId,
				{ repo: variables.repo, path: variables.path },
				resourceVersion,
				idempotencyKey,
			);
		},
		onSuccess: (result, variables) => {
			void queryClient.invalidateQueries({ queryKey: statusKey });
			if (result.status === "failed") {
				if (variables.action === "install") {
					setInstallError("Update failed. We'll retry automatically.");
				}
				toast.error("Update failed", {
					description: "We'll retry automatically.",
				});
				return;
			}
			if (variables.action === "install") {
				setRepoInput("");
				setInstallError(null);
				setInstallOpen(false);
			}
			toast.success(variables.action === "install" ? "Skill added" : "Skill removed");
		},
		onError: (error, variables) => {
			if (variables.action === "install") {
				setInstallError(normalizeBillingError(error));
			}
			toast.error(
				variables.action === "install" ? "Couldn't install skill" : "Couldn't uninstall skill",
				{ description: normalizeBillingError(error) },
			);
		},
		onSettled: () => {
			actionLockedRef.current = false;
		},
	});

	const runMutation = (variables: WorkspaceSkillMutation) => {
		if (actionLockedRef.current) return;
		actionLockedRef.current = true;
		mutateSkill.mutate(variables);
	};
	const submitInstall = () => {
		setInstallError(null);
		try {
			const request = parseWorkspaceSkillGitHubInput(repoInput);
			runMutation({ action: "install", ...request, path: request.path ?? undefined });
		} catch (error) {
			setInstallError(error instanceof Error ? error.message : "Enter a valid GitHub repository.");
		}
	};

	if (deploymentResolution.isLoading) {
		return <WorkspaceSkillSkeleton />;
	}
	if (deploymentResolution.error || !deployment) {
		return (
			<ApiErrorPanel
				error={deploymentResolution.error ?? new Error("Hosted deployment not found")}
				onRetry={() => {
					void deploymentResolution.refetch();
				}}
				title="Couldn't load the Agent runtime"
			/>
		);
	}

	const blockingStatusError = shouldBlockQueryError(status.error, status.data)
		? status.error
		: null;
	const inventory = mergeWorkspaceRuntimeSkills(projections, status.data?.items ?? []);
	return (
		<div className="space-y-4">
			{canMutate ? (
				<div className="flex justify-end">
					<Button onClick={() => setInstallOpen(true)} disabled={mutateSkill.isPending}>
						<Plus className="size-3.5" />
						Install skill
					</Button>
				</div>
			) : null}
			{blockingStatusError ? (
				<ApiErrorPanel
					error={blockingStatusError}
					onRetry={() => {
						void status.refetch();
					}}
					title="Couldn't load skills"
				/>
			) : status.isLoading ? (
				<p className="text-xs text-muted-foreground">Loading skills…</p>
			) : null}
			{projectionError ? (
				<ApiErrorPanel
					error={projectionError}
					onRetry={onRetryProjections}
					title="Couldn't load Agent skills"
				/>
			) : projectionsLoading ? (
				<p className="text-xs text-muted-foreground">Loading Agent skills…</p>
			) : null}
			{inventory.length === 0 ? (
				<EmptyState
					variant="inset"
					description="No Skills are available in this Agent's Workspace."
				/>
			) : (
				<div className={HERO_GRID_CLASS}>
					{inventory.map((item) => {
						const pending =
							mutateSkill.isPending &&
							mutateSkill.variables?.action === "uninstall" &&
							mutateSkill.variables.skillKey === item.entity.skill_key;
						const pendingAction = pending ? mutateSkill.variables?.action : null;
						return (
							<SkillCard
								key={item.entity.skill_key}
								skill={item.entity}
								cloudSkill={item.cloudProjection ?? undefined}
								readOnly
								readOnlyLabel={item.projectionOnly ? "Synced from Agent · Read-only" : null}
								showVersion={Boolean(item.cloudProjection?.version)}
								actions={
									item.desired ? (
										<div className="flex flex-wrap items-center gap-2">
											{canMutate ? (
												<ConfirmAction
													title={`Uninstall ${item.entity.name} from Agent?`}
													description={
														<p>
															This removes the copy installed by this Workspace. Other copies won't
															be affected.
														</p>
													}
													confirmLabel="Uninstall skill"
													destructive
													onConfirm={() =>
														runMutation({ action: "uninstall", skillKey: item.entity.skill_key })
													}
												>
													<Button variant="ghost" size="sm" disabled={mutateSkill.isPending}>
														{pending ? (
															<Spinner className="size-3.5" />
														) : (
															<Trash2 className="size-3.5" />
														)}
														{pendingAction === "uninstall" ? "Uninstalling…" : "Uninstall"}
													</Button>
												</ConfirmAction>
											) : null}
										</div>
									) : null
								}
								skillLink={(cloudSkill) =>
									agentSkillDetailLink(agentId, cloudSkill.skill_key, projectId, routeSearch)
								}
							/>
						);
					})}
				</div>
			)}
			<Dialog
				open={installOpen}
				onOpenChange={(open) => {
					if (!mutateSkill.isPending) setInstallOpen(open);
				}}
				onOpenChangeComplete={(open) => {
					if (!open) {
						setRepoInput("");
						setInstallError(null);
					}
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Install skill</DialogTitle>
						<DialogDescription>Install from a public GitHub Skill repository.</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor={`hosted-workspace-skill-repo-${agentId}`}>
							GitHub Skill repository
						</Label>
						<Input
							id={`hosted-workspace-skill-repo-${agentId}`}
							value={repoInput}
							onChange={(event) => {
								setRepoInput(event.target.value);
								setInstallError(null);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !mutateSkill.isPending) submitInstall();
							}}
							placeholder="owner/repo or owner/repo/path-to-skill…"
							autoComplete="off"
							spellCheck={false}
							aria-invalid={Boolean(installError) || undefined}
						/>
						<p className="text-xs text-muted-foreground">
							Use owner/repo or owner/repo/path-to-skill.
						</p>
						{installError ? <p className="text-xs text-destructive">{installError}</p> : null}
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setInstallOpen(false)}
							disabled={mutateSkill.isPending}
						>
							Cancel
						</Button>
						<Button onClick={submitInstall} disabled={!repoInput.trim() || mutateSkill.isPending}>
							{mutateSkill.isPending && mutateSkill.variables?.action === "install" ? (
								<Spinner />
							) : (
								<Plus className="size-3.5" />
							)}
							Install skill
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function WorkspaceSkillSkeleton() {
	return (
		<div className={HERO_GRID_CLASS}>
			{Array.from({ length: 3 }).map((_, index) => (
				<Skeleton key={index} className="h-28 w-full rounded-xl" />
			))}
		</div>
	);
}
