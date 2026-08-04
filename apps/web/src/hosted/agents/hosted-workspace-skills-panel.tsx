"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	hostedSkillInstallOutcome,
	mergeWorkspaceRuntimeSkills,
} from "@/components/dashboard/workspace-skills.logic";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { SkillCard } from "@/components/skills/skill-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { useBillingClient } from "@/hosted/billing/billing-client";
import {
	deploymentRuntime,
	runtimeDisplayName,
	runtimeSupportsSkillInstall,
} from "@/hosted/runtimes";
import type { AgentRouteQuery } from "@/lib/agent-routes";
import { agentSkillDetailLink } from "@/lib/agent-routes";
import type { components } from "@/lib/api-schemas";
import { shouldBlockQueryError } from "@/lib/query-state";
import { errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

export function HostedWorkspaceSkillsPanel({
	agentId,
	projectId,
	routeSearch,
	deploymentSelector,
	projections,
	projectionsLoading,
	projectionError,
	onRetryProjections,
}: {
	agentId: string;
	projectId: string;
	routeSearch?: AgentRouteQuery;
	deploymentSelector?: string | null;
	projections: SkillSummary[];
	projectionsLoading: boolean;
	projectionError?: unknown;
	onRetryProjections?: () => void;
}) {
	const billingClient = useBillingClient();
	const queryClient = useQueryClient();
	const actionLockedRef = useRef(false);
	const [pendingInstallKeys, setPendingInstallKeys] = useState<Set<string>>(() => new Set());
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
			return billingClient.getDeploymentSkills(deploymentId);
		},
		enabled: Boolean(deploymentId && canInstall),
	});

	useEffect(() => {
		const installedKeys = new Set(
			(status.data?.skills ?? []).map((skill) => skill.skill_key).filter(Boolean),
		);
		setPendingInstallKeys((current) => {
			const next = new Set([...current].filter((skillKey) => !installedKeys.has(skillKey)));
			return next.size === current.size ? current : next;
		});
	}, [status.data?.skills]);

	const mutateSkill = useMutation({
		mutationFn: async ({
			action,
			skillKey,
		}: {
			action: "install" | "uninstall";
			skillKey: string;
		}) => {
			if (!deploymentId || !canInstall) throw new Error("Skill install is not supported here");
			if (action === "uninstall") {
				return billingClient.uninstallDeploymentSkill(deploymentId, skillKey);
			}
			const result = await billingClient.installDeploymentSkill(deploymentId, skillKey);
			if (hostedSkillInstallOutcome(result) === "failed") {
				throw new Error(result.error || "The runtime rejected installation");
			}
			return result;
		},
		onSuccess: (result, variables) => {
			const installOutcome =
				variables.action === "install" && "status" in result && typeof result.status === "string"
					? hostedSkillInstallOutcome({ ok: result.ok, status: result.status })
					: null;
			if (installOutcome === "pending") {
				setPendingInstallKeys((current) => new Set(current).add(variables.skillKey));
				toast.warning("Skill install is awaiting runtime confirmation", {
					description: "Files were placed. Refreshing the deployment's authoritative Skill status.",
				});
				void status.refetch();
				return;
			}
			void queryClient.invalidateQueries({ queryKey: statusKey });
			toast.success(
				variables.action === "install"
					? "Skill installed on Agent"
					: "Skill uninstalled from Agent",
			);
		},
		onError: (error, variables) => {
			toast.error(
				variables.action === "install"
					? "Couldn't install Skill on Agent"
					: "Couldn't uninstall Skill from Agent",
				{ description: errorMessage(error) },
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
			<div className="space-y-4">
				<Alert>
					<AlertTitle>Install on Agent is unavailable</AlertTitle>
					<AlertDescription>
						{runtimeDisplayName(deploymentRuntime(deployment))} does not expose a deployment Skill
						install capability. Cloud projection details remain read-only.
					</AlertDescription>
				</Alert>
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
			<ApiErrorPanel
				error={blockingStatusError}
				onRetry={() => {
					void status.refetch();
				}}
				title="Couldn't load Agent runtime Skills"
			/>
		);
	}

	if (status.isLoading) {
		return <WorkspaceSkillSkeleton />;
	}

	const inventory = mergeWorkspaceRuntimeSkills(
		projectionError ? [] : projections,
		status.data?.skills ?? [],
		blockingCatalogError ? [] : (catalog.data?.items ?? []),
	);
	return (
		<div className="space-y-4">
			<Alert>
				<AlertTitle>Agent runtime is the install authority</AlertTitle>
				<AlertDescription>
					Install status and controls come directly from this deployment. Synced Cloud projection
					content remains read-only.
				</AlertDescription>
			</Alert>
			{pendingInstallKeys.size > 0 ? (
				<Alert>
					<AlertTitle>Awaiting runtime confirmation</AlertTitle>
					<AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
						<span>
							Install files were placed, but runtime status has not confirmed them yet. Install
							stays disabled until it does.
						</span>
						<Button
							variant="outline"
							size="sm"
							disabled={status.isFetching}
							onClick={() => void status.refetch()}
						>
							{status.isFetching ? (
								<Spinner className="size-3.5" />
							) : (
								<RefreshCw className="size-3.5" />
							)}
							Refresh status
						</Button>
					</AlertDescription>
				</Alert>
			) : null}
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
					title="Cloud Skill projections unavailable"
				/>
			) : projectionsLoading ? (
				<p className="text-xs text-muted-foreground">Loading read-only Cloud projections…</p>
			) : null}
			{inventory.length === 0 ? (
				<EmptyState variant="inset" description="No Skills are available for this Agent runtime." />
			) : (
				<div className={HERO_GRID_CLASS}>
					{inventory.map((item) => {
						const pending =
							pendingInstallKeys.has(item.entity.skill_key) ||
							(mutateSkill.isPending && mutateSkill.variables?.skillKey === item.entity.skill_key);
						return (
							<SkillCard
								key={item.entity.skill_key}
								skill={item.entity}
								cloudSkill={item.cloudProjection ?? undefined}
								readOnly
								readOnlyLabel={item.cloudProjection ? "Agent projection · Read-only" : null}
								showVersion={Boolean(item.cloudProjection?.version)}
								actions={
									item.installed && item.locked ? (
										<Badge variant="secondary">Runtime-managed</Badge>
									) : item.installed ? (
										<ConfirmAction
											title={`Uninstall ${item.entity.name} from Agent?`}
											description={<p>The deployment runtime will remove its workspace copy.</p>}
											confirmLabel="Uninstall from Agent"
											destructive
											onConfirm={() => runMutation("uninstall", item.entity.skill_key)}
										>
											<Button variant="ghost" size="sm" disabled={pending}>
												{pending ? (
													<Spinner className="size-3.5" />
												) : (
													<Trash2 className="size-3.5" />
												)}
												Uninstall from Agent
											</Button>
										</ConfirmAction>
									) : item.installable ? (
										<Button
											variant="outline"
											size="sm"
											disabled={pending}
											onClick={() => runMutation("install", item.entity.skill_key)}
										>
											{pending ? <Spinner className="size-3.5" /> : <Plus className="size-3.5" />}
											{pending ? "Awaiting runtime" : "Install on Agent"}
										</Button>
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
			<ApiErrorPanel error={error} onRetry={onRetry} title="Cloud Skill projections unavailable" />
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
