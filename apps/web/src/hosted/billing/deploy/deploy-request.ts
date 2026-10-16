import {
	buildHostedDeployRequest as buildSharedHostedDeployRequest,
	HOSTED_DEPLOY_AGENT_NAME_MAX_LENGTH,
	type HostedDeployAiFields,
	type HostedDeployPluginBundle,
} from "@clawdi/shared/api";
import type { ComputePlanSlug, DeployRequest } from "@/hosted/billing/contracts";
import type { HostedRuntime } from "@/hosted/runtimes";

type DeployPersona = {
	agentName: string;
	language: string;
	timezone: string;
};

export const DEPLOY_AGENT_NAME_MAX_LENGTH = HOSTED_DEPLOY_AGENT_NAME_MAX_LENGTH;

export type DeployAiFields = HostedDeployAiFields;

export function buildHostedDeployRequest({
	computePlanSlug,
	runtime,
	persona,
	aiFields,
	pluginBundle,
}: {
	computePlanSlug: ComputePlanSlug;
	runtime: HostedRuntime;
	persona: DeployPersona;
	aiFields: DeployAiFields;
	pluginBundle?: HostedDeployPluginBundle | null;
}): DeployRequest {
	return buildSharedHostedDeployRequest({
		computePlanSlug,
		runtime,
		persona,
		aiFields,
		pluginBundle,
	});
}
