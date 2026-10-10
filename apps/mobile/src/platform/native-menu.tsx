import { type MenuAction, MenuView } from "@expo/ui/community/menu";
import { Children, isValidElement, type ReactElement, type ReactNode, useState } from "react";
import { useCSSVariable, useUniwind } from "uniwind";
import { AppView } from "@/components/ui/view";

export type MenuElementProps = {
	children?: ReactNode;
	value?: string;
	label?: string;
	disabled?: boolean;
	checked?: boolean | "indeterminate";
	onCheckedChange?: (checked: boolean) => void;
	onValueChange?: (value: string) => void;
	onClick?: () => void;
	onSelect?: () => void;
	variant?: "default" | "destructive";
	render?: ReactElement;
	className?: string;
};
export function menuElements(children: ReactNode): ReactElement<MenuElementProps>[] {
	return Children.toArray(children).filter(isValidElement<MenuElementProps>);
}
export function menuLabel(children: ReactNode): string {
	return Children.toArray(children)
		.map((child) =>
			typeof child === "string" || typeof child === "number"
				? String(child)
				: isValidElement<MenuElementProps>(child)
					? menuLabel(child.props.children)
					: "",
		)
		.join("");
}
export function findMenuElement(
	children: ReactNode,
	type: unknown,
): ReactElement<MenuElementProps> | undefined {
	for (const child of menuElements(children)) {
		if (child.type === type) return child;
		const nested = findMenuElement(child.props.children, type);
		if (nested) return nested;
	}
}
export type NativeMenuEntry = {
	action: MenuAction;
	onPress?: () => void;
	children?: NativeMenuEntry[];
};
/** Native inline sections preserve Web separator boundaries without drawing a second popup. */
export function menuSections(
	entries: (NativeMenuEntry | null)[],
	prefix: string,
): NativeMenuEntry[] {
	if (!entries.includes(null)) return entries.filter((entry) => entry !== null);
	const sections: NativeMenuEntry[] = [];
	let children: NativeMenuEntry[] = [];
	const flush = () => {
		if (!children.length) return;
		sections.push({
			action: { id: `${prefix}-${sections.length}`, title: "", displayInline: true },
			children,
		});
		children = [];
	};
	for (const entry of entries) {
		if (entry) children.push(entry);
		else flush();
	}
	flush();
	return sections;
}
function findEntry(entries: NativeMenuEntry[], id: string): NativeMenuEntry | undefined {
	for (const entry of entries) {
		if (entry.action.id === id) return entry;
		const child = findEntry(entry.children ?? [], id);
		if (child) return child;
	}
}
/** SDK 57 MenuView owns system menu geometry; the trigger keeps the shared Web recipe. */
export function NativeMenu({
	entries,
	disabled,
	onOpenChange,
	children,
	fullWidth = false,
}: {
	entries: NativeMenuEntry[];
	disabled?: boolean;
	onOpenChange?: (open: boolean) => void;
	children: ReactNode;
	fullWidth?: boolean;
}) {
	const [width, setWidth] = useState<number>();
	const { theme } = useUniwind();
	const [foreground, destructive] = useCSSVariable([
		"--color-popover-foreground",
		"--color-destructive",
	]);
	const actions = (list: NativeMenuEntry[]): MenuAction[] =>
		list.map((entry) => ({
			...entry.action,
			titleColor:
				typeof (entry.action.attributes?.destructive ? destructive : foreground) === "string"
					? String(entry.action.attributes?.destructive ? destructive : foreground)
					: undefined,
			// A disabled menu also disables every action through MenuView's documented attribute.
			attributes: disabled
				? { ...entry.action.attributes, disabled: true }
				: entry.action.attributes,
			subactions: entry.children ? actions(entry.children) : undefined,
		}));
	const menu = (
		<MenuView
			style={fullWidth && width ? { width } : undefined}
			actions={actions(entries)}
			colorScheme={theme === "dark" ? "dark" : "light"}
			onOpenMenu={() => onOpenChange?.(true)}
			onCloseMenu={() => onOpenChange?.(false)}
			onPressAction={({ nativeEvent }) => {
				const entry = findEntry(entries, nativeEvent.event);
				if (disabled || !entry || entry.action.attributes?.disabled) return;
				entry.onPress?.();
				onOpenChange?.(false);
			}}
		>
			<AppView pointerEvents="none" style={fullWidth && width ? { width } : undefined}>
				{children}
			</AppView>
		</MenuView>
	);
	// Compose's matchContents host needs a concrete width for percentage-width triggers.
	const trigger = fullWidth ? (
		<AppView className="w-full" onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}>
			{menu}
		</AppView>
	) : (
		menu
	);
	// MenuView has no disabled prop. Keep its host so the trigger measures exactly as when
	// enabled, stop touches from reaching it, and disable each action above.
	return disabled ? (
		<AppView
			accessibilityState={{ disabled }}
			pointerEvents="none"
			className={fullWidth ? "w-full" : undefined}
		>
			{trigger}
		</AppView>
	) : (
		trigger
	);
}
