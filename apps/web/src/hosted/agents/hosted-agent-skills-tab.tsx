"use client";

import { AlertCircle, CheckCircle2, Clock3, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { AgentSkillsTab } from "@/components/dashboard/agent-skills-tab";
import { HERO_GRID_CLASS, HeroCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useAgentRuntimeObserved } from "@/hooks/use-agent-runtime-observed";
import { useUpdateDeployment } from "@/hosted/agents/deployment-hooks";
import {
	buildManifestSkillUpdate,
	canonicalManifestSkills,
	type ManifestSkillConfiguration,
	manifestSkillConvergence,
} from "@/hosted/agents/hosted-agent-skills";
import type { DeploymentUpdateRequest, HostedDeployment } from "@/hosted/billing/contracts";
import type { AgentRouteSearch } from "@/lib/agent-routes";

export function HostedAgentSkillsTab({
	environmentId,
	agentProjectId,
	deployment,
	routeSearch,
	projectionAvailable,
}: {
	environmentId: string;
	agentProjectId: string | null | undefined;
	deployment: HostedDeployment;
	routeSearch: AgentRouteSearch;
	projectionAvailable: boolean;
}) {
	let manifestSkills: ReturnType<typeof canonicalManifestSkills> | null;
	try {
		manifestSkills = canonicalManifestSkills(deployment);
	} catch {
		manifestSkills = null;
	}
	const runtimeObserved = useAgentRuntimeObserved(
		environmentId,
		projectionAvailable,
		deployment.resource.metadata.resourceVersion,
		(snapshot) =>
			manifestSkills !== null &&
			manifestSkillConvergence(manifestSkills[0], snapshot, deployment.resource.id) === "converged",
	);
	const updateDeployment = useUpdateDeployment();
	if (manifestSkills === null) {
		return (
			<Alert data-hosted="true" variant="destructive">
				<AlertCircle />
				<AlertTitle>Manifest Skill configuration is unavailable</AlertTitle>
				<AlertDescription>
					Clawdi received an unsupported deployment projection and will not construct an update.
				</AlertDescription>
			</Alert>
		);
	}
	const manifestSkill = manifestSkills[0];
	const convergence = manifestSkillConvergence(
		manifestSkill,
		runtimeObserved.isError ? undefined : runtimeObserved.data,
		deployment.resource.id,
	);
	const reservedSkillIds = new Set(
		manifestSkills.filter((skill) => skill.enabled).map((skill) => skill.id),
	);
	const updateInProgress =
		deployment.resource.status?.summary_state === "updating" || updateDeployment.isPending;

	const applyEnabled = (enabled: boolean) => {
		let update: DeploymentUpdateRequest | null;
		try {
			update = buildManifestSkillUpdate(manifestSkills, enabled);
		} catch {
			toast.error("Manifest Skill configuration is unsupported");
			return;
		}
		if (!update) return;
		updateDeployment.mutate({ id: deployment.resource.id, update });
	};

	const manifestCard = (
		<ManifestSkillCard
			key={manifestSkill.id}
			skill={manifestSkill}
			convergence={projectionAvailable ? convergence : "unavailable"}
			disabled={updateInProgress}
			onEnabledChange={applyEnabled}
		/>
	);

	return (
		<div data-hosted="true" className="space-y-4">
			{projectionAvailable ? (
				<AgentSkillsTab
					agentId={environmentId}
					agentProjectId={agentProjectId}
					routeSearch={routeSearch}
					reservedSkillIds={reservedSkillIds}
					leadingCards={manifestCard}
					projectionFence={deployment.resource.metadata.resourceVersion}
				/>
			) : (
				<>
					<div className={HERO_GRID_CLASS}>{manifestCard}</div>
					<Alert>
						<AlertTitle>Agent-synced Skills are unavailable</AlertTitle>
						<AlertDescription>
							The manifest Skill remains configurable. Filesystem projections and runtime
							convergence will appear when the Agent projection is available.
						</AlertDescription>
					</Alert>
				</>
			)}
		</div>
	);
}

function ManifestSkillCard({
	skill,
	convergence,
	disabled,
	onEnabledChange,
}: {
	skill: ManifestSkillConfiguration;
	convergence: ReturnType<typeof manifestSkillConvergence>;
	disabled: boolean;
	onEnabledChange: (enabled: boolean) => void;
}) {
	const convergenceView =
		convergence === "converged"
			? { label: "Converged", icon: CheckCircle2 }
			: convergence === "pending"
				? { label: "Pending", icon: Clock3 }
				: { label: "Runtime unavailable", icon: AlertCircle };
	const ConvergenceIcon = convergenceView.icon;
	return (
		<HeroCard
			className="min-h-28 gap-2"
			icon={
				<IconChip size="sm" tint="bg-identity-2-bg text-identity-2-fg" className="rounded-lg">
					<Sparkles className="size-4" />
				</IconChip>
			}
			title="Clawdi"
			badges={
				<>
					<Badge variant="outline">v{skill.version}</Badge>
					<Badge variant="secondary">Manifest</Badge>
					<Badge variant="outline" className="gap-1">
						<ConvergenceIcon className="size-3" />
						{convergenceView.label}
					</Badge>
				</>
			}
			description="Bundled Skill managed by the Hosted deployment manifest. Content is immutable here."
			footer={[
				<span key="source">Hosted deployment configuration</span>,
				<span key="state">{skill.enabled ? "Enabled" : "Disabled"}</span>,
			]}
			actions={
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<span>{skill.enabled ? "Enabled" : "Disabled"}</span>
					<Switch
						checked={skill.enabled}
						disabled={disabled}
						onCheckedChange={onEnabledChange}
						aria-label="Enable Clawdi manifest Skill"
					/>
				</div>
			}
		/>
	);
}
