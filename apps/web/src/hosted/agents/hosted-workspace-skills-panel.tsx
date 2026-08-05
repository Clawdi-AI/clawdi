"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { mergeWorkspaceRuntimeSkills } from "@/components/dashboard/workspace-skills.logic";
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
import { deploymentRuntime, runtimeSupportsSkillInstall } from "@/hosted/runtimes";
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
	const runtime = deployment ? deploymentRuntime(deployment) : null;
	const canInstall = runtime ? runtimeSupportsSkillInstall(runtime) : false;
	const deploymentId = deployment?.resource.id ?? null;
	const catalogKey = ["hosted", "skills", "catalog"] as const;
	const statusKey = ["hosted", "deployments", deploymentId, "skills"] as const;

	const catalog = useQuery({
		queryKey: catalogKey,
		queryFn: () => billingClient.listSkillCatalog(),
		enabled: Boolean(deploymentId && canInstall),
	});
	const status = useQuery({
		queryKey: statusKey,
		queryFn: () => {
			if (!deploymentId) throw new Error("Deployment is not available");
			return billingClient.listWorkspaceSkills(deploymentId);
		},
		enabled: Boolean(deploymentId && canInstall),
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
			if (!deploymentId || !canInstall || !resourceVersion) {
				throw new Error("Workspace Skill desired state is not available");
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
			if (result.reconciliation_status === "failed") {
				toast.error("Workspace Skill reconciliation needs attention", {
					description: result.failure_message ?? "The control plane will retry reconciliation.",
				});
				return;
			}
			toast.success(
				variables.action === "install"
					? "Skill installation requested"
					: "Skill uninstall requested",
				{ description: "Hermes is reconciling the Workspace desired state." },
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

	if (!canInstall) {
		return (
			<div>
				<ProjectionCards
					agentId={agentId}
					projectId={projectId}
					routeSearch={routeSearch}
					projections={projections}
					isLoading={projectionsLoading}
					error={projectionError}
					onRetry={onRetryProjections}
				/>
			</div>
		);
	}

	const blockingCatalogError = shouldBlockQueryError(catalog.error, catalog.data)
		? catalog.error
		: null;
	const blockingStatusError = shouldBlockQueryError(status.error, status.data)
		? status.error
		: null;
	if (blockingStatusError) {
		return (
			<div className="space-y-4">
				<ApiErrorPanel
					error={blockingStatusError}
					onRetry={() => {
						void status.refetch();
					}}
					title="Couldn't load Workspace Skill status"
				/>
				<ProjectionCards
					agentId={agentId}
					projectId={projectId}
					routeSearch={routeSearch}
					projections={projections}
					isLoading={projectionsLoading}
					error={projectionError}
					onRetry={onRetryProjections}
				/>
			</div>
		);
	}

	if (status.isLoading) {
		return <WorkspaceSkillSkeleton />;
	}

	const inventory = mergeWorkspaceRuntimeSkills(
		projectionError ? [] : projections,
		status.data?.items ?? [],
		blockingCatalogError ? [] : (catalog.data?.items ?? []),
	);
	return (
		<div className="space-y-4">
			{blockingCatalogError ? (
				<ApiErrorPanel
					error={blockingCatalogError}
					onRetry={() => {
						void catalog.refetch();
					}}
					title="Skill install catalog unavailable"
				/>
			) : catalog.isLoading ? (
				<p className="text-xs text-muted-foreground">Loading install catalog…</p>
			) : null}
			{projectionError ? (
				<ApiErrorPanel
					error={projectionError}
					onRetry={onRetryProjections}
					title="Runtime Skill observations unavailable"
				/>
			) : projectionsLoading ? (
				<p className="text-xs text-muted-foreground">Loading read-only runtime observations…</p>
			) : null}
			{inventory.length === 0 ? (
				<EmptyState variant="inset" description="No Skills are available for this Agent runtime." />
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
								readOnlyLabel={item.cloudProjection ? "Agent projection · Read-only" : null}
								showVersion={Boolean(item.cloudProjection?.version)}
								actions={
									item.desired ? (
										<div className="flex flex-wrap items-center gap-2">
											<Badge
												variant={
													item.desired.reconciliation_status === "failed"
														? "destructive"
														: "secondary"
												}
												title={item.desired.failure_message ?? undefined}
											>
												{item.desired.reconciliation_status === "failed" ? "Failed" : "Reconciling"}
											</Badge>
											<ConfirmAction
												title={`Uninstall ${item.entity.name} from Agent?`}
													description={
														<p>The runtime driver will remove only the manifest-owned Workspace copy.</p>
													}
												confirmLabel="Uninstall skill"
												destructive
												onConfirm={() => runMutation("uninstall", item.entity.skill_key)}
											>
												<Button variant="ghost" size="sm" disabled={pending}>
													{pending ? (
														<Spinner className="size-3.5" />
													) : (
														<Trash2 className="size-3.5" />
													)}
													{pendingAction === "uninstall" ? "Uninstalling…" : "Uninstall"}
												</Button>
											</ConfirmAction>
										</div>
									) : item.installable ? (
										<Button
											variant="outline"
											size="sm"
											disabled={pending}
											onClick={() => runMutation("install", item.entity.skill_key)}
										>
											{pending ? <Spinner className="size-3.5" /> : <Plus className="size-3.5" />}
											{pendingAction === "install" ? "Installing…" : "Install"}
										</Button>
									) : item.cloudProjection ? (
										<Badge variant="secondary">Agent projection · Read-only</Badge>
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

function ProjectionCards({
	agentId,
	projectId,
	routeSearch,
	projections,
	isLoading,
	error,
	onRetry,
}: {
	agentId: string;
	projectId: string;
	routeSearch?: AgentRouteQuery;
	projections: SkillSummary[];
	isLoading: boolean;
	error?: unknown;
	onRetry?: () => void;
}) {
	if (error) {
		return (
			<ApiErrorPanel error={error} onRetry={onRetry} title="Runtime Skill observations unavailable" />
		);
	}
	if (isLoading) return <WorkspaceSkillSkeleton />;
	if (projections.length === 0) {
		return <EmptyState variant="inset" description="No Agent-synced Skill projections yet." />;
	}
	return (
		<div className={HERO_GRID_CLASS}>
			{projections.map((skill) => (
				<SkillCard
					key={skill.id}
					skill={skill}
					cloudSkill={skill}
					readOnly
					readOnlyLabel="Agent projection · Read-only"
					skillLink={(cloudSkill) =>
						agentSkillDetailLink(agentId, cloudSkill.skill_key, projectId, routeSearch)
					}
				/>
			))}
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
