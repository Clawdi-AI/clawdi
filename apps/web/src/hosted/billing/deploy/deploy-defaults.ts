import {
	DEFAULT_HOSTED_DEPLOY_AI_ACCESS_MODE,
	DEFAULT_HOSTED_DEPLOY_PRIMARY_MODEL,
	DEFAULT_HOSTED_DEPLOY_RUNTIME,
	hostedDeployAssistantNameAfterRuntimeChange,
} from "@clawdi/shared/api";
import type { HostedRuntime } from "@/hosted/runtimes";
import { MANAGED_AI_CHOICE } from "@/hosted/v2/ai-providers/model-binding";

export type DeployWizardAiAccessMode = "unmanaged" | "configured";

// Product pre-selection for new deployments.
export const DEFAULT_DEPLOY_RUNTIME: HostedRuntime = DEFAULT_HOSTED_DEPLOY_RUNTIME;
export const DEFAULT_DEPLOY_AI_ACCESS_MODE: DeployWizardAiAccessMode =
	DEFAULT_HOSTED_DEPLOY_AI_ACCESS_MODE;
export const DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE = MANAGED_AI_CHOICE;
// The managed catalog supplies the real default model after it loads.
export const DEFAULT_DEPLOY_PRIMARY_MODEL = DEFAULT_HOSTED_DEPLOY_PRIMARY_MODEL;

export function deployAssistantNameAfterRuntimeChange({
	currentName,
	hasBeenEdited,
	runtime,
}: {
	currentName: string;
	hasBeenEdited: boolean;
	runtime: HostedRuntime;
}): string {
	return hostedDeployAssistantNameAfterRuntimeChange({ currentName, hasBeenEdited, runtime });
}
