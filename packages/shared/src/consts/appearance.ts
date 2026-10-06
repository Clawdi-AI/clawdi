export const APPEARANCE_MODES = ["light", "dark", "system"] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

export function isAppearanceMode(value: unknown): value is AppearanceMode {
	return value === "light" || value === "dark" || value === "system";
}
