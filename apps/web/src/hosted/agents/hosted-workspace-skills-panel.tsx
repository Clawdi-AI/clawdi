"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	mergeWorkspaceRuntimeSkills,
	parseWorkspaceSkillGitHubInput,
	workspaceSkillMutationsAvailable,
} from "@/components/dashboard/workspace-skills.logic";
import { ConnectedWorkspaceSkillsPanel } from "@/components/dashboard/workspace-skills-panel";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { PageHeader, type PageHeaderProps } from "@/components/page-header";
import { SkillCard, SkillCardSkeleton } from "@/components/skills/skill-card";
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
import { Spinner } from "@/components/ui/spinner";
import { useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { useBillingClient } from "@/hosted/billing/billing-client";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { newIdempotencyKey } from "@/hosted/billing/idempotency";
import { agentDetailQueryOptions } from "@/lib/agent-queries";
import { agentSkillDetailLink } from "@/lib/agent-routes";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import { useDeploymentEventStreamActive } from "@/lib/deployment-event-stream-context";
import { shouldBlockQueryError } from "@/lib/query-state";

type WorkspaceSkillMutation =
	| { action: "install"; repo: string; path?: string }
	| { action: "uninstall"; skillKey: string };

type HostedWorkspaceSkillsPanelProps = {
	agentId: string;
	projectId: string;
	pageHeader?: Omit<PageHeaderProps, "actions">;
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
	pageHeader,
}: HostedWorkspaceSkillsPanelProps) {
	const api = useApi();
	const $api = useOpenApi();
	const billingClient = useBillingClient();
	const queryClient = useQueryClient();
	const eventStreamActive = useDeploymentEventStreamActive();
	const actionLockedRef = useRef(false);
	const [installOpen, setInstallOpen] = useState(false);
	const [repoInput, setRepoInput] = useState("");
	const [installError, setInstallError] = useState<string | null>(null);
	const deploymentResolution = useAgentDeployment(agentId, eventStreamActive);
	const deployment = deploymentResolution.deployment;
	const deploymentId = deployment?.resource.id ?? null;
	const isConnectedAgent = deploymentResolution.membershipResolved && !deployment;
	const statusKey = ["hosted", "deployments", deploymentId, "skills"] as const;
	const connectedAgent = useQuery({
		...agentDetailQueryOptions($api, queryClient, agentId),
		enabled: isConnectedAgent,
	});
	const connectedSkills = useQuery({
		queryKey: ["skills", "connected-workspace", projectId],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/skills", {
					params: { query: { project_id: projectId, page: 1, page_size: 200 } },
				}),
			),
		enabled: isConnectedAgent,
	});

	const status = useQuery({
		queryKey: statusKey,
		queryFn: () => {
			if (!deploymentId) throw new Error("This agent isn't available right now.");
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
		if (actionLockedRef.current) return Promise.resolve();
		actionLockedRef.current = true;
		return mutateSkill.mutateAsync(variables);
	};
	const submitInstall = () => {
		setInstallError(null);
		try {
			const request = parseWorkspaceSkillGitHubInput(repoInput);
			void runMutation({ action: "install", ...request, path: request.path ?? undefined }).catch(
				() => {},
			);
		} catch {
			setInstallError("Couldn't add this Skill. Check the GitHub repository and try again.");
		}
	};
	const renderPageState = (content: ReactNode, actions?: ReactNode) =>
		pageHeader ? (
			<div className="space-y-6">
				<PageHeader {...pageHeader} actions={actions} />
				{content}
			</div>
		) : (
			content
		);

	if (
		deploymentResolution.isLoading ||
		(!deploymentResolution.membershipResolved && !deployment && !deploymentResolution.error)
	) {
		return renderPageState(<WorkspaceSkillSkeleton />);
	}
	if (isConnectedAgent) {
		const blockingAgentError = shouldBlockQueryError(connectedAgent.error, connectedAgent.data);
		if (blockingAgentError) {
			return renderPageState(
				<ApiErrorPanel
					error={blockingAgentError}
					onRetry={() => {
						void connectedAgent.refetch();
					}}
					title="Couldn't load the Agent identity"
				/>,
			);
		}
		if (!connectedAgent.data) return renderPageState(<WorkspaceSkillSkeleton />);
		return (
			<ConnectedWorkspaceSkillsPanel
				agentId={agentId}
				projectId={projectId}
				agentType={connectedAgent.data.agent_type}
				projections={(connectedSkills.data?.items ?? []).filter(
					(skill) => skill.authority === "agent_sync",
				)}
				isLoading={connectedSkills.isLoading}
				projectionError={
					shouldBlockQueryError(connectedSkills.error, connectedSkills.data)
						? connectedSkills.error
						: undefined
				}
				onRetryProjections={() => {
					void connectedSkills.refetch();
				}}
				pageHeader={pageHeader}
			/>
		);
	}
	if (deploymentResolution.error || !deployment) {
		return renderPageState(
			<ApiErrorPanel
				error={deploymentResolution.error ?? new Error("Agent not found")}
				onRetry={() => {
					void deploymentResolution.refetch();
				}}
				title="Couldn't load this Agent"
			/>,
		);
	}

	const blockingStatusError = shouldBlockQueryError(status.error, status.data)
		? status.error
		: null;
	const inventory = mergeWorkspaceRuntimeSkills([], status.data?.items ?? []);
	const installAction = canMutate ? (
		<Button size="sm" onClick={() => setInstallOpen(true)} disabled={mutateSkill.isPending}>
			<Plus className="size-3.5" />
			Install skill
		</Button>
	) : undefined;
	return renderPageState(
		<div className="space-y-4">
			{canMutate && !pageHeader ? (
				<div className="flex justify-end max-sm:[&_[data-slot=button]]:min-h-11">
					{installAction}
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
				<WorkspaceSkillSkeleton />
			) : inventory.length === 0 ? (
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
									agentSkillDetailLink(agentId, cloudSkill.skill_key, projectId)
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
		</div>,
		installAction,
	);
}

function WorkspaceSkillSkeleton() {
	return (
		<div className={HERO_GRID_CLASS}>
			{Array.from({ length: 3 }).map((_, index) => (
				<SkillCardSkeleton key={index} />
			))}
		</div>
	);
}
