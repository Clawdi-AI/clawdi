import { isRuntimeUiEndpointInfo, type RuntimeUiAuthMode } from "@clawdi/shared/api";
import type { DeploymentDetailsInfo, HostedDeployment } from "@/hosted/billing/contracts";

export const HOSTED_RUNTIMES = ["openclaw", "hermes"] as const;
export type HostedRuntime = (typeof HOSTED_RUNTIMES)[number];
export const DEFAULT_HOSTED_RUNTIME: HostedRuntime = "openclaw";

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

export interface RuntimeUiEndpoint {
	runtime: HostedRuntime;
	url: string;
	authMode: RuntimeUiAuthMode;
	browserMode: "top_level";
}

export function runtimeUiEndpoint(value: HostedDeployment): RuntimeUiEndpoint | null {
	const raw = value.runtime_ui_endpoint;
	if (!isRuntimeUiEndpointInfo(raw) || raw.runtime !== deploymentRuntime(value)) return null;
	const { runtime, url, auth_mode: authMode, browser_mode: browserMode } = raw;
	return { runtime, url, authMode, browserMode };
}

export function runtimeUiAuthFlow(deployment: HostedDeployment): RuntimeUiAuthMode | null {
	return runtimeUiEndpoint(deployment)?.authMode ?? null;
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
	return runtime && isHostedRuntime(runtime) ? runtime : DEFAULT_HOSTED_RUNTIME;
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
): string | null {
	const endpoint = runtimeUiEndpoint(deployment);
	if (endpoint?.runtime === runtime) return endpoint.url;
	return null;
}

export function deploymentRuntimes(deployment: HostedDeployment): HostedRuntime[] {
	return [deploymentRuntime(deployment)];
}

export function defaultDeploymentRuntime(deployment: HostedDeployment): HostedRuntime {
	return deploymentRuntime(deployment);
}
