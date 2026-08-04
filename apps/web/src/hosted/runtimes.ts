import type { AiProviderAuthKind, HostedDeployment } from "@/hosted/billing/contracts";

export const HOSTED_RUNTIMES = ["openclaw", "hermes"] as const;
export type HostedRuntime = (typeof HOSTED_RUNTIMES)[number];

const RUNTIME_META = {
	openclaw: {
		label: "OpenClaw",
		blurb: "Choose this if you already use OpenClaw and want its Control UI and workflows.",
		skillInstall: true,
	},
	hermes: {
		label: "Hermes",
		blurb: "Recommended for most people. Chat with and manage your agent in the Hermes Dashboard.",
		skillInstall: false,
	},
} as const satisfies Record<HostedRuntime, { label: string; blurb: string; skillInstall: boolean }>;

export function isHostedRuntime(value: string): value is HostedRuntime {
	return (HOSTED_RUNTIMES as readonly string[]).includes(value);
}

export function runtimeDisplayName(runtime: HostedRuntime): string {
	return RUNTIME_META[runtime].label;
}

export function runtimeBlurb(runtime: HostedRuntime): string {
	return RUNTIME_META[runtime].blurb;
}

export function runtimeSupportsSkillInstall(runtime: HostedRuntime): boolean {
	return RUNTIME_META[runtime].skillInstall;
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
