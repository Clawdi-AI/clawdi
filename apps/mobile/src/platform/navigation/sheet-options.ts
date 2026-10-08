import type { NativeStackNavigationOptions } from "expo-router/native-stack";
import { Platform } from "react-native";

/**
 * Configure in the parent layout before opening; presentation is not a dynamic page option.
 * Android form sheets do not support the nested header stack these screens render, so Android
 * uses a modal: https://docs.expo.dev/router/advanced/modals/#android-limitations
 */
export const sheetPresentationOptions = (
	Platform.OS === "android"
		? { presentation: "modal" }
		: { presentation: "formSheet", sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true }
) satisfies NativeStackNavigationOptions;

/**
 * A sheet's first screen inherits the root stack's back arrow, which Android shows next to the
 * header Cancel. Screens with that Cancel keep only Cancel, as on iOS.
 */
export const sheetCancelHeaderOptions = (
	Platform.OS === "android" ? { headerBackVisible: false } : {}
) satisfies NativeStackNavigationOptions;
