import type { DeploymentDetailsInfo, HostedDeployment } from "@/hosted/billing/contracts";

export const HOSTED_RUNTIMES = ["openclaw", "hermes"] as const;
export type HostedRuntime = (typeof HOSTED_RUNTIMES)[number];

export const OPTIONAL_HOSTED_RUNTIMES = HOSTED_RUNTIMES;

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

export function runtimeIsEnabled(
	configInfo: DeploymentDetailsInfo | null | undefined,
	runtime: HostedRuntime,
): boolean {
	if (runtime === "openclaw") return configInfo?.enable_openclaw === true;
	return configInfo?.enable_hermes === true;
}

export function runtimeIsConfigured(
	configInfo: DeploymentDetailsInfo | null | undefined,
	runtime: HostedRuntime,
): boolean {
	return new Set(configInfo?.configured_agents ?? []).has(runtime);
}

export function runtimeEnvironmentId(
	configInfo: DeploymentDetailsInfo | null | undefined,
	runtime: HostedRuntime,
): string | undefined {
	return configInfo?.clawdi_cloud_environments?.[runtime];
}

export function runtimeConsoleUrl(
	deployment: HostedDeployment,
	runtime: HostedRuntime,
): string | null | undefined {
	if (runtime === "openclaw") return deployment.openclaw_control_ui_url;
	return deployment.hermes_control_ui_url;
}

export function deploymentRuntimes(deployment: HostedDeployment): HostedRuntime[] {
	const configInfo = deployment.config_info;
	const explicit = sortHostedRuntimes([
		...Object.keys(configInfo?.clawdi_cloud_environments ?? {}),
		...(configInfo?.onboarded_agents ?? []),
	]);
	if (explicit.length > 0) {
		return explicit.filter((runtime) => runtimeIsEnabled(configInfo, runtime));
	}

	const fallback = new Set<HostedRuntime>();
	if (runtimeIsEnabled(configInfo, "openclaw")) fallback.add("openclaw");
	if (runtimeIsEnabled(configInfo, "hermes")) fallback.add("hermes");
	return sortHostedRuntimes(fallback);
}

export function defaultDeploymentRuntime(deployment: HostedDeployment): HostedRuntime {
	return deploymentRuntimes(deployment)[0] ?? HOSTED_RUNTIMES[0];
}
