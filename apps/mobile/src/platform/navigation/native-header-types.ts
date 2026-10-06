export type HeaderAction = {
	id: string;
	label: string;
	accessibilityLabel?: string;
	disabled?: boolean;
	destructive?: boolean;
	onPress: () => void;
};
export type HeaderMenu = { label: string; items: HeaderAction[] };
