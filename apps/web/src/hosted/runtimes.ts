import type { AiProviderAuthKind, HostedDeployment } from "@/hosted/billing/contracts";

export const HOSTED_RUNTIMES = ["openclaw", "hermes"] as const;
export type HostedRuntime = (typeof HOSTED_RUNTIMES)[number];
export const DEFAULT_HOSTED_RUNTIME: HostedRuntime = "openclaw";

const RUNTIME_META = {
	openclaw: {
		label: "OpenClaw",
		blurb: "Your own personal AI assistant.",
	},
	hermes: {
		label: "Hermes",
		blurb: "The agent that grows with you.",
	},
} as const satisfies Record<HostedRuntime, { label: string; blurb: string }>;

export function isHostedRuntime(value: string): value is HostedRuntime {
	return (HOSTED_RUNTIMES as readonly string[]).includes(value);
}

export function runtimeDisplayName(runtime: HostedRuntime): string {
	return RUNTIME_META[runtime].label;
}

export function runtimeBlurb(runtime: HostedRuntime): string {
	return RUNTIME_META[runtime].blurb;
}

export function deploymentRuntime(deployment: HostedDeployment): HostedRuntime {
	return deployment.resource.spec.runtime;
}

export function runtimeEnvironmentId(
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

export function runtimeAiProviderAuthKind(
	deployment: HostedDeployment,
	runtime: HostedRuntime = deploymentRuntime(deployment),
): AiProviderAuthKind | undefined {
	return deployment.ai_provider_auth_kinds[runtime];
}

export function defaultDeploymentRuntime(deployment: HostedDeployment): HostedRuntime {
	return deploymentRuntime(deployment);
}
