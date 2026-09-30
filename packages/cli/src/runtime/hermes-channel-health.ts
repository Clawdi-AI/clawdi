import { recordValue } from "./manifest-shared";

const managedPlatforms = ["telegram", "discord", "whatsapp"] as const;

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

export function hermesChannelsAreReady(required: readonly string[], nativeState: unknown): boolean {
	if (!required.length) return true;
	const state = recordValue(nativeState);
	if (state?.gateway_state !== "running" || typeof state.pid !== "number" || state.pid <= 0)
		return false;
	const platforms = recordValue(state.platforms);
	return required.every((name) => {
		const platform = recordValue(platforms?.[name]);
		if (platform?.state !== "connected") return false;
		// Older Hermes states omit writer identity. When present it must belong to this boot.
		if (platform.writer_pid !== undefined && platform.writer_pid !== state.pid) return false;
		if (platform.writer_start_time !== undefined && platform.writer_start_time !== state.start_time)
			return false;
		return true;
	});
}
