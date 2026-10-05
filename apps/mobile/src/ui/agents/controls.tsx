import { Button } from "../button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select";
import { Text } from "../text";
export function ActionButton({
	label,
	onPress,
	disabled,
	variant = "outline",
	className,
}: {
	label: string;
	onPress: () => void;
	disabled?: boolean;
	variant?: "default" | "outline" | "ghost" | "destructive";
	className?: string;
}) {
	return (
		<Button size="sm" variant={variant} onPress={onPress} disabled={disabled} className={className}>
			<Text>{label}</Text>
		</Button>
	);
}
export function ChoiceSelect<Value extends string | number>({
	value,
	options,
	onValueChange,
	disabled,
}: {
	value: Value;
	options: readonly { value: Value; label: string }[];
	onValueChange: (value: Value) => void;
	disabled?: boolean;
}) {
	return (
		<Select
			value={String(value)}
			disabled={disabled}
			onValueChange={(selected) => {
				const option = options.find((item) => String(item.value) === selected);
				if (option) onValueChange(option.value);
			}}
		>
			<SelectTrigger>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((item) => (
					<SelectItem key={String(item.value)} value={String(item.value)} label={item.label}>
						{item.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

import { settingsSectionClasses } from "@clawdi/shared/ui";
import { Switch } from "../switch";
import { WebView } from "../web-layout";
export function NativeSwitch({
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
		<WebView recipe={settingsSectionClasses.header} className="flex-row">
			<Text className="flex-1">{label}</Text>
			<Switch
				accessibilityLabel={label}
				checked={value}
				onCheckedChange={onValueChange}
				disabled={disabled}
			/>
		</WebView>
	);
}
