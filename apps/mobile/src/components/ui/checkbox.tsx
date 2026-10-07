import { Host, Checkbox as NativeCheckbox } from "@expo/ui";
import { accessibilityLabel as labelModifier, labelsHidden } from "@expo/ui/swift-ui/modifiers";
import { useCSSVariable, useUniwind } from "uniwind";
import { AppView } from "@/components/ui/view";

export type CheckboxProps = {
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
	/** Names the control; the visible caption beside it toggles it, like Web's `<label>`. */
	accessibilityLabel: string;
	className?: string;
};
/** `@expo/ui` universal Checkbox, which iOS renders as a SwiftUI Toggle; Web's primary token is the tint. */
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
			>
				<NativeCheckbox
					value={checked}
					onValueChange={onCheckedChange}
					disabled={disabled}
					modifiers={[labelModifier(accessibilityLabel), labelsHidden()]}
				/>
			</Host>
		</AppView>
	);
}
