import {
	formLayoutClasses,
	generalPanelClasses,
	settingsPanelHeaderClasses,
} from "@clawdi/shared/ui";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webBoth } from "@/components/ui/web-layout";

/** Native rendering of Clerk's shadcn theme: shared tokens and form primitives. */
export function ClerkText({ accessibilityRole, className, ...props }: ComponentProps<typeof Text>) {
	return (
		<WebText
			recipe={
				accessibilityRole === "header"
					? settingsPanelHeaderClasses.title
					: settingsPanelHeaderClasses.description
			}
			accessibilityRole={accessibilityRole}
			className={className}
			{...props}
		/>
	);
}
export function ClerkInput({
	accessibilityLabel,
	placeholder,
	...props
}: ComponentProps<typeof Input>) {
	return (
		<WebView recipe={formLayoutClasses.field}>
			<Label>{accessibilityLabel ?? placeholder}</Label>
			<Input accessibilityLabel={accessibilityLabel} placeholder={placeholder} {...props} />
		</WebView>
	);
}
export function ClerkAction({
	label,
	onPress,
	disabled,
	variant = "outline",
}: {
	label: string;
	onPress: () => void;
	disabled?: boolean;
	variant?: ComponentProps<typeof Button>["variant"];
}) {
	return (
		<Button variant={variant} disabled={disabled} onPress={onPress}>
			<Text>{label}</Text>
		</Button>
	);
}
export function ClerkSwitch({
	label,
	value,
	onValueChange,
	disabled,
}: {
	label: string;
	value: boolean;
	onValueChange: (value: boolean) => void;
	disabled?: boolean;
}) {
	return (
		<WebView recipe={generalPanelClasses.identity} className="flex-row">
			<Switch checked={value} onCheckedChange={onValueChange} disabled={disabled} />
			<Text className={`${webBoth(formLayoutClasses.checkLabel)} flex-1 min-w-0`}>{label}</Text>
		</WebView>
	);
}
