import type { DeployAiFields } from "@/hosted/billing/deploy/deploy-request";
import { type HostedRuntime, runtimeDisplayName } from "@/hosted/runtimes";
import {
	MANAGED_AI_CHOICE,
	MANAGED_DEFAULT_MODEL_CHOICE,
	MANAGED_PROVIDER_ID,
} from "@/hosted/v2/ai-providers/model-binding";

export type DeployWizardAiAccessMode = "unmanaged" | "configured";

// Deploy-form pre-selection. Independent from the config-interpretation
// fallback in runtimes.ts (which stays openclaw for existing deployment records).
export const DEFAULT_DEPLOY_RUNTIME: HostedRuntime = "hermes";
export const DEFAULT_DEPLOY_AI_ACCESS_MODE: DeployWizardAiAccessMode = "configured";
export const DEFAULT_DEPLOY_AI_PROVIDER_CHOICES = [MANAGED_AI_CHOICE] as const;
export const DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE = MANAGED_AI_CHOICE;
export const DEFAULT_DEPLOY_PRIMARY_MODEL = MANAGED_DEFAULT_MODEL_CHOICE;

export function deployAssistantNameAfterRuntimeChange({
	currentName,
	hasBeenEdited,
	runtime,
}: {
	currentName: string;
	hasBeenEdited: boolean;
	runtime: HostedRuntime;
}): string {
	return hasBeenEdited ? currentName : runtimeDisplayName(runtime);
}

export function defaultManagedDeployAiFields(): DeployAiFields {
	return {
		ai_provider_id: null,
		ai_provider_auth_kind: "managed",
		provider_ids: [MANAGED_PROVIDER_ID],
	};
}
