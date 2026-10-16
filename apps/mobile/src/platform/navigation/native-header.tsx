import { Stack } from "expo-router";
import type { NativeStackNavigationOptions } from "expo-router/native-stack";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useWindowDimensions } from "react-native";
import type { SearchBarCommands, SearchBarProps } from "react-native-screens";
import { useCSSVariable } from "uniwind";
import { barFontSize } from "@/platform/navigation/bar-font-size";
import { HeaderActions } from "@/platform/navigation/header-actions";
import type { HeaderAction, HeaderMenu } from "@/platform/navigation/native-header-types";

export function useNativeStackOptions(): NativeStackNavigationOptions {
	const [background, foreground] = useCSSVariable(["--color-background", "--color-foreground"]);
	const { fontScale } = useWindowDimensions();
	const color = (value: string | number | undefined) =>
		typeof value === "string" ? value : undefined;
	return {
		headerStyle: { backgroundColor: color(background) },
		headerTintColor: color(foreground),
		headerTitleStyle: { fontFamily: "Geist-SemiBold", fontSize: barFontSize(20, fontScale) },
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

/**
 * Controlled search for `<Stack.SearchBar {...search} />`: native edits update existing state;
 * resets sync back to the search bar. Expo Router removes the bar with its component, so it
 * never outlives the content that owns it. Props stay stable across renders.
 */
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
}): SearchBarProps {
	const ref = useRef<SearchBarCommands | null>(null);
	const nativeValue = useRef("");
	const latest = useRef({ onChange, maxLength });
	useLayoutEffect(() => {
		latest.current = { onChange, maxLength };
	});
	const [foreground, muted, background] = useCSSVariable([
		"--color-foreground",
		"--color-muted-foreground",
		"--color-background",
	]);
	useEffect(() => {
		// Echoing every native keystroke can overwrite newer edits before React commits.
		if (value !== nativeValue.current) {
			nativeValue.current = value;
			ref.current?.setText(value);
		}
	}, [value]);
	return useMemo(() => {
		const color = (v: string | number | undefined) => (typeof v === "string" ? v : undefined);
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
				const { onChange, maxLength } = latest.current;
				onChange(maxLength ? nativeEvent.text.slice(0, maxLength) : nativeEvent.text);
			},
			onCancelButtonPress: () => latest.current.onChange(""),
		};
	}, [placeholder, foreground, muted, background]);
}
