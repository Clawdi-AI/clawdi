import { switchClasses } from "@clawdi/shared/ui";
import { useState } from "react";
import { Switch as RNSwitch, type SwitchProps } from "react-native";
import { useCSSVariable } from "uniwind";
import { WebView } from "./web-layout";
/** Native thumb/gesture/size; Web's checked/unchecked tokens tint the platform Switch. */
export function Switch({
	checked,
	defaultChecked = false,
	onCheckedChange,
	size = "default",
	className,
	disabled,
	...props
}: Omit<SwitchProps, "value" | "onValueChange"> & {
	checked?: boolean;
	defaultChecked?: boolean;
	onCheckedChange?: (checked: boolean) => void;
	size?: "sm" | "default";
	className?: string;
}) {
	const [internal, setInternal] = useState(defaultChecked);
	const [primary, input, background] = useCSSVariable([
		"--color-primary",
		"--color-input",
		"--color-background",
	]);
	const color = (value: unknown) => (typeof value === "string" ? value : undefined);
	// Geometry stays native; the shared Web recipe still provides disabled opacity.
	const recipe = switchClasses.switch
		.split(/\s+/)
		.filter((token) => token.includes("data-disabled:opacity"))
		.join(" ");
	return (
		<WebView recipe={recipe} state={{ "data-disabled": disabled }} className={className}>
			<RNSwitch
				value={checked ?? internal}
				disabled={disabled}
				onValueChange={(next) => {
					setInternal(next);
					onCheckedChange?.(next);
				}}
				trackColor={{ false: color(input), true: color(primary) }}
				thumbColor={color(background)}
				ios_backgroundColor={color(input)}
				style={size === "sm" ? { transform: [{ scale: 0.8 }] } : undefined}
				{...props}
			/>
		</WebView>
	);
}
