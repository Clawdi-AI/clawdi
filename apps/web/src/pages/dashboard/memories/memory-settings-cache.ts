export interface MemorySettingsCacheSnapshot {
	memory_provider: string;
	mem0_api_key_configured: boolean;
}

/** Project settings into the only non-secret fields this page caches. */
export function memorySettingsForCache(
	settings: Record<string, unknown>,
): MemorySettingsCacheSnapshot {
	const mem0ApiKey = settings.mem0_api_key;
	return {
		memory_provider:
			typeof settings.memory_provider === "string" ? settings.memory_provider : "builtin",
		mem0_api_key_configured: typeof mem0ApiKey === "string" && mem0ApiKey.length > 0,
	};
}
