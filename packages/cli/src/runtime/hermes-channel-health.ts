import type { components } from "@clawdi/shared/api";
import { recordValue } from "./manifest-shared";

const managedPlatforms = ["telegram", "discord", "whatsapp"] as const;
type Integration = components["schemas"]["HostedRuntimeObservedIntegrationV1"];

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

export function hermesChannelStates(
	required: readonly string[],
	nativeState: unknown,
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
				hermesGatewayIsReady(state) &&
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
