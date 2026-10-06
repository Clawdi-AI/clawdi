import { Stack } from "expo-router";
import type { NativeStackNavigationOptions } from "expo-router/native-stack";
import { useEffect, useRef } from "react";
import type { SearchBarCommands } from "react-native-screens";
import { useCSSVariable } from "uniwind";
import { HeaderActions } from "@/platform/navigation/header-actions";
import type { HeaderAction, HeaderMenu } from "@/platform/navigation/native-header-types";

export function useNativeStackOptions(): NativeStackNavigationOptions {
	const [background, foreground] = useCSSVariable(["--color-background", "--color-foreground"]);
	const color = (value: string | number | undefined) =>
		typeof value === "string" ? value : undefined;
	return {
		headerStyle: { backgroundColor: color(background) },
		headerTintColor: color(foreground),
		headerTitleStyle: { fontFamily: "Geist-SemiBold", fontSize: 20 },
		headerLargeTitleStyle: { fontFamily: "Geist-SemiBold", color: color(foreground) },
		contentStyle: { backgroundColor: color(background) },
	};
}

/** Page title and Web actions belong to the native stack, never the content column. */
export function NativeHeader({
	title,
	actions,
	menu,
}: {
	title: string;
	actions?: HeaderAction[];
	menu?: HeaderMenu;
}) {
	return (
		<>
			<Stack.Screen options={{ title }} />
			{actions || menu ? <HeaderActions actions={actions} menu={menu} /> : null}
		</>
	);
}

/** Controlled search: native edits update existing state; resets sync back to the search bar. */
export function useHeaderSearch({
	value,
	onChange,
	placeholder,
	maxLength,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	maxLength?: number;
}): NativeStackNavigationOptions["headerSearchBarOptions"] {
	const ref = useRef<SearchBarCommands | null>(null);
	const nativeValue = useRef("");
	const [foreground, muted, background] = useCSSVariable([
		"--color-foreground",
		"--color-muted-foreground",
		"--color-background",
	]);
	const color = (v: string | number | undefined) => (typeof v === "string" ? v : undefined);
	useEffect(() => {
		// Echoing every native keystroke can overwrite newer edits before React commits.
		if (value !== nativeValue.current) {
			nativeValue.current = value;
			ref.current?.setText(value);
		}
	}, [value]);
	return {
		ref,
		placeholder,
		autoCapitalize: "none",
		hideWhenScrolling: false,
		textColor: color(foreground),
		tintColor: color(foreground),
		headerIconColor: color(foreground),
		hintTextColor: color(muted),
		barTintColor: color(background),
		onChangeText: ({ nativeEvent }) => {
			nativeValue.current = nativeEvent.text;
			onChange(maxLength ? nativeEvent.text.slice(0, maxLength) : nativeEvent.text);
		},
		onCancelButtonPress: () => onChange(""),
	};
}
