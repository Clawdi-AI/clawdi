import type { components, DeployComponents, DeploymentRead } from "../api";
import { statusDotVariants, statusTextVariants } from "../ui";
import { agentDisplayName } from "./agent-label";
import type { AgentCardStatusProjection, AgentTile } from "./agent-tiles";
import { type DaemonStatusVisual, daemonStatusVisual } from "./daemon-status";
import {
	compactDeploymentFailureReason,
	type DeploymentFailurePresentation,
	deploymentFailurePresentation,
	deploymentFailureReason,
} from "./deployment-failure";
import {
	type DeploymentStatus,
	type DeploymentStatusTone,
	deploymentRuntimeStatusPresentation,
	deploymentStatusFromResource,
	isRunningStatus,
} from "./deployment-status";

type Env = components["schemas"]["AgentResponse"];
type HostedDeployment = DeploymentRead;
type DeploymentStatusInput = DeployComponents["schemas"]["HostedDeploymentStatus"] | null;
export function isHostedDeploymentVisible(deployment: HostedDeployment): boolean {
	const status = deploymentStatusFromResource(deployment.resource.status);
	const acceptedOperation = deployment.accepted_operation;
	return (
		status.kind !== "deleting" &&
		status.kind !== "deleted" &&
		!(acceptedOperation?.metadata.verb === "delete" && !acceptedOperation.done) &&
		deployment.compute_slot_occupancy?.reason !== "delete_accepted"
	);
}
export interface HostedRuntimeStatusView {
	compute: DeploymentStatus;
	sync: DaemonStatusVisual | null;
	primary: {
		label: string;
		tone: DeploymentStatusTone;
		textClass: string;
	};
	secondary: {
		kind: DaemonStatusVisual["kind"] | "failure_reason";
		label: string;
		tooltip: string;
		textClass: string;
	} | null;
	active: boolean;
}

export function hostedRuntimeStatusView(
	deployment: DeploymentStatusInput,
	env: Env | null | undefined,
	failurePresentation?: DeploymentFailurePresentation | null,
): HostedRuntimeStatusView {
	const computePresentation = deploymentRuntimeStatusPresentation(deployment);
	const compute = computePresentation.status;
	const failureStatus = compute.kind === "failed" ? failurePresentation?.status : null;
	const computeLabel = failureStatus?.label ?? computePresentation.label;
	const computeTone = failureStatus?.tone ?? computePresentation.tone;
	const sync = env === undefined ? null : daemonStatusVisual(env, "on-clawdi");
	const computeIsRunning = isRunningStatus(compute);
	const failureReason =
		failurePresentation?.reason ??
		(compute.kind === "failed" ? deploymentFailureReason(deployment) : null);
	let secondary: HostedRuntimeStatusView["secondary"] = null;
	if (failureReason && failureStatus?.kind !== "runtime_unavailable") {
		secondary = {
			kind: "failure_reason",
			label: failurePresentation
				? compactDeploymentFailureReason(failurePresentation.title)
				: `Failure: ${compactDeploymentFailureReason(failureReason)}`,
			tooltip: failurePresentation
				? `${failurePresentation.title}. ${failurePresentation.reason}`
				: failureReason,
			textClass: statusTextVariants({ status: "destructive" }),
		};
	} else if (computeIsRunning && sync && sync.kind !== "live") {
		secondary = {
			kind: sync.kind,
			label: sync.badgeLabel,
			tooltip: sync.tooltip,
			textClass: sync.textClass,
		};
	}

	return {
		compute,
		sync,
		primary: {
			label: computeLabel,
			tone: computeTone,
			textClass: statusTextVariants({ status: computeTone }),
		},
		secondary,
		active: computeIsRunning,
	};
}

export function deploymentToTiles(d: HostedDeployment, envById: Map<string, Env>): AgentTile[] {
	if (!isHostedDeploymentVisible(d)) return [];
	const runtime = d.resource.spec.runtime;
	const matchedEnv = envById.get(d.agent_id.toLowerCase());
	const name = agentDisplayName(
		matchedEnv ?? { default_name: d.resource.name, agent_type: runtime },
	);
	const detailHref = `/agents/${encodeURIComponent(d.agent_id)}`;
	const failure = deploymentFailurePresentation(d);
	const runtimeStatus = hostedRuntimeStatusView(d.resource.status, matchedEnv, failure);
	const cardStatus: AgentCardStatusProjection = {
		visual: {
			label: runtimeStatus.primary.label,
			tooltip: `Agent status: ${runtimeStatus.primary.label}.`,
			dotClass: statusDotVariants({ status: runtimeStatus.primary.tone }),
		},
		labels: [
			runtimeStatus.primary.label,
			...(runtimeStatus.secondary ? [runtimeStatus.secondary.label] : []),
		],
	};
	return [
		{
			id: d.agent_id,
			source: "on-clawdi" as const,
			name,
			avatarUrl: matchedEnv?.avatar_url ?? null,
			sortOrder: matchedEnv?.sort_order ?? null,
			agentType: runtime,
			href: detailHref,
			external: false,
			cardStatus,
			filesAvailable: deploymentFilesUrl(d) !== null,
			env: matchedEnv ?? null,
		},
	];
}

export function deploymentFilesUrl(deployment: HostedDeployment): string | null {
	const value = deployment.files_endpoint?.url;
	if (!value) return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		) {
			return null;
		}
		return url.toString();
	} catch {
		return null;
	}
}

export function isHostedDeploymentMember(deployment: HostedDeployment): boolean {
	return (
		deploymentStatusFromResource(deployment.resource.status).kind !== "deleted" ||
		deployment.clawdi_cloud_environments?.[deployment.resource.spec.runtime] !== undefined
	);
}

/** Pending or authoritatively accepted deletion dismisses the agent during cleanup. */

export function hostedDeploymentMembers(
	deployments: readonly HostedDeployment[],
): HostedDeployment[] {
	return deployments.filter(isHostedDeploymentMember);
}

/** One claimed-id set shared by list deduplication and ownership chrome. */
export function claimedEnvIdsFromDeployments(
	deployments: readonly HostedDeployment[],
): Set<string> {
	const environmentIds = new Set<string>();
	for (const deployment of deployments) {
		if (!isHostedDeploymentMember(deployment)) continue;
		environmentIds.add(deployment.agent_id.toLowerCase());
	}
	return environmentIds;
}
