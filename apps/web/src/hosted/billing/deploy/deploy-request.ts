import type { DeployRequest, OpenClawConfigRequest } from "@/hosted/billing/contracts";

type EngineSelection = {
	openclaw: boolean;
	hermes: boolean;
};

type DeployPersona = {
	assistantName: string;
	personality: string;
	language: string;
	timezone: string;
};

export function buildHostedDeployRequest({
	engines,
	persona,
	aiFields,
}: {
	engines: EngineSelection;
	persona: DeployPersona;
	aiFields: Partial<DeployRequest>;
}): DeployRequest {
	const personaFields = {
		assistant_name: persona.assistantName.trim() || null,
		personality: persona.personality || null,
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
		channel: null,
		enable_openclaw: engines.openclaw,
		enable_hermes: engines.hermes,
		config,
		...personaFields,
		...aiFields,
	};
}
