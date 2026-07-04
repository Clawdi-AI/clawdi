import type { DeployRequest, OpenClawConfigRequest } from "@/hosted/billing/contracts";

type EngineSelection = {
	openclaw: boolean;
	hermes: boolean;
};

type DeployPersona = {
	language: string;
	timezone: string;
};

type ComputePlanSlug = DeployRequest["compute_plan_slug"];

export function buildHostedDeployRequest({
	computePlanSlug,
	engines,
	persona,
	aiFields,
}: {
	computePlanSlug: ComputePlanSlug;
	engines: EngineSelection;
	persona: DeployPersona;
	aiFields: Partial<DeployRequest>;
}): DeployRequest {
	const personaFields = {
		language: persona.language || null,
		timezone: persona.timezone || null,
	};
	const config: OpenClawConfigRequest = {
		channel: null,
		enable_openclaw: engines.openclaw,
		enable_hermes: engines.hermes,
		...personaFields,
	};
	return {
		compute_plan_slug: computePlanSlug,
		channel: null,
		enable_openclaw: engines.openclaw,
		enable_hermes: engines.hermes,
		config,
		...personaFields,
		...aiFields,
	};
}
