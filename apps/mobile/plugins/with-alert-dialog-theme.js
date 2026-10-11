const {
	AndroidConfig,
	withAndroidColors,
	withAndroidColorsNight,
	withAndroidStyles,
} = require("expo/config-plugins");

const DIALOG_THEME = "Theme.App.AlertDialog";
const COLOR_NAMES = {
	surface: "alertDialogSurface",
	text: "alertDialogText",
	accent: "alertDialogAccent",
};

function assignColors(xml, colors) {
	return Object.entries(COLOR_NAMES).reduce(
		(next, [key, name]) =>
			AndroidConfig.Colors.assignColorValue(next, { name, value: colors[key] }),
		xml,
	);
}

/**
 * React Native's `Alert` builds an AppCompat `AlertDialog` from the activity's
 * `alertDialogTheme`. Point it at a DayNight dialog theme whose surface, text
 * and button colors come from the shared tokens in `values` and `values-night`,
 * so native confirms follow the app theme instead of AppCompat's teal defaults.
 */
module.exports = function withAlertDialogTheme(config, palette) {
	config = withAndroidColors(config, (mod) => {
		mod.modResults = assignColors(mod.modResults, palette.light);
		return mod;
	});
	config = withAndroidColorsNight(config, (mod) => {
		mod.modResults = assignColors(mod.modResults, palette.dark);
		return mod;
	});
	return withAndroidStyles(config, (mod) => {
		const dialog = { name: DIALOG_THEME, parent: "Theme.AppCompat.DayNight.Dialog.Alert" };
		let xml = mod.modResults;
		for (const [name, value] of [
			["colorAccent", `@color/${COLOR_NAMES.accent}`],
			["colorBackgroundFloating", `@color/${COLOR_NAMES.surface}`],
			["android:textColorPrimary", `@color/${COLOR_NAMES.text}`],
		])
			xml = AndroidConfig.Styles.assignStylesValue(xml, { add: true, name, value, parent: dialog });
		mod.modResults = AndroidConfig.Styles.assignStylesValue(xml, {
			add: true,
			name: "alertDialogTheme",
			value: `@style/${DIALOG_THEME}`,
			parent: AndroidConfig.Styles.getAppThemeGroup(),
		});
		return mod;
	});
};
