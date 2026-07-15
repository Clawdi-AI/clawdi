import type { DeployAiFields } from "@/hosted/billing/deploy/deploy-request";
import type { HostedRuntime } from "@/hosted/runtimes";
import {
	MANAGED_AI_CHOICE,
	MANAGED_PRIMARY_MODEL_FALLBACK,
	MANAGED_PROVIDER_ID,
	type PrimaryModelRef,
} from "@/hosted/v2/ai-providers/model-binding";

export type DeployWizardAiAccessMode = "unmanaged" | "configured";

// Deploy-form pre-selection. Independent from the config-interpretation
// fallback in runtimes.ts (which stays openclaw for existing deployment records).
export const DEFAULT_DEPLOY_RUNTIME: HostedRuntime = "hermes";
export const DEFAULT_DEPLOY_AI_ACCESS_MODE: DeployWizardAiAccessMode = "configured";
export const DEFAULT_DEPLOY_AI_PROVIDER_CHOICES = [MANAGED_AI_CHOICE] as const;
export const DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE = MANAGED_AI_CHOICE;
export const DEFAULT_DEPLOY_PRIMARY_MODEL = MANAGED_PRIMARY_MODEL_FALLBACK;

export function defaultManagedPrimaryModel(): PrimaryModelRef {
	return {
		provider_id: MANAGED_PROVIDER_ID,
		model: DEFAULT_DEPLOY_PRIMARY_MODEL,
	};
}

export function defaultManagedDeployAiFields(): DeployAiFields {
	return {
		ai_provider_id: null,
		ai_provider_auth_kind: "managed",
		provider_ids: [MANAGED_PROVIDER_ID],
		primary_model: defaultManagedPrimaryModel(),
	};
}
