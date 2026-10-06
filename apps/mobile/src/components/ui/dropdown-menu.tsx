import type { ReactElement, ReactNode } from "react";
import {
	findMenuElement,
	type MenuElementProps,
	menuElements,
	menuLabel,
	menuSections,
	NativeMenu,
	type NativeMenuEntry,
} from "@/platform/native-menu";
import { WebView } from "@/components/ui/web-layout";

type SlotProps = { children?: ReactNode; className?: string; inset?: boolean };
/** Compound Web API → SDK native menu descriptors. No keyboard shortcuts or popup positioning.
 * onOpenChange is available on Android; iOS only reports selection (system menu limitation).
 * Use direct menu items/groups/fragments, rather than custom descriptor wrappers. */
export function DropdownMenu({
	children,
	onOpenChange,
}: {
	children: ReactNode;
	onOpenChange?: (open: boolean) => void;
}) {
	let sequence = 0;
	const collect = (nodes: ReactNode, radio?: MenuElementProps): NativeMenuEntry[] => {
		const prefix = `section-${sequence++}`;
		return menuSections(
			menuElements(nodes).flatMap<NativeMenuEntry | null>((node) => {
				const p = node.props,
					id = `item-${sequence++}`;
				if (
					node.type === DropdownMenuItem ||
					node.type === DropdownMenuCheckboxItem ||
					node.type === DropdownMenuRadioItem
				) {
					const checked =
						node.type === DropdownMenuCheckboxItem
							? p.checked === true
							: node.type === DropdownMenuRadioItem && p.value === radio?.value;
					return [
						{
							action: {
								id,
								title: p.label ?? menuLabel(p.children),
								state: checked ? "on" : "off",
								attributes: { disabled: p.disabled, destructive: p.variant === "destructive" },
							},
							onPress: () => {
								if (node.type === DropdownMenuCheckboxItem) p.onCheckedChange?.(!checked);
								if (node.type === DropdownMenuRadioItem && p.value) radio?.onValueChange?.(p.value);
								p.onSelect?.();
								p.onClick?.();
							},
						},
					];
				}
				if (node.type === DropdownMenuSub) {
					const trigger = findMenuElement(p.children, DropdownMenuSubTrigger);
					return [
						{
							action: {
								id,
								title: trigger?.props.label ?? menuLabel(trigger?.props.children),
								attributes: { disabled: trigger?.props.disabled },
							},
							children: collect(p.children),
						},
					];
				}
				if (
					node.type === DropdownMenuTrigger ||
					node.type === DropdownMenuSubTrigger ||
					node.type === DropdownMenuShortcut
				)
					return [];
				if (node.type === DropdownMenuSeparator) return [null];
				if (node.type === DropdownMenuLabel) return [];
				if (node.type === DropdownMenuGroup) {
					const label = findMenuElement(p.children, DropdownMenuLabel);
					return [
						{
							action: { id, title: menuLabel(label?.props.children), displayInline: true },
							children: collect(p.children, radio),
						},
					];
				}
				return collect(p.children, node.type === DropdownMenuRadioGroup ? p : radio);
			}),
			prefix,
		);
	};
	const trigger = findMenuElement(children, DropdownMenuTrigger);
	return (
		<NativeMenu
			entries={collect(children)}
			disabled={trigger?.props.disabled}
			onOpenChange={onOpenChange}
		>
			{trigger}
		</NativeMenu>
	);
}
export function DropdownMenuTrigger({
	children,
	render,
	disabled,
	className,
}: SlotProps & { render?: ReactElement; disabled?: boolean }) {
	return (
		<WebView recipe={className ?? ""} accessibilityRole="button" accessibilityState={{ disabled }}>
			{render ?? children}
		</WebView>
	);
}
export function DropdownMenuContent(
	_props: SlotProps & { side?: string; align?: string; sideOffset?: number; alignOffset?: number },
) {
	return null;
}
export function DropdownMenuItem(
	_props: SlotProps & {
		label?: string;
		disabled?: boolean;
		variant?: "default" | "destructive";
		onClick?: () => void;
		onSelect?: () => void;
	},
) {
	return null;
}
export function DropdownMenuCheckboxItem(
	_props: SlotProps & {
		checked?: boolean | "indeterminate";
		onCheckedChange?: (checked: boolean) => void;
		disabled?: boolean;
		label?: string;
	},
) {
	return null;
}
export function DropdownMenuRadioGroup(
	_props: SlotProps & { value?: string; onValueChange?: (value: string) => void },
) {
	return null;
}
export function DropdownMenuRadioItem(
	_props: SlotProps & { value: string; disabled?: boolean; label?: string },
) {
	return null;
}
export function DropdownMenuGroup(_props: SlotProps) {
	return null;
}
export function DropdownMenuLabel(_props: SlotProps) {
	return null;
}
export function DropdownMenuSeparator(_props: SlotProps) {
	return null;
}
export function DropdownMenuPortal(_props: SlotProps) {
	return null;
}
export function DropdownMenuSub(_props: SlotProps) {
	return null;
}
export function DropdownMenuSubTrigger(_props: SlotProps & { label?: string; disabled?: boolean }) {
	return null;
}
export function DropdownMenuSubContent(_props: SlotProps) {
	return null;
}
/** Keyboard-only Web shortcut is omitted on native. */
export function DropdownMenuShortcut(_props: SlotProps) {
	return null;
}
