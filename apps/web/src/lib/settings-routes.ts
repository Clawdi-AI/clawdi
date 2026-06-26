export const SETTINGS_QUERY_KEY = "settings";

export const SETTINGS_SECTION_IDS = [
	"general",
	"profile",
	"api-keys",
	"billing-wallet",
	"billing-plan",
	"billing-usage",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "general";

const SETTINGS_SECTION_SET = new Set<string>(SETTINGS_SECTION_IDS);

export function normalizeSettingsSection(
	value: string | null | undefined,
): SettingsSectionId | null {
	if (!value) return null;
	return SETTINGS_SECTION_SET.has(value) ? (value as SettingsSectionId) : null;
}

export function settingsQueryHref(
	section: SettingsSectionId = DEFAULT_SETTINGS_SECTION,
	params?: URLSearchParams | ReadonlyURLSearchParams,
) {
	const next = new URLSearchParams(params?.toString());
	next.set(SETTINGS_QUERY_KEY, section);
	return `?${next.toString()}`;
}

type ReadonlyURLSearchParams = {
	toString: () => string;
};
