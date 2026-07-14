import type { DeployRequest, HostedConfigRequest } from "@/hosted/billing/contracts";
import { normalizeHostedLanguage } from "@/hosted/billing/deploy/language-timezone-controls";
import type { HostedRuntime } from "@/hosted/runtimes";

type DeployPersona = {
	language: string;
	timezone: string;
};

type ComputePlanSlug = DeployRequest["compute_plan_slug"];
export type DeployAiFields = Pick<DeployRequest, "ai_provider_auth_kind"> & Partial<DeployRequest>;

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
	const language = normalizeHostedLanguage(persona.language);
	const timezone = persona.timezone.trim() || null;
	const { ai_provider_auth_kind, ...restAiFields } = aiFields;
	const personaFields = {
		language,
		timezone,
	};
	const config: HostedConfigRequest = {
		runtime,
		...personaFields,
	};
	return {
		compute_plan_slug: computePlanSlug,
		runtime,
		config,
		...personaFields,
		ai_provider_auth_kind,
		...restAiFields,
	};
}
