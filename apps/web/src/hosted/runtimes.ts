export { deploymentFilesUrl } from "@clawdi/shared/view";

import type { AiProviderAuthKind, HostedDeployment } from "@/hosted/billing/contracts";

export {
	HOSTED_RUNTIMES,
	isHostedRuntime,
	runtimeBlurb,
	runtimeDisplayName,
} from "@clawdi/shared/view";

import type { HostedRuntime } from "@clawdi/shared/view";

export type { HostedRuntime } from "@clawdi/shared/view";

export function deploymentRuntime(deployment: HostedDeployment): HostedRuntime {
	return deployment.resource.spec.runtime;
}

export function observedCloudProjectionId(
	deployment: HostedDeployment,
	runtime: HostedRuntime = deploymentRuntime(deployment),
): string | undefined {
	return deployment.clawdi_cloud_environments?.[runtime];
}

export function runtimeConsoleUrl(
	deployment: HostedDeployment,
	runtime: HostedRuntime = deploymentRuntime(deployment),
): string | null {
	const endpoint = deployment.runtime_ui_endpoint;
	return endpoint?.runtime === runtime && endpoint.role === "control_ui" ? endpoint.url : null;
}

export { hermesOidcLoginUrl, runtimeDashboardUrl } from "@clawdi/shared/api";

export function runtimeAiProviderAuthKind(
	deployment: HostedDeployment,
	runtime: HostedRuntime = deploymentRuntime(deployment),
): AiProviderAuthKind | undefined {
	return deployment.ai_provider_auth_kinds[runtime];
}

export function defaultDeploymentRuntime(deployment: HostedDeployment): HostedRuntime {
	return deploymentRuntime(deployment);
}
