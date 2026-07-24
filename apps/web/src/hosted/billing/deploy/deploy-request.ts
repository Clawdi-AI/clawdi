import type {
	ComputePlanSlug,
	DeployRequest,
	HostedConfigRequest,
} from "@/hosted/billing/contracts";
import { normalizeHostedLanguage } from "@/hosted/billing/deploy/language-timezone-controls";
import type { HostedRuntime } from "@/hosted/runtimes";

type DeployPersona = {
	assistantName: string;
	language: string;
	timezone: string;
};

export const DEPLOY_ASSISTANT_NAME_MAX_LENGTH = 255;

export type DeployAiFields = Pick<DeployRequest, "ai_provider_auth_kind"> &
	Partial<
		Pick<
			DeployRequest,
			"ai_provider_bootstrap" | "ai_provider_id" | "primary_model" | "provider_ids"
		>
	>;

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
	const assistantName = persona.assistantName.trim();
	const language = normalizeHostedLanguage(persona.language);
	const timezone = persona.timezone.trim() || null;
	const { ai_provider_auth_kind, ...restAiFields } = aiFields;
	const personaFields = {
		assistant_name: assistantName,
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
