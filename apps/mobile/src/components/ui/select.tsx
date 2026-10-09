import { selectClasses as styles } from "@clawdi/shared/ui";
import { cn } from "cn";
import { ChevronDown } from "lucide-react-native";
import { createContext, type ReactNode, useContext, useState } from "react";
import {
	findMenuElement,
	menuElements,
	menuLabel,
	menuSections,
	NativeMenu,
	type NativeMenuEntry,
} from "@/platform/native-menu";
import { WebContent, WebIcon, WebView, webText, webView } from "@/components/ui/web-layout";

const SelectContext = createContext({ value: "", label: "", disabled: false });
type SlotProps = { children?: ReactNode; className?: string };
/** Web compound API → native system menu. Content/items are declarative menu descriptors.
 * Keep Items inside Content/Group/Fragments; custom component wrappers aren't evaluated.
 * Popup positioning/scroll arrows are owned by the OS. */
export function Select({
	value,
	defaultValue = "",
	onValueChange,
	disabled = false,
	onOpenChange,
	children,
}: {
	value?: string | null;
	defaultValue?: string;
	onValueChange?: (value: string) => void;
	disabled?: boolean;
	onOpenChange?: (open: boolean) => void;
	children: ReactNode;
}) {
	const [internal, setInternal] = useState(defaultValue),
		selected = value ?? internal;
	const labels = new Map<string, string>();
	let sequence = 0;
	const collect = (nodes: ReactNode): NativeMenuEntry[] => {
		const prefix = `select-section-${sequence++}`;
		const entries: (NativeMenuEntry | null)[] = [];
		for (const node of menuElements(nodes)) {
			if (node.type === SelectItem) {
				const item = node.props;
				if (typeof item.value !== "string") continue;
				const next = item.value;
				const label = item.label ?? menuLabel(item.children);
				labels.set(next, label);
				entries.push({
					action: {
						id: next,
						title: label,
						state: next === selected ? "on" : "off",
						attributes: { disabled: item.disabled },
					},
					onPress: () => {
						setInternal(next);
						onValueChange?.(next);
					},
				});
			} else if (node.type === SelectSeparator) entries.push(null);
			else if (node.type === SelectSub)
				entries.push({
					action: { id: `select-sub-${sequence++}`, title: node.props.label ?? "" },
					children: collect(node.props.children),
				});
			else if (node.type === SelectGroup) {
				const label = findMenuElement(node.props.children, SelectLabel);
				entries.push({
					action: {
						id: `select-group-${sequence++}`,
						title: menuLabel(label?.props.children),
						displayInline: true,
					},
					children: collect(node.props.children),
				});
			} else if (node.type !== SelectTrigger && node.type !== SelectLabel)
				entries.push(...collect(node.props.children));
		}
		return menuSections(entries, prefix);
	};
	const entries = collect(children);
	const label = labels.get(selected) ?? "";
	const trigger = findMenuElement(children, SelectTrigger);
	const menuDisabled = disabled || trigger?.props.disabled === true;
	return (
		<SelectContext.Provider value={{ value: selected, label, disabled: menuDisabled }}>
			<NativeMenu
				entries={entries}
				disabled={menuDisabled}
				onOpenChange={onOpenChange}
				fullWidth={webView(trigger?.props.className ?? "")
					.split(" ")
					.includes("w-full")}
			>
				{trigger}
			</NativeMenu>
		</SelectContext.Provider>
	);
}
export function SelectTrigger({
	size = "default",
	className,
	children,
	disabled,
}: SlotProps & { size?: "sm" | "default"; disabled?: boolean }) {
	const select = useContext(SelectContext);
	return (
		<WebView
			recipe={styles.trigger.replace(/\bdisabled:/g, "data-disabled:")}
			state={{
				"data-[size=default]": size === "default",
				"data-[size=sm]": size === "sm",
				"data-placeholder": !select.value,
				"data-disabled": disabled || select.disabled,
			}}
			accessibilityRole="button"
			accessibilityState={{ disabled: disabled || select.disabled }}
			className={className}
			style={{ paddingVertical: 0 }}
		>
			{children}
			<WebIcon as={ChevronDown} recipe={styles.triggerIcon} />
		</WebView>
	);
}
export function SelectValue({
	placeholder,
	children,
	className,
}: SlotProps & { placeholder?: string }) {
	const { label } = useContext(SelectContext);
	return (
		<WebView recipe={cn(styles.value, className)}>
			<WebContent recipe={webText(styles.trigger)}>{children ?? (label || placeholder)}</WebContent>
		</WebView>
	);
}
export function SelectContent(
	_props: SlotProps & {
		side?: string;
		align?: string;
		sideOffset?: number;
		alignOffset?: number;
		alignItemWithTrigger?: boolean;
	},
) {
	return null;
}
export function SelectGroup(_props: SlotProps) {
	return null;
}
export function SelectItem(
	_props: SlotProps & { value: string; label?: string; disabled?: boolean },
) {
	return null;
}
/** Mobile-only nested submenu for long option sets (e.g. timezones grouped by region). */
export function SelectSub(_props: SlotProps & { label: string }) {
	return null;
}
export function SelectLabel(_props: SlotProps) {
	return null;
}
export function SelectSeparator(_props: SlotProps) {
	return null;
}
function SelectScrollUpButton(_props: SlotProps) {
	return null;
}
function SelectScrollDownButton(_props: SlotProps) {
	return null;
}
