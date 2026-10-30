import type { components } from "@clawdi/shared/api";
import { recordValue } from "./manifest-shared";

const managedPlatforms = ["telegram", "discord", "whatsapp"] as const;
type Integration = components["schemas"]["HostedRuntimeObservedIntegrationV1"];
type RuntimeRestartEntry = components["schemas"]["HostedRuntimeObservedRuntimeRestartEntryV1"];

export function configuredHermesPlatforms(config: unknown): string[] {
	const root = recordValue(config);
	const platforms = recordValue(root?.platforms);
	const gateway = recordValue(root?.gateway);
	const gatewayPlatforms = recordValue(gateway?.platforms);
	return managedPlatforms.filter((name) => {
		let enabled: unknown;
		// Native YAML precedence: nested platform blocks first, top-level adapter block last.
		for (const layer of [
			gatewayPlatforms?.[name],
			platforms?.[name],
			gateway?.[name],
			root?.[name],
		]) {
			const block = recordValue(layer);
			if (block && Object.hasOwn(block, "enabled")) enabled = block.enabled;
		}
		return enabled === true;
	});
}

export function hermesGatewayIsReady(nativeState: unknown): boolean {
	const state = recordValue(nativeState);
	return state?.gateway_state === "running" && typeof state.pid === "number" && state.pid > 0;
}

export function hermesRestartDrain(
	status: unknown,
	nativeState: unknown,
	config: unknown,
	now = Date.now(),
): RuntimeRestartEntry | null {
	const dashboard = recordValue(status);
	const state = recordValue(nativeState);
	if (
		dashboard?.gateway_running !== true ||
		dashboard.gateway_state !== "draining" ||
		state?.gateway_state !== "draining" ||
		state.restart_requested !== true ||
		typeof state.pid !== "number" ||
		!Number.isSafeInteger(state.pid) ||
		state.pid <= 0 ||
		(dashboard.gateway_pid != null && dashboard.gateway_pid !== state.pid) ||
		typeof state.updated_at !== "string"
	)
		return null;
	const age = now - Date.parse(state.updated_at);
	if (!Number.isFinite(age) || age < 0 || age > 90_000) return null;
	// Hermes dce1e9b375: config_defaults.py and gateway/restart.py. Keep zero;
	// missing, blank or invalid configuration uses the upstream 30-minute default.
	const raw = recordValue(recordValue(config)?.agent)?.restart_after_turn_timeout;
	const parsed =
		typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
	const timeout = Number.isFinite(parsed) ? parsed : 1800;
	return {
		runtime: "hermes",
		reason: "upstream_restart_drain",
		activeWork: Array.isArray(state.active_work) ? state.active_work.length : 0,
		budgetSeconds: Math.max(1, Math.min(2400, Math.ceil(timeout + 75))),
	};
}

export function hermesChannelStates(
	required: readonly string[],
	nativeState: unknown,
	admittedRestartDrain = false,
): Integration[] {
	const state = recordValue(nativeState);
	const platforms = recordValue(state?.platforms);
	return managedPlatforms
		.filter((name) => required.includes(name))
		.sort()
		.map((integration) => {
			const platform = recordValue(platforms?.[integration]);
			let channelState: Integration["state"] = "unknown";
			// Older Hermes states omit writer identity. When present it must belong to this boot.
			if (
				(hermesGatewayIsReady(state) || admittedRestartDrain) &&
				platform &&
				(platform.writer_pid === undefined || platform.writer_pid === state?.pid) &&
				(platform.writer_start_time === undefined ||
					platform.writer_start_time === state?.start_time)
			) {
				// Hermes dce1e9b: gateway/platforms/base.py, run_startup.py, run_shutdown.py.
				switch (platform.state) {
					case "connected":
					case "connecting":
					case "retrying":
					case "disconnected":
					case "fatal":
					case "paused":
						channelState = platform.state;
				}
			}
			return { kind: "channel", runtime: "hermes", integration, state: channelState };
		});
}
