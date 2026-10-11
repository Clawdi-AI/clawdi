import { Platform } from "react-native";

/**
 * The largest font scale at which Android bar chrome (five tab labels, a stack title with its
 * actions) still fits a phone-width bar without truncating.
 */
const BAR_MAX_FONT_SCALE = 1.3;

/**
 * Android sizes bar labels in sp and never wraps them. Like iOS bars, which do not grow with
 * Dynamic Type, bar chrome stops scaling at `BAR_MAX_FONT_SCALE`; page content keeps full scaling.
 */
export function barFontSize(size: number, fontScale: number): number {
	return Platform.OS === "android" && fontScale > BAR_MAX_FONT_SCALE
		? (size * BAR_MAX_FONT_SCALE) / fontScale
		: size;
}
