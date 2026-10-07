import { Host, Checkbox as NativeCheckbox } from "@expo/ui";
import { useCSSVariable, useUniwind } from "uniwind";
import { AppView } from "@/components/ui/view";

export type CheckboxProps = {
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
	accessibilityLabel?: string;
	className?: string;
};
/** `@expo/ui` universal Checkbox (a SwiftUI toggle on iOS); Web's primary token is the tint.
 * Labels stay with the caller's Web copy. */
export function Checkbox({
	checked,
	disabled,
	onCheckedChange,
	accessibilityLabel,
	className,
}: CheckboxProps) {
	const { theme } = useUniwind();
	const primary = useCSSVariable("--color-primary");
	return (
		<AppView className={className}>
			<Host
				matchContents
				colorScheme={theme === "dark" ? "dark" : "light"}
				seedColor={typeof primary === "string" ? primary : undefined}
				accessibilityLabel={accessibilityLabel}
			>
				<NativeCheckbox value={checked} onValueChange={onCheckedChange} disabled={disabled} />
			</Host>
		</AppView>
	);
}
