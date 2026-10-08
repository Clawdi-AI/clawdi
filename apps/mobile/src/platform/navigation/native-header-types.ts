import type { Stack } from "expo-router";
import type { ComponentProps } from "react";
import type { ImageSourcePropType } from "react-native";

type ToolbarIcon = NonNullable<ComponentProps<typeof Stack.Toolbar.Button>["icon"]>;

export type HeaderAction = {
	id: string;
	label: string;
	accessibilityLabel?: string;
	disabled?: boolean;
	/** Secondary menu text, e.g. why an item is unavailable (iOS menus only). */
	subtitle?: string;
	destructive?: boolean;
	/** Single-choice state, shown as the platform menu checkmark. */
	selected?: boolean;
	/** Icon-only button: an SF Symbol on iOS and a vector drawable on Android; `label` stays its name. */
	icon?: { ios: ToolbarIcon; android: ImageSourcePropType };
	/** Platform badge over the icon, e.g. an unread count. */
	badge?: string | null;
	onPress: () => void;
};
/** Inline menu group, e.g. a filter whose options sit below the menu's own items. */
export type HeaderMenuSection = { id: string; title: string; items: HeaderAction[] };
export type HeaderMenu = { label: string; items?: HeaderAction[]; sections?: HeaderMenuSection[] };
