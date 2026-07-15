import type {
	ComputePlanSlug,
	DeployRequest,
	HostedConfigRequest,
} from "@/hosted/billing/contracts";
import { normalizeHostedLanguage } from "@/hosted/billing/deploy/language-timezone-controls";
import type { HostedRuntime } from "@/hosted/runtimes";

type DeployPersona = {
	language: string;
	timezone: string;
};

export type DeployAiFields = Pick<DeployRequest, "ai_provider_auth_kind"> &
	Partial<
		Pick<
			DeployRequest,
			"ai_provider_bootstrap" | "ai_provider_id" | "primary_model" | "provider_ids"
		>
	>;

export function buildHostedDeployRequest<TPlanSlug extends ComputePlanSlug>({
	computePlanSlug,
	runtime,
	persona,
	aiFields,
}: {
	computePlanSlug: TPlanSlug;
	runtime: HostedRuntime;
	persona: DeployPersona;
	aiFields: DeployAiFields;
}): DeployRequest<TPlanSlug> {
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
