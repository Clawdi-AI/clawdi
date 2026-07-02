import type { DeploymentDetailsInfo, HostedDeployment } from "@/hosted/billing/contracts";

export const HOSTED_RUNTIMES = ["codex", "openclaw", "hermes"] as const;
export type HostedRuntime = (typeof HOSTED_RUNTIMES)[number];

export const OPTIONAL_HOSTED_RUNTIMES = [
	"openclaw",
	"hermes",
] as const satisfies readonly HostedRuntime[];
export const ALWAYS_ON_HOSTED_RUNTIME = "codex" as const satisfies HostedRuntime;

type RawRuntimeTarget = NonNullable<DeploymentDetailsInfo["runtime_targets"]>[string];

export interface HostedRuntimeTarget {
	id: string;
	type: HostedRuntime;
	displayName: string;
	enabled: boolean;
	environmentId: string | null;
	controlUiUrl: string | null;
	image: RawRuntimeTarget["image"];
	version: RawRuntimeTarget["version"];
}

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

export function runtimeTargetDisplayName(target: HostedRuntimeTarget): string {
	return target.displayName || runtimeDisplayName(target.type);
}

export function runtimeBlurb(runtime: HostedRuntime): string {
	return RUNTIME_META[runtime].blurb;
}

export function runtimeCanDisable(runtime: HostedRuntime): boolean {
	return RUNTIME_META[runtime].canDisable;
}

export function deploymentRuntimeTargets(deployment: HostedDeployment): HostedRuntimeTarget[] {
	const targets = deployment.config_info?.runtime_targets ?? {};
	return Object.entries(targets)
		.map(([id, raw]) => normalizeRuntimeTarget(id, raw))
		.filter((target): target is HostedRuntimeTarget => target !== null)
		.sort(
			(left, right) =>
				(RUNTIME_ORDER.get(left.type) ?? 99) - (RUNTIME_ORDER.get(right.type) ?? 99) ||
				left.id.localeCompare(right.id),
		);
}

export function enabledDeploymentRuntimeTargets(
	deployment: HostedDeployment,
): HostedRuntimeTarget[] {
	return deploymentRuntimeTargets(deployment).filter((target) => target.enabled);
}

export function defaultDeploymentRuntimeTarget(
	deployment: HostedDeployment,
): HostedRuntimeTarget | null {
	return enabledDeploymentRuntimeTargets(deployment)[0] ?? null;
}

export function runtimeConsoleUrl(target: HostedRuntimeTarget): string | null {
	return target.type === "codex" ? null : target.controlUiUrl;
}

function normalizeRuntimeTarget(id: string, raw: RawRuntimeTarget): HostedRuntimeTarget | null {
	if (!id || raw.id !== id || !isHostedRuntime(raw.type)) return null;
	return {
		id,
		type: raw.type,
		displayName: raw.display_name?.trim() || runtimeDisplayName(raw.type),
		enabled: raw.enabled === true,
		environmentId: raw.environment_id ?? null,
		controlUiUrl: raw.control_ui_url ?? null,
		image: raw.image ?? null,
		version: raw.version ?? null,
	};
}
