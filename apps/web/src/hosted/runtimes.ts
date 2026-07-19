import { v5 as uuidv5 } from "uuid";
import type { HostedDeployment } from "@/hosted/billing/contracts";

export const HOSTED_RUNTIMES = ["openclaw", "hermes"] as const;
export type HostedRuntime = (typeof HOSTED_RUNTIMES)[number];
export const DEFAULT_HOSTED_RUNTIME: HostedRuntime = "openclaw";

const CLOUD_AGENT_ID_NAMESPACE = "e016a4c8-7943-4ae9-9c53-5f1a5db9f3e1";

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

export function deploymentRuntime(deployment: HostedDeployment): HostedRuntime {
	return deployment.resource.spec.runtime;
}

export function runtimeEnvironmentId(
	deployment: HostedDeployment,
	runtime: HostedRuntime = deploymentRuntime(deployment),
): string {
	return uuidv5(`${deployment.resource.id}:${runtime}`, CLOUD_AGENT_ID_NAMESPACE);
}

export function runtimeConsoleUrl(
	deployment: HostedDeployment,
	runtime: HostedRuntime = deploymentRuntime(deployment),
): string | null {
	const endpoints = deployment.resource.status.endpoints;
	return endpoints.find((endpoint) => endpoint.name === runtime)?.url ?? endpoints[0]?.url ?? null;
}

export function defaultDeploymentRuntime(deployment: HostedDeployment): HostedRuntime {
	return deploymentRuntime(deployment);
}
