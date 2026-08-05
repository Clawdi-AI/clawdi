"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	mergeWorkspaceRuntimeSkills,
	workspaceSkillMutationsAvailable,
	workspaceSkillStatusLabel,
} from "@/components/dashboard/workspace-skills.logic";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { SkillCard } from "@/components/skills/skill-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
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
	const deploymentResolution = useAgentDeployment(agentId, deploymentSelector);
	const deployment = deploymentResolution.deployment;
	const deploymentId = deployment?.resource.id ?? null;
	const catalogKey = ["hosted", "skills", "catalog"] as const;
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
	const catalog = useQuery({
		queryKey: catalogKey,
		queryFn: () => billingClient.listSkillCatalog(),
		enabled: canMutate,
	});

	const mutateSkill = useMutation({
		mutationFn: async ({
			action,
			skillKey,
		}: {
			action: "install" | "uninstall";
			skillKey: string;
		}) => {
			const resourceVersion = status.data?.deployment_resource_version;
			if (!deploymentId || !canMutate || !resourceVersion) {
				throw new Error("Skill management isn't available right now.");
			}
			const idempotencyKey = newIdempotencyKey(`workspace-skill-${action}`);
			if (action === "uninstall") {
				return billingClient.uninstallWorkspaceSkill(
					deploymentId,
					skillKey,
					resourceVersion,
					idempotencyKey,
				);
			}
			return billingClient.installWorkspaceSkill(
				deploymentId,
				skillKey,
				resourceVersion,
				idempotencyKey,
			);
		},
		onSuccess: (result, variables) => {
			void queryClient.invalidateQueries({ queryKey: statusKey });
			if (result.status === "failed") {
				toast.error("Skill update needs attention", {
					description: "We'll retry automatically.",
				});
				return;
			}
			toast.success(
				variables.action === "install"
					? "Skill installation requested"
					: "Skill uninstall requested",
			);
		},
		onError: (error, variables) => {
			toast.error(
				variables.action === "install" ? "Couldn't install skill" : "Couldn't uninstall skill",
				{ description: normalizeBillingError(error) },
			);
		},
		onSettled: () => {
			actionLockedRef.current = false;
		},
	});

	const runMutation = (action: "install" | "uninstall", skillKey: string) => {
		if (actionLockedRef.current) return;
		actionLockedRef.current = true;
		mutateSkill.mutate({ action, skillKey });
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

	const blockingCatalogError = shouldBlockQueryError(catalog.error, catalog.data)
		? catalog.error
		: null;
	const blockingStatusError = shouldBlockQueryError(status.error, status.data)
		? status.error
		: null;
	const inventory = mergeWorkspaceRuntimeSkills(
		projections,
		status.data?.items ?? [],
		canMutate && !blockingCatalogError ? (catalog.data?.items ?? []) : [],
	);
	return (
		<div className="space-y-4">
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
			{blockingCatalogError ? (
				<ApiErrorPanel
					error={blockingCatalogError}
					onRetry={() => {
						void catalog.refetch();
					}}
					title="Couldn't load installable skills"
				/>
			) : catalog.isLoading ? (
				<p className="text-xs text-muted-foreground">Loading installable skills…</p>
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
							mutateSkill.isPending && mutateSkill.variables?.skillKey === item.entity.skill_key;
						const pendingAction = pending ? mutateSkill.variables?.action : null;
						return (
							<SkillCard
								key={item.entity.skill_key}
								skill={item.entity}
								cloudSkill={item.cloudProjection ?? undefined}
								readOnly
								readOnlyLabel={item.cloudProjection ? "Synced from Agent · Read-only" : null}
								showVersion={Boolean(!item.desired && item.cloudProjection?.version)}
								actions={
									item.desired ? (
										<div className="flex flex-wrap items-center gap-2">
											<Badge
												variant={item.desired.status === "failed" ? "destructive" : "secondary"}
												title={
													item.desired.status === "failed"
														? "We'll retry automatically."
														: undefined
												}
											>
												{workspaceSkillStatusLabel(item.desired.status)}
											</Badge>
											{canMutate ? (
												<ConfirmAction
													title={`Uninstall ${item.entity.name} from Agent?`}
													description={
														<p>
															This removes the copy managed by this Workspace. Other copies won't be
															affected.
														</p>
													}
													confirmLabel="Uninstall skill"
													destructive
													onConfirm={() => runMutation("uninstall", item.entity.skill_key)}
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
									) : canMutate && item.installable ? (
										<Button
											variant="outline"
											size="sm"
											disabled={mutateSkill.isPending}
											onClick={() => runMutation("install", item.entity.skill_key)}
										>
											{pending ? <Spinner className="size-3.5" /> : <Plus className="size-3.5" />}
											{pendingAction === "install" ? "Installing…" : "Install"}
										</Button>
									) : item.cloudProjection ? (
										<Badge variant="secondary">Synced from Agent · Read-only</Badge>
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
