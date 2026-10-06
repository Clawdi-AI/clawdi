import {
	PROVIDER_PRESETS,
	PROVIDER_TYPE_META,
	type ProviderPreset,
	type ProviderTypeId,
} from "../api";
export type ProviderChoice =
	| { kind: "type"; type: ProviderTypeId }
	| { kind: "preset"; preset: ProviderPreset; regionId?: string }
	| { kind: "oauth" };

interface ChoiceEntry {
	id: string;
	label: string;
	choice: ProviderChoice;
}
export interface ProviderGroup {
	id: string;
	label: string;
	iconId: string;
	entries: ChoiceEntry[];
}

function typeGroup(type: ProviderTypeId): ProviderGroup {
	const label =
		type === "custom_openai_compatible" ? "Custom endpoint" : PROVIDER_TYPE_META[type].label;
	return {
		id: type,
		label,
		iconId: type,
		entries: [{ id: type, label, choice: { kind: "type", type } }],
	};
}

export const PROVIDER_GROUPS: ProviderGroup[] = [
	{
		id: "openai",
		label: "OpenAI",
		iconId: "openai",
		entries: [
			{ id: "openai-api", label: "OpenAI API", choice: { kind: "type", type: "openai" } },
			{ id: "chatgpt-codex", label: "ChatGPT (Codex)", choice: { kind: "oauth" } },
		],
	},
	typeGroup("anthropic"),
	typeGroup("gemini"),
];
for (const preset of PROVIDER_PRESETS) {
	const isKimi = preset.id === "moonshot" || preset.id === "kimi-coding";
	const id = isKimi ? "kimi" : preset.id;
	let group = PROVIDER_GROUPS.find((item) => item.id === id);
	if (!group) {
		group = { id, label: isKimi ? "Kimi" : preset.label, iconId: preset.id, entries: [] };
		PROVIDER_GROUPS.push(group);
	}
	const regions = preset.region_variants ?? [];
	group.entries.push(
		...(regions.length
			? regions.map((region) => ({
					id: `${preset.id}:${region.id}`,
					label: isKimi ? `API · ${region.label}` : region.label,
					choice: { kind: "preset" as const, preset, regionId: region.id },
				}))
			: [
					{
						id: preset.id,
						label: isKimi ? "Kimi Code" : preset.label,
						choice: { kind: "preset" as const, preset },
					},
				]),
	);
}
PROVIDER_GROUPS.push(typeGroup("custom_openai_compatible"));

export const providerChooserCopy = {
	searchLabel: "Search providers",
	searchPlaceholder: "Search providers…",
	noResults: "No providers found",
	customEndpoint: "Use a custom endpoint",
} as const;

export function filterProviderGroups(query: string): ProviderGroup[] {
	const normalized = query.trim().toLowerCase();
	return PROVIDER_GROUPS.filter((group) =>
		[group.id, group.label, ...group.entries.map((entry) => `${entry.id} ${entry.label}`)]
			.join(" ")
			.toLowerCase()
			.includes(normalized),
	);
}
