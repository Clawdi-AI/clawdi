import type { HostedRuntime } from "@/hosted/runtimes";
import { MANAGED_AI_CHOICE } from "@/hosted/v2/ai-providers/model-binding";

export type DeployWizardAiAccessMode = "unmanaged" | "configured";

// Product pre-selection for new deployments.
export const DEFAULT_DEPLOY_RUNTIME: HostedRuntime = "hermes";
export const DEFAULT_DEPLOY_AI_ACCESS_MODE: DeployWizardAiAccessMode = "configured";
export const DEFAULT_DEPLOY_AI_PROVIDER_CHOICES = [MANAGED_AI_CHOICE] as const;
export const DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE = MANAGED_AI_CHOICE;
// The managed catalog supplies the real default model after it loads.
export const DEFAULT_DEPLOY_PRIMARY_MODEL = "";
export const DEFAULT_DEPLOY_ASSISTANT_NAME = "My agent";
