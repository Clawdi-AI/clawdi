const AGENT_AVATAR_PRESET_META = [
	{ id: "aurora", label: "Aurora" },
	{ id: "ember", label: "Ember" },
	{ id: "forest", label: "Forest" },
	{ id: "glacier", label: "Glacier" },
	{ id: "mono", label: "Mono" },
	{ id: "sunrise", label: "Sunrise" },
] as const;

export type AgentAvatarPresetId = (typeof AGENT_AVATAR_PRESET_META)[number]["id"];

const PRESET_META_BY_ID = new Map(AGENT_AVATAR_PRESET_META.map((preset) => [preset.id, preset]));

function normalizePresetBaseUrl(value: string | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

const presetBaseUrl = normalizePresetBaseUrl(process.env.NEXT_PUBLIC_AGENT_AVATAR_PRESET_BASE_URL);

export const AGENT_AVATAR_PRESETS = presetBaseUrl
	? AGENT_AVATAR_PRESET_META.map((preset) => ({
			...preset,
			src: `${presetBaseUrl}/${preset.id}.webp`,
		}))
	: [];

const PRESET_BY_ID = new Map(AGENT_AVATAR_PRESETS.map((preset) => [preset.id, preset]));

export function isAgentAvatarPresetId(
	value: string | null | undefined,
): value is AgentAvatarPresetId {
	return Boolean(value && PRESET_META_BY_ID.has(value as AgentAvatarPresetId));
}

export function agentAvatarPresetSrc(value: string | null | undefined): string | null {
	if (!isAgentAvatarPresetId(value)) return null;
	return PRESET_BY_ID.get(value)?.src ?? null;
}
