import { type HostedRuntime, runtimeDisplayName } from "@/hosted/runtimes";
import { MANAGED_AI_CHOICE } from "@/hosted/v2/ai-providers/model-binding";

export type DeployWizardAiAccessMode = "unmanaged" | "configured";

// Deploy-form pre-selection. Independent from the config-interpretation
// fallback in runtimes.ts (which stays openclaw for existing deployment records).
export const DEFAULT_DEPLOY_RUNTIME: HostedRuntime = "hermes";
export const DEFAULT_DEPLOY_AI_ACCESS_MODE: DeployWizardAiAccessMode = "configured";
export const DEFAULT_DEPLOY_AI_PROVIDER_CHOICES = [MANAGED_AI_CHOICE] as const;
export const DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE = MANAGED_AI_CHOICE;
// The managed catalog supplies the real default model after it loads.
export const DEFAULT_DEPLOY_PRIMARY_MODEL = "";

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
