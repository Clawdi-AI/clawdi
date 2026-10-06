import type { NativeStackNavigationOptions } from "expo-router/native-stack";

/** Configure in the parent layout before opening; presentation is not a dynamic page option. */
export const formSheetOptions = {
	presentation: "formSheet",
	sheetAllowedDetents: [0.6, 1],
	sheetGrabberVisible: true,
} satisfies NativeStackNavigationOptions;
