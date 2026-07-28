import {
	buildHostedDeployRequest as buildSharedHostedDeployRequest,
	HOSTED_DEPLOY_ASSISTANT_NAME_MAX_LENGTH,
	type HostedDeployAiFields,
} from "@clawdi/shared/api";
import type { ComputePlanSlug, DeployRequest } from "@/hosted/billing/contracts";
import type { HostedRuntime } from "@/hosted/runtimes";

type DeployPersona = {
	assistantName: string;
	language: string;
	timezone: string;
};

export const DEPLOY_ASSISTANT_NAME_MAX_LENGTH = HOSTED_DEPLOY_ASSISTANT_NAME_MAX_LENGTH;

export type DeployAiFields = HostedDeployAiFields;

export function buildHostedDeployRequest({
	computePlanSlug,
	runtime,
	persona,
	aiFields,
}: {
	computePlanSlug: ComputePlanSlug;
	runtime: HostedRuntime;
	persona: DeployPersona;
	aiFields: DeployAiFields;
}): DeployRequest {
	return buildSharedHostedDeployRequest({ computePlanSlug, runtime, persona, aiFields });
}
