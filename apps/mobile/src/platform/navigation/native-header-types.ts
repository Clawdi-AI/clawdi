export type HeaderAction = {
	id: string;
	label: string;
	accessibilityLabel?: string;
	disabled?: boolean;
	destructive?: boolean;
	/** Single-choice state, shown as the platform menu checkmark. */
	selected?: boolean;
	onPress: () => void;
};
/** Inline menu group, e.g. a filter whose options sit below the menu's own items. */
export type HeaderMenuSection = { id: string; title: string; items: HeaderAction[] };
export type HeaderMenu = { label: string; items?: HeaderAction[]; sections?: HeaderMenuSection[] };
