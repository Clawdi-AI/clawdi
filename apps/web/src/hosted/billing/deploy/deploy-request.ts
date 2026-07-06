import type { DeployRequest, HostedConfigRequest } from "@/hosted/billing/contracts";
import type { HostedRuntime } from "@/hosted/runtimes";

type DeployPersona = {
	language: string;
	timezone: string;
};

type ComputePlanSlug = DeployRequest["compute_plan_slug"];

export function buildHostedDeployRequest({
	computePlanSlug,
	runtime,
	persona,
	aiFields,
}: {
	computePlanSlug: ComputePlanSlug;
	runtime: HostedRuntime;
	persona: DeployPersona;
	aiFields: Partial<DeployRequest>;
}): DeployRequest {
	const personaFields = {
		language: persona.language || null,
		timezone: persona.timezone || null,
	};
	const config: HostedConfigRequest = {
		channel: null,
		runtime,
		...personaFields,
	};
	return {
		compute_plan_slug: computePlanSlug,
		channel: null,
		runtime,
		config,
		...personaFields,
		...aiFields,
	};
}
