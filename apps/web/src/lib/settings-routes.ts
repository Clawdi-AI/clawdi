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

export type DashboardSettingsSearch = Record<string, unknown> & {
	settings?: SettingsSectionId;
};

const SETTINGS_SECTION_SET = new Set<string>(SETTINGS_SECTION_IDS);

export function normalizeSettingsSection(
	value: string | null | undefined,
): SettingsSectionId | null {
	if (!value) return null;
	return SETTINGS_SECTION_SET.has(value) ? (value as SettingsSectionId) : null;
}

export function validateDashboardSettingsSearch(
	search: Record<string, unknown>,
): DashboardSettingsSearch {
	const validated = { ...search };
	const section = normalizeSettingsSection(
		typeof validated.settings === "string" ? validated.settings : null,
	);
	if (section) validated.settings = section;
	else delete validated.settings;
	return validated;
}

export function settingsDraftOwnerChanges(
	current: { pathname: string; search: Record<string, unknown> },
	next: { pathname: string; search: Record<string, unknown> },
): boolean {
	const currentSection = normalizeSettingsSection(
		typeof current.search.settings === "string" ? current.search.settings : null,
	);
	const nextSection = normalizeSettingsSection(
		typeof next.search.settings === "string" ? next.search.settings : null,
	);
	return current.pathname !== next.pathname || currentSection !== nextSection;
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
