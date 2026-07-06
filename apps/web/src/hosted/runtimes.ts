import type { DeploymentDetailsInfo, HostedDeployment } from "@/hosted/billing/contracts";

export const HOSTED_RUNTIMES = ["openclaw", "hermes"] as const;
export type HostedRuntime = (typeof HOSTED_RUNTIMES)[number];

const RUNTIME_ORDER = new Map<HostedRuntime, number>(
	HOSTED_RUNTIMES.map((runtime, index) => [runtime, index]),
);

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

export function sortHostedRuntimes(values: Iterable<string>): HostedRuntime[] {
	const runtimes = new Set<HostedRuntime>();
	for (const value of values) {
		if (isHostedRuntime(value)) runtimes.add(value);
	}
	return [...runtimes].sort(
		(left, right) => (RUNTIME_ORDER.get(left) ?? 0) - (RUNTIME_ORDER.get(right) ?? 0),
	);
}

export function configRuntime(configInfo: DeploymentDetailsInfo | null | undefined): HostedRuntime {
	const runtime = configInfo?.runtime;
	return runtime && isHostedRuntime(runtime) ? runtime : "openclaw";
}

export function deploymentRuntime(deployment: HostedDeployment): HostedRuntime {
	return configRuntime(deployment.config_info);
}

export function runtimeEnvironmentId(
	configInfo: DeploymentDetailsInfo | null | undefined,
	runtime: HostedRuntime = configRuntime(configInfo),
): string | undefined {
	return configInfo?.clawdi_cloud_environments?.[runtime];
}

export function runtimeConsoleUrl(
	deployment: HostedDeployment,
	runtime: HostedRuntime = deploymentRuntime(deployment),
): string | null | undefined {
	if (runtime === "openclaw") return deployment.openclaw_control_ui_url;
	return deployment.hermes_control_ui_url;
}

export function deploymentRuntimes(deployment: HostedDeployment): HostedRuntime[] {
	return [deploymentRuntime(deployment)];
}

export function defaultDeploymentRuntime(deployment: HostedDeployment): HostedRuntime {
	return deploymentRuntime(deployment);
}
