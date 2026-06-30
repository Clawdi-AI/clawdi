import type { DeploymentDetailsInfo, HostedDeployment } from "@/hosted/billing/contracts";

export const HOSTED_RUNTIMES = ["codex", "openclaw", "hermes"] as const;
export type HostedRuntime = (typeof HOSTED_RUNTIMES)[number];

export const OPTIONAL_HOSTED_RUNTIMES = [
	"openclaw",
	"hermes",
] as const satisfies readonly HostedRuntime[];
export const ALWAYS_ON_HOSTED_RUNTIME = "codex" as const satisfies HostedRuntime;

const RUNTIME_ORDER = new Map<HostedRuntime, number>(
	HOSTED_RUNTIMES.map((runtime, index) => [runtime, index]),
);

const RUNTIME_META = {
	codex: {
		label: "Codex",
		blurb: "Default hosted coding runtime.",
		canDisable: false,
	},
	openclaw: {
		label: "OpenClaw",
		blurb: "General-purpose agent runtime.",
		canDisable: true,
	},
	hermes: {
		label: "Hermes",
		blurb: "Messaging-first agent runtime.",
		canDisable: true,
	},
} as const satisfies Record<HostedRuntime, { label: string; blurb: string; canDisable: boolean }>;

export function isHostedRuntime(value: string): value is HostedRuntime {
	return (HOSTED_RUNTIMES as readonly string[]).includes(value);
}

export function runtimeDisplayName(runtime: HostedRuntime): string {
	return RUNTIME_META[runtime].label;
}

export function runtimeBlurb(runtime: HostedRuntime): string {
	return RUNTIME_META[runtime].blurb;
}

export function runtimeCanDisable(runtime: HostedRuntime): boolean {
	return RUNTIME_META[runtime].canDisable;
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
	if (runtime === ALWAYS_ON_HOSTED_RUNTIME) return true;
	if (runtime === "openclaw") return configInfo?.enable_openclaw !== false;
	return configInfo?.enable_hermes === true;
}

export function runtimeIsConfigured(
	configInfo: DeploymentDetailsInfo | null | undefined,
	runtime: HostedRuntime,
): boolean {
	if (runtime === ALWAYS_ON_HOSTED_RUNTIME) return true;
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
	if (runtime === "codex") return null;
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
		return sortHostedRuntimes([ALWAYS_ON_HOSTED_RUNTIME, ...explicit]);
	}

	const fallback = new Set<HostedRuntime>([ALWAYS_ON_HOSTED_RUNTIME]);
	for (const runtime of sortHostedRuntimes(
		Object.keys(configInfo?.clawdi_cloud_environments ?? {}),
	)) {
		fallback.add(runtime);
	}
	if (runtimeIsEnabled(configInfo, "openclaw")) fallback.add("openclaw");
	if (runtimeIsEnabled(configInfo, "hermes")) fallback.add("hermes");
	return sortHostedRuntimes(fallback);
}

export function defaultDeploymentRuntime(deployment: HostedDeployment): HostedRuntime {
	return deploymentRuntimes(deployment)[0] ?? ALWAYS_ON_HOSTED_RUNTIME;
}
