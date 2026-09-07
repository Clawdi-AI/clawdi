"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	parseWorkspaceSkillGitHubInput,
	workspaceSkillMutationsAvailable,
} from "@/components/dashboard/workspace-skills.logic";
import { ConnectedWorkspaceSkillsPanel } from "@/components/dashboard/workspace-skills-panel";
import { useWorkspaceSkills } from "@/components/dashboard/workspace-skills-query";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { PageHeader, type PageHeaderProps } from "@/components/page-header";
import { SkillCard, SkillCardSkeleton } from "@/components/skills/skill-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	type AgentSkillInventoryItem,
	agentSkillInventory,
} from "@/hosted/agents/agent-skills-inventory";
import { useAgentManagedSkills } from "@/hosted/agents/agent-skills-query";
import { useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { LibrarySkillPicker } from "@/hosted/agents/library-skill-picker";
import {
	normalizeWorkspaceSkillError,
	workspaceSkillErrorNormalizer,
} from "@/hosted/agents/workspace-skill-errors";
import { useBillingClient } from "@/hosted/billing/billing-client";
import { newIdempotencyKey } from "@/hosted/billing/idempotency";
import { billingKeys } from "@/hosted/billing/query-keys";
import { agentDetailQueryOptions } from "@/lib/agent-queries";
import { agentSkillDetailLink } from "@/lib/agent-routes";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { useDeploymentEventStreamActive } from "@/lib/deployment-event-stream-context";
import { eventStreamFallbackInterval } from "@/lib/event-stream-refresh";
import { shouldBlockQueryError } from "@/lib/query-state";

type WorkspaceSkillMutation =
	| { action: "install"; repo: string; path?: string }
	| { action: "uninstall"; skillKey: string }
	| { action: "install-library"; skillId: string }
	| { action: "uninstall-library"; skillId: string };

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
	const $api = useOpenApi();
	const api = useApi();
	const billingClient = useBillingClient();
	const queryClient = useQueryClient();
	const eventStreamActive = useDeploymentEventStreamActive();
	const actionLockedRef = useRef(false);
	const [installOpen, setInstallOpen] = useState(false);
	const [installSource, setInstallSource] = useState<"github" | "library">("library");
	const [librarySkill, setLibrarySkill] = useState<
		components["schemas"]["SkillSummaryResponse"] | null
	>(null);
	const [repoInput, setRepoInput] = useState("");
	const [installError, setInstallError] = useState<string | null>(null);
	const deploymentResolution = useAgentDeployment(agentId, eventStreamActive);
	const deployment = deploymentResolution.deployment;
	const deploymentId = deployment?.resource.id ?? null;
	const isConnectedAgent = deploymentResolution.membershipResolved && !deployment;
	const statusKey = billingKeys.workspaceSkills(deploymentId ?? "");
	const connectedAgent = useQuery({
		...agentDetailQueryOptions($api, queryClient, agentId),
		enabled: isConnectedAgent,
	});
	const workspaceSkills = useWorkspaceSkills(
		agentId,
		projectId,
		deploymentResolution.membershipResolved,
	);

	const status = useQuery({
		queryKey: statusKey,
		queryFn: () => {
			if (!deploymentId) throw new Error("This agent isn't available right now.");
			return billingClient.listWorkspaceSkills(deploymentId);
		},
		enabled: Boolean(deploymentId),
		refetchInterval: eventStreamFallbackInterval(10_000, eventStreamActive),
		refetchIntervalInBackground: false,
	});
	const managedSkills = useAgentManagedSkills(agentId, Boolean(deploymentId));
	const canInstallLibrary = Boolean(managedSkills.data) && !managedSkills.error;
	const canMutate = workspaceSkillMutationsAvailable(status.data, status.error);

	const mutateSkill = useMutation({
		mutationFn: async (variables: WorkspaceSkillMutation) => {
			const { action } = variables;
			if (action === "install-library" || action === "uninstall-library") {
				const params = { path: { agent_id: agentId, skill_id: variables.skillId } };
				return action === "install-library"
					? unwrap(await api.PUT("/v1/agents/{agent_id}/skill-references/{skill_id}", { params }))
					: unwrap(
							await api.DELETE("/v1/agents/{agent_id}/skill-references/{skill_id}", { params }),
						);
			}
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
			void queryClient.invalidateQueries({ queryKey: ["skills"] });
			if ("status" in result && result.status === "failed") {
				if (variables.action.startsWith("install")) {
					setInstallError("Update failed. We'll retry automatically.");
				}
				toast.error("Update failed", {
					description: "We'll retry automatically.",
				});
				return;
			}
			if (variables.action.startsWith("install")) {
				setRepoInput("");
				setInstallError(null);
				setInstallOpen(false);
			}
			toast.success(variables.action.startsWith("install") ? "Skill added" : "Skill removed");
		},
		onError: (error, variables) => {
			if (variables.action.startsWith("install")) {
				setInstallError(normalizeWorkspaceSkillError(error));
			}
			toast.error(
				variables.action.startsWith("install")
					? "Couldn't install skill"
					: "Couldn't uninstall skill",
				{ description: normalizeWorkspaceSkillError(error) },
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
		if (installSource === "library") {
			if (librarySkill)
				void runMutation({ action: "install-library", skillId: librarySkill.id }).catch(() => {});
			return;
		}
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
				projections={(workspaceSkills.data ?? []).filter(
					(skill) => skill.authority === "agent_sync",
				)}
				isLoading={workspaceSkills.isLoading}
				projectionError={
					shouldBlockQueryError(workspaceSkills.error, workspaceSkills.data)
						? workspaceSkills.error
						: undefined
				}
				onRetryProjections={() => {
					void workspaceSkills.refetch();
				}}
				pageHeader={pageHeader}
			/>
		);
	}
	if (deploymentResolution.error || !deployment) {
		return renderPageState(
			<ApiErrorPanel
				error={deploymentResolution.error ?? new Error("Agent not found")}
				normalizer={workspaceSkillErrorNormalizer}
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
	const inventory = agentSkillInventory(
		managedSkills.data?.skills ?? [],
		workspaceSkills.data ?? [],
		status.data?.items ?? [],
	);
	const installAction = (
		<Button
			size="sm"
			onClick={() => setInstallOpen(true)}
			disabled={(!canMutate && !canInstallLibrary) || mutateSkill.isPending}
		>
			<Plus className="size-3.5" />
			Install skill
		</Button>
	);
	return renderPageState(
		<div className="space-y-4">
			{!pageHeader ? (
				<div className="flex justify-end max-sm:[&_[data-slot=button]]:min-h-11">
					{installAction}
				</div>
			) : null}
			{status.data && !canMutate && !status.error ? (
				<Alert>
					<AlertTitle>GitHub installation is unavailable</AlertTitle>
					<AlertDescription>
						{status.data.capability?.reason === "upgrade_not_observed"
							? "Installation will be available when your Agent is ready."
							: "This Agent needs a compatible update before you can install Skills."}
					</AlertDescription>
				</Alert>
			) : null}
			{status.data?.items?.some((skill) => skill.status === "failed") ||
			managedSkills.data?.skills.some((skill) => skill.convergence === "failed") ? (
				<Alert variant="destructive">
					<AlertTitle>Couldn't update Skills</AlertTitle>
					<AlertDescription>We'll retry automatically.</AlertDescription>
				</Alert>
			) : null}
			{managedSkills.data?.removal_failures?.length ? (
				<Alert variant="destructive">
					<AlertTitle>Couldn't remove Skills</AlertTitle>
					<AlertDescription>
						We'll retry automatically.{" "}
						{managedSkills.data.removal_failures?.map((skill) => skill.skill_key).join(", ")}
					</AlertDescription>
				</Alert>
			) : null}
			{managedSkills.error ? (
				<ApiErrorPanel
					error={managedSkills.error}
					onRetry={() => void managedSkills.refetch()}
					title="Couldn't load installed Skills"
				/>
			) : null}
			{workspaceSkills.error ? (
				<ApiErrorPanel
					error={workspaceSkills.error}
					onRetry={() => {
						void workspaceSkills.refetch();
					}}
					title="Couldn't load Skill details"
				/>
			) : null}
			{status.error ? (
				<ApiErrorPanel
					error={status.error}
					normalizer={workspaceSkillErrorNormalizer}
					onRetry={() => {
						void status.refetch();
					}}
					title="Couldn't load skills"
				/>
			) : null}
			{status.isLoading || workspaceSkills.isLoading || managedSkills.isLoading ? (
				<WorkspaceSkillSkeleton />
			) : inventory.length === 0 &&
				!blockingStatusError &&
				!workspaceSkills.error &&
				!managedSkills.error ? (
				<EmptyState
					variant="inset"
					description="No Skills are available in this Agent's Workspace."
				/>
			) : (
				<div className={HERO_GRID_CLASS}>
					{inventory.map((item) => (
						<WorkspaceSkillCard
							key={item.entity.skill_key}
							item={item}
							agentId={agentId}
							projectId={projectId}
							canMutate={canMutate}
							canManageLibrary={canInstallLibrary}
							pending={mutateSkill.isPending}
							onRemove={runMutation}
						/>
					))}
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
						setLibrarySkill(null);
						setInstallError(null);
					}
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Install skill</DialogTitle>
						<DialogDescription>
							Choose a Skill from your Library or a public GitHub repository.
						</DialogDescription>
					</DialogHeader>
					<Tabs
						value={installSource}
						onValueChange={(value) => {
							if (value === "library" || value === "github") {
								setInstallSource(value);
								setInstallError(null);
							}
						}}
					>
						<TabsList>
							<TabsTrigger value="library" disabled={mutateSkill.isPending}>
								Library
							</TabsTrigger>
							<TabsTrigger value="github" disabled={mutateSkill.isPending}>
								GitHub
							</TabsTrigger>
						</TabsList>
						<TabsContent value="library">
							<LibrarySkillPicker
								value={librarySkill}
								onChange={setLibrarySkill}
								disabled={mutateSkill.isPending}
							/>
						</TabsContent>
						<TabsContent value="github">
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
										if (event.key === "Enter" && canMutate && !mutateSkill.isPending)
											submitInstall();
									}}
									placeholder="owner/repo or owner/repo/path-to-skill…"
									autoComplete="off"
									spellCheck={false}
									aria-invalid={Boolean(installError) || undefined}
								/>
								<p className="text-xs text-muted-foreground">
									Use owner/repo or owner/repo/path-to-skill.
								</p>
							</div>
						</TabsContent>
					</Tabs>
					{installError ? (
						<p className="text-sm text-destructive" role="alert">
							{installError}
						</p>
					) : null}
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setInstallOpen(false)}
							disabled={mutateSkill.isPending}
						>
							Cancel
						</Button>
						<Button
							onClick={submitInstall}
							disabled={
								mutateSkill.isPending ||
								(installSource === "library"
									? !canInstallLibrary || !librarySkill
									: !canMutate || !repoInput.trim())
							}
						>
							{mutateSkill.isPending && mutateSkill.variables?.action.startsWith("install") ? (
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

function WorkspaceSkillCard({
	item,
	agentId,
	projectId,
	canMutate,
	canManageLibrary,
	pending,
	onRemove,
}: {
	item: AgentSkillInventoryItem;
	agentId: string;
	projectId: string;
	canMutate: boolean;
	canManageLibrary: boolean;
	pending: boolean;
	onRemove: (mutation: WorkspaceSkillMutation) => Promise<unknown>;
}) {
	const managed = item.managed;
	const libraryReference = managed?.source === "library" && !managed.read_only && managed.skill_id;
	const removable = Boolean(
		(libraryReference && canManageLibrary) || (item.desired && canMutate && !managed?.read_only),
	);
	const detailLink =
		managed?.source === "bundled"
			? undefined
			: managed?.source === "project" && managed.project_id && managed.source_skill_key
				? agentSkillDetailLink(agentId, managed.source_skill_key, managed.project_id)
				: agentSkillDetailLink(agentId, item.entity.skill_key, projectId);
	const provenance =
		managed?.source === "library"
			? "Library"
			: managed?.source === "project"
				? "Linked Project"
				: managed?.source === "bundled"
					? "Built in"
					: item.projectionOnly
						? "Synced from Agent"
						: null;
	return (
		<SkillCard
			skill={item.entity}
			cloudSkill={item.cloudProjection ?? undefined}
			entityLink={detailLink}
			readOnly
			readOnlyLabel={item.projectionOnly ? "Read-only" : null}
			provenanceLabel={provenance}
			showVersion={Boolean(item.cloudProjection?.version)}
			actions={
				removable ? (
					<ConfirmAction
						title={`Uninstall ${item.entity.name} from Agent?`}
						description={
							<p>
								This removes the Skill from this Agent. Your Library and other Agents keep their
								copies.
							</p>
						}
						confirmLabel="Uninstall skill"
						destructive
						onConfirm={() =>
							onRemove(
								libraryReference
									? { action: "uninstall-library", skillId: libraryReference }
									: { action: "uninstall", skillKey: item.entity.skill_key },
							)
						}
					>
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={pending}
							className="text-muted-foreground hover:text-destructive"
							aria-label={`Uninstall ${item.entity.name} from Agent`}
						>
							<Trash2 className="size-3.5" />
						</Button>
					</ConfirmAction>
				) : null
			}
		/>
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
