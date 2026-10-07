import { Checkbox as NativeCheckbox, Host } from "@expo/ui/jetpack-compose";
import { useCSSVariable, useUniwind } from "uniwind";
import type { CheckboxProps } from "@/components/ui/checkbox";
import { AppView } from "@/components/ui/view";

/** Material 3 checkbox. The universal adapter only seeds a palette; Compose accepts Web's tokens. */
export function Checkbox({
	checked,
	disabled,
	onCheckedChange,
	accessibilityLabel,
	className,
}: CheckboxProps) {
	const { theme } = useUniwind();
	const [primary, primaryForeground, input] = useCSSVariable([
		"--color-primary",
		"--color-primary-foreground",
		"--color-input",
	]);
	const color = (v: string | number | undefined) => (typeof v === "string" ? v : undefined);
	return (
		<AppView
			className={className}
			accessible={accessibilityLabel !== undefined}
			accessibilityLabel={accessibilityLabel}
			accessibilityRole="checkbox"
			accessibilityState={{ checked, disabled }}
		>
			<Host matchContents colorScheme={theme === "dark" ? "dark" : "light"}>
				<NativeCheckbox
					value={checked}
					enabled={!disabled}
					onCheckedChange={onCheckedChange}
					colors={{
						checkedColor: color(primary),
						checkmarkColor: color(primaryForeground),
						uncheckedColor: color(input),
					}}
				/>
			</Host>
		</AppView>
	);
}
